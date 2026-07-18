import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { MediaType } from '@tvwatch/shared';
import type { MediaCardLiteDto } from '@tvwatch/shared';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { currentLanguage } from '../common/language.context';
import { RedisService } from '../common/redis/redis.service';
import { mapMediaCardLite, mapMovie, mapShow } from '../common/utils/mapper.util';
import { MediaMetadataService } from './media-metadata.service';
import { TmdbProvider } from './providers/tmdb.provider';
import { TvdbProvider } from './providers/tvdb.provider';
import { HydrationQueue } from './hydration/hydration.queue';
import { DiscoverQueryDto, SearchQueryDto } from './dto/discover.dto';
import { paginate } from '../common/dto/pagination.dto';

interface SearchCacheEntry {
  /** Merged ordered media ids (local DB first, then TMDb pages). */
  ids: string[];
  tmdbPagesFetched: number;
  /** True once every enabled source returned a short/empty page. */
  exhausted: boolean;
}

@Injectable()
export class DiscoveryService {
  private readonly logger = new Logger(DiscoveryService.name);

  constructor(
    private readonly tmdb: TmdbProvider,
    private readonly tvdb: TvdbProvider,
    private readonly meta: MediaMetadataService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly hydration: HydrationQueue,
  ) {}

  private requireTmdb() {
    if (!this.tmdb.enabled) throw new ServiceUnavailableException('Live metadata not configured');
  }

  async search(q: SearchQueryDto, userId?: string) {
    const term = q.q?.trim();
    if (!term) return paginate([], q.page, q.pageSize, 0);
    if (this.tmdb.enabled || this.tvdb?.enabled) {
      return this.searchViaProviders(term, q, userId);
    }
    return this.searchViaDb(term, q, userId);
  }

  /**
   * Search result window cached per (type, term, lang): the merged ordering (local DB
   * first, then TMDb pages) lives in `ids`, and later pages expand the window on
   * demand — so paging returns real ordered results instead of re-fetching arbitrary
   * TMDb pages (the old key included the page, so page 2+ restarted mid-list).
   */
  private async searchViaProviders(term: string, q: SearchQueryDto, userId?: string) {
    const lang = currentLanguage();
    const want = Math.max(1, Math.min(q.pageSize ?? 20, 50));
    const page = Math.max(1, q.page ?? 1);
    const cacheKey = `search:v4:${q.type ?? 'all'}:${term}:${lang}`;

    let entry = await this.redis.get<SearchCacheEntry>(cacheKey);
    if (!entry) {
      entry = await this.initialSearch(term, q);
      await this.redis.set(cacheKey, entry, 120);
    }
    // Expand the window until the requested page is covered or sources are exhausted
    // (bounded per request so a deep page jump can't hammer TMDb).
    let rounds = 0;
    while (entry.ids.length < page * want && !entry.exhausted && rounds < 3) {
      entry = await this.fetchNextTmdbPage(term, q, entry);
      rounds++;
      await this.redis.set(cacheKey, entry, 120);
    }

    const start = (page - 1) * want;
    const slice = entry.ids.slice(start, start + want);
    const items = await this.fetchListDtos(slice, userId, want);
    // hasMore via paginate's formula: +1 while more pages may exist upstream.
    const total = entry.ids.length + (entry.exhausted ? 0 : 1);
    return paginate(items, page, want, total);
  }

  /** First search round: local DB (exact then contains) + TMDb page 1 + fallbacks. */
  private async initialSearch(term: string, q: SearchQueryDto): Promise<SearchCacheEntry> {
    const lang = currentLanguage();
    const wantShows = !q.type || q.type === MediaType.SHOW;
    const wantMovies = !q.type || q.type === MediaType.MOVIE;

    // LOCAL DB search (fast, finds TVDB-only content that already exists).
    const dbWhere = {
      ...(wantShows && !wantMovies ? { type: MediaType.SHOW } : {}),
      ...(wantMovies && !wantShows ? { type: MediaType.MOVIE } : {}),
    };
    const exactRows = await this.prisma.mediaItem.findMany({
      where: { ...dbWhere, title: { equals: term, mode: 'insensitive' as const } },
      take: 50, orderBy: { popularity: 'desc' }, select: { id: true },
    });
    const exactIds = exactRows.map((r) => r.id);
    const containsRows = await this.prisma.mediaItem.findMany({
      where: { ...dbWhere, title: { contains: term, mode: 'insensitive' as const }, id: { notIn: exactIds } },
      take: 100, orderBy: { popularity: 'desc' }, select: { id: true },
    });
    const localIds = [...exactIds, ...containsRows.map((r) => r.id)];

    let entry: SearchCacheEntry = { ids: localIds, tmdbPagesFetched: 0, exhausted: false };
    entry = await this.fetchNextTmdbPage(term, q, entry);

    // If NO results from local + TMDB, fall back to TVDB API (synchronous).
    if (entry.ids.length === 0 && this.tvdb?.enabled) {
      if (wantShows) {
        try {
          const r = await this.tvdb.searchShows(term, 1);
          entry.ids.push(...await Promise.all(
            r.items.filter((i) => i.tvdbId).map((i) => this.meta.lightUpsertShowTvdb(
              { tvdbId: i.tvdbId!, title: i.title, overview: i.overview, posterUrl: i.posterUrl, backdropUrl: null, popularity: 0, year: i.year ?? null },
            )),
          ));
        } catch (e) { this.logger.warn(`TVDB show fallback failed: ${(e as Error).message}`); }
      }
      if (wantMovies && entry.ids.length === 0) {
        try {
          const r = await this.tvdb.searchMovies(term, 1);
          entry.ids.push(...await Promise.all(
            r.items.filter((i) => i.tvdbId).map((i) => this.meta.lightUpsertMovieTvdb(
              { tvdbId: i.tvdbId!, title: i.title, overview: i.overview, posterUrl: i.posterUrl, backdropUrl: null, popularity: 0, year: i.year ?? null },
            )),
          ));
        } catch (e) { this.logger.warn(`TVDB movie fallback failed: ${(e as Error).message}`); }
      }
      entry.exhausted = true;
    }

    entry.ids = [...new Set(entry.ids)];

    // Enqueue background enrichment.
    if (wantShows && this.tvdb?.enabled) this.hydration.enqueueTvdbSearch(term, 'SHOW', lang).catch(() => undefined);
    if (wantMovies && this.tvdb?.enabled) this.hydration.enqueueTvdbSearch(term, 'MOVIE', lang).catch(() => undefined);
    for (const id of entry.ids) this.hydration.enqueueClassifyCandidate({ mediaId: id }).catch(() => undefined);

    return entry;
  }

  /** Append the next TMDb page (per requested type) to the cached window. */
  private async fetchNextTmdbPage(term: string, q: SearchQueryDto, entry: SearchCacheEntry): Promise<SearchCacheEntry> {
    if (entry.exhausted) return entry;
    if (!this.tmdb.enabled) return { ...entry, exhausted: true };
    const wantShows = !q.type || q.type === MediaType.SHOW;
    const wantMovies = !q.type || q.type === MediaType.MOVIE;
    const nextPage = entry.tmdbPagesFetched + 1;

    const tasks: Promise<{ kind: 'show' | 'movie'; items: any[] }>[] = [];
    if (wantShows) tasks.push(this.tmdb.searchShows(term, nextPage).then((r) => ({ kind: 'show' as const, items: r.items })));
    if (wantMovies) tasks.push(this.tmdb.searchMovies(term, nextPage).then((r) => ({ kind: 'movie' as const, items: r.items })));
    const results = await Promise.all(tasks);

    let allShort = results.length > 0;
    for (const { kind, items } of results) {
      if (!items.length) continue;
      const upserted = await Promise.all(
        items.map((i) => (kind === 'show' ? this.meta.lightUpsertShow(i) : this.meta.lightUpsertMovie(i))),
      );
      entry.ids.push(...upserted);
      if (items.length >= 20) allShort = false; // a full page means there may be more
    }
    return {
      ids: [...new Set(entry.ids)],
      tmdbPagesFetched: nextPage,
      exhausted: allShort,
    };
  }

  private async searchViaDb(term: string, q: SearchQueryDto, userId?: string) {
    const where = {
      title: { contains: term, mode: 'insensitive' as const },
      ...(q.type ? { type: q.type } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.mediaItem.findMany({
        where,
        skip: ((q.page || 1) - 1) * (q.pageSize || 20),
        take: q.pageSize,
        orderBy: { popularity: 'desc' },
      }),
      this.prisma.mediaItem.count({ where }),
    ]);
    const ids = rows.map((r) => r.id);
    const items = await this.fetchListDtos(ids, userId);
    return paginate(items, q.page, q.pageSize, total);
  }

  async discoverShows(q: DiscoverQueryDto, userId?: string) {
    if (!this.tmdb.enabled) return this.discoverViaDb(MediaType.SHOW, q, userId);
    const res = await this.tmdb.discoverShows({
      genre: q.genre ? Number(q.genre) : undefined,
      year: q.yearFrom,
      sort: q.sort,
      page: q.page,
    });
    const ids = await Promise.all(res.items.map((i) => this.meta.lightUpsertShow(i)));
    const items = await this.fetchListDtos(ids, userId);
    return paginate(items, q.page, q.pageSize, res.total);
  }

  async discoverMovies(q: DiscoverQueryDto, userId?: string) {
    if (!this.tmdb.enabled) return this.discoverViaDb(MediaType.MOVIE, q, userId);
    const res = await this.tmdb.discoverMovies({
      genre: q.genre ? Number(q.genre) : undefined,
      year: q.yearFrom,
      sort: q.sort,
      page: q.page,
    });
    const ids = await Promise.all(res.items.map((i) => this.meta.lightUpsertMovie(i)));
    const items = await this.fetchListDtos(ids, userId);
    return paginate(items, q.page, q.pageSize, res.total);
  }

  /**
   * Trending ids with a short cache: resolving a page costs a TMDb call plus one
   * lightUpsert per item (each = 1 externalId read + a mediaItem write), so an
   * uncached Discover open did ~80 queries, half of them writes. Ids are
   * user-agnostic; user-specific flags are applied by fetchListDtos afterwards.
   */
  private async cachedTrendingIds(kind: 'show' | 'movie', page: number): Promise<string[]> {
    const key = `trending:ids:${kind}:${currentLanguage()}:${page}`;
    const cached = await this.redis.get<string[]>(key);
    if (cached?.length) return cached;
    const items = kind === 'show'
      ? await this.tmdb.trendingShows('week', page)
      : await this.tmdb.trendingMovies('week', page);
    const ids = await Promise.all(
      items.map((i) => (kind === 'show' ? this.meta.lightUpsertShow(i) : this.meta.lightUpsertMovie(i))),
    );
    if (ids.length) await this.redis.set(key, ids, 300);
    return ids;
  }

  async trendingShows(userId?: string, page = 1, pageSize = 20) {
    if (!this.tmdb.enabled) return { items: await this.topDb(MediaType.SHOW, pageSize, userId), page, hasMore: false };
    const ids = await this.cachedTrendingIds('show', page);
    const listItems = await this.fetchListDtos(ids, userId, pageSize);
    return { items: listItems, page, hasMore: ids.length === 20 };
  }

  async trendingMovies(userId?: string, page = 1, pageSize = 20) {
    if (!this.tmdb.enabled) return { items: await this.topDb(MediaType.MOVIE, pageSize, userId), page, hasMore: false };
    const ids = await this.cachedTrendingIds('movie', page);
    const listItems = await this.fetchListDtos(ids, userId, pageSize);
    return { items: listItems, page, hasMore: ids.length === 20 };
  }

  async discoverSections(userId?: string) {
    const [trendingShows, trendingMovies] = await Promise.all([
      this.tmdb.enabled
        ? this.trendingShows(userId, 1, 20)
        : { items: await this.topDb(MediaType.SHOW, 20, userId), page: 1, hasMore: false },
      this.tmdb.enabled
        ? this.trendingMovies(userId, 1, 20)
        : { items: await this.topDb(MediaType.MOVIE, 20, userId), page: 1, hasMore: false },
    ]);
    const topForYou = userId ? await this.recommendedForYou(userId) : trendingShows.items.slice(0, 10);
    return { topForYou, trendingShows: trendingShows.items, trendingMovies: trendingMovies.items };
  }

  private async recommendedForYou(userId: string) {
    // Score genres: watch history counts double, favorites +1 each.
    // Aggregates in SQL — the old findMany pulled every mediaGenre row for the
    // user's entire history/favorites (thousands of rows) on every Discover open.
    // EXISTS keeps the old semantics: each mediaGenre row counts once per media,
    // regardless of how many history rows that media has.
    const [histGenres, favGenres] = await Promise.all([
      this.prisma.$queryRaw<{ name: string; c: number }[]>`
        SELECT g.name, COUNT(*)::int AS c
        FROM media_genres mg
        JOIN genres g ON g.id = mg.genre_id
        WHERE EXISTS (SELECT 1 FROM watch_history wh WHERE wh.media_id = mg.media_id AND wh.user_id = ${userId})
        GROUP BY g.name
      `,
      this.prisma.$queryRaw<{ name: string; c: number }[]>`
        SELECT g.name, COUNT(*)::int AS c
        FROM media_genres mg
        JOIN genres g ON g.id = mg.genre_id
        WHERE EXISTS (SELECT 1 FROM favorites f WHERE f.media_id = mg.media_id AND f.user_id = ${userId})
        GROUP BY g.name
      `,
    ]);
    const scores = new Map<string, number>();
    for (const r of histGenres) scores.set(r.name, (scores.get(r.name) ?? 0) + 2 * r.c);
    for (const r of favGenres) scores.set(r.name, (scores.get(r.name) ?? 0) + r.c);
    const genreNames = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name]) => name);
    if (genreNames.length === 0) return [];
    const watchedIds = (
      await this.prisma.watchHistory.findMany({
        where: { userId },
        select: { mediaId: true },
        distinct: ['mediaId'],
      })
    ).map((w) => w.mediaId);
    const rows = await this.prisma.mediaItem.findMany({
      where: {
        type: MediaType.SHOW,
        genres: { some: { genre: { name: { in: genreNames } } } },
        id: { notIn: watchedIds },
      },
      orderBy: { popularity: 'desc' },
      take: 10,
    });
    return this.fetchListDtos(rows.map((r) => r.id), userId);
  }

  private async discoverViaDb(type: MediaType, q: DiscoverQueryDto, userId?: string) {
    return this.topDb(type, q.pageSize || 20, userId, q);
  }

  private async topDb(type: MediaType, limit: number, userId?: string, q?: DiscoverQueryDto) {
    const where = {
      type,
      ...(q?.genre ? { genres: { some: { genre: { name: q.genre } } } } : {}),
      ...(q?.minRating ? { rating: { gte: q.minRating } } : {}),
    };
    const rows = await this.prisma.mediaItem.findMany({
      where,
      orderBy: { popularity: 'desc' },
      take: limit,
    });
    return this.fetchListDtos(rows.map((r) => r.id), userId);
  }

  /**
   * Lightweight cards for LARGE user lists (watchlist/favorites, up to 500 per page).
   * Same localization + aired-progress semantics as fetchListDtos, but skips the
   * cast/genres/provider/externalId includes and full DTO mapping — those turned
   * pageSize=500 watchlist responses into multi-second, multi-MB payloads for rows
   * that only ever render poster + title + progress.
   */
  async fetchCardDtos(ids: string[], userId?: string, limit = 20): Promise<MediaCardLiteDto[]> {
    if (ids.length === 0) return [];
    const limitedIds = ids.slice(0, limit);
    // Populate the request-locale override for items missing it (same as fetchListDtos).
    await this.meta.ensureListLocaleOverrides(limitedIds);
    const media = await this.prisma.mediaItem.findMany({
      where: { id: { in: limitedIds } },
      include: {
        show: { select: { episodesCount: true } },
        ...(userId
          ? {
              watchlist: { where: { userId }, select: { id: true } },
              favorites: { where: { userId }, select: { id: true } },
              showStatuses: { where: { userId }, select: { id: true, watchedCount: true, totalCount: true } },
              movieStatuses: { where: { userId }, select: { id: true, watched: true } },
            }
          : {}),
      },
    });
    const byId = new Map(media.map((m) => [m.id, m]));

    // Batch-query accurate aired episode counts for shows (excludes future + null air dates)
    const showMediaIds = media.filter((m) => m.type === MediaType.SHOW).map((m) => m.id);
    const airedCounts = showMediaIds.length > 0
      ? await this.prisma.$queryRaw<{ mediaId: string; airedCount: number }[]>`
          SELECT sh.media_id AS "mediaId", COUNT(e.id)::int AS "airedCount"
          FROM shows sh
          JOIN seasons s ON s.show_id = sh.id
          JOIN episodes e ON e.season_id = s.id
          WHERE sh.media_id IN (${Prisma.join(showMediaIds)})
            AND s.is_special = false
            AND e.air_date IS NOT NULL
            AND e.air_date <= NOW()
          GROUP BY sh.media_id
        `
      : [];
    const airedMap = new Map(airedCounts.map((r) => [r.mediaId, r.airedCount]));

    return limitedIds
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((m) => {
        const dto = mapMediaCardLite(m as any, userId);
        // Override progress with accurate aired count (same as fetchListDtos)
        if (userId && m!.type === MediaType.SHOW) {
          const watched = (m as any).showStatuses?.[0]?.watchedCount ?? 0;
          const airedTotal = airedMap.get(m!.id) ?? 0;
          dto.userProgress = airedTotal > 0 ? Math.min(1, watched / airedTotal) : 0;
        }
        return dto;
      });
  }

  async fetchListDtos(ids: string[], userId?: string, limit = 20) {
    if (ids.length === 0) return [];
    const limitedIds = ids.slice(0, limit);
    // Populate the request-locale override for items missing it (watchlist/favorites/
    // library) so lists localize without each item having been opened in detail.
    await this.meta.ensureListLocaleOverrides(limitedIds);
    const media = await this.prisma.mediaItem.findMany({
      where: { id: { in: limitedIds } },
      include: {
        show: true,
        movie: true,
        genres: { include: { genre: true } },
        providers: { include: { provider: true } },
        cast: { include: { castMember: true } },
        externalIds: true,
        ...(userId
          ? {
              watchlist: { where: { userId }, select: { id: true } },
              favorites: { where: { userId }, select: { id: true } },
              showStatuses: { where: { userId }, select: { id: true, watchedCount: true, totalCount: true } },
              movieStatuses: { where: { userId }, select: { id: true, watched: true, watchedAt: true } },
            }
          : {}),
      },
    });
    const byId = new Map(media.map((m) => [m.id, m]));

    // Batch-query accurate aired episode counts for shows (excludes future + null air dates)
    const showMediaIds = media.filter((m) => m.type === MediaType.SHOW).map((m) => m.id);
    const airedCounts = showMediaIds.length > 0
      ? await this.prisma.$queryRaw<{ mediaId: string; airedCount: number }[]>`
          SELECT sh.media_id AS "mediaId", COUNT(e.id)::int AS "airedCount"
          FROM shows sh
          JOIN seasons s ON s.show_id = sh.id
          JOIN episodes e ON e.season_id = s.id
          WHERE sh.media_id IN (${Prisma.join(showMediaIds)})
            AND s.is_special = false
            AND e.air_date IS NOT NULL
            AND e.air_date <= NOW()
          GROUP BY sh.media_id
        `
      : [];
    const airedMap = new Map(airedCounts.map((r) => [r.mediaId, r.airedCount]));

    return limitedIds
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((m) => {
        if (m!.type === MediaType.SHOW) {
          const dto = mapShow(m as any, userId);
          // Override progress with accurate aired count
          if (userId) {
            const userStatus = (m as any).showStatuses?.[0];
            const watched = userStatus?.watchedCount ?? 0;
            const airedTotal = airedMap.get(m!.id) ?? 0;
            dto.userProgress = airedTotal > 0 ? Math.min(1, watched / airedTotal) : 0;
          }
          return dto;
        }
        return mapMovie(m as any, userId);
      });
  }
}
