import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { MediaType } from '@tvwatch/shared';
import type { GenreFilterDto, MediaCardLiteDto } from '@tvwatch/shared';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { currentLanguage } from '../common/language.context';
import { RedisService } from '../common/redis/redis.service';
import { localized } from '../common/utils/localization.util';
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
  /** TMDB genre ids per media id from the search payload — genre filters on light rows. */
  genreIds: Record<string, number[]>;
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
    const cacheKey = `search:v5:${q.type ?? 'all'}:${term}:${lang}`;

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
    // Rank media without posters last (stable: the merged local+TMDB relevance order is
    // preserved within each group). Done at read time so late-hydrated posters count.
    let orderedIds = await this.posterLast(entry.ids);
    // Genre filter: hydrated rows match via the DB join, light rows via the TMDB
    // payload genre ids cached alongside the window (zero extra provider calls).
    const genre = q.genre?.trim();
    if (genre) orderedIds = await this.filterIdsByGenre(orderedIds, genre, entry.genreIds ?? {});
    const slice = orderedIds.slice(start, start + want);
    const items = await this.fetchListDtos(slice, userId, want);
    // hasMore via paginate's formula: +1 while more pages may exist upstream.
    const total = orderedIds.length + (entry.exhausted ? 0 : 1);
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

    let entry: SearchCacheEntry = { ids: localIds, genreIds: {}, tmdbPagesFetched: 0, exhausted: false };
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
      items.forEach((item, idx) => {
        entry.genreIds[upserted[idx]] = item.genreIds ?? [];
      });
      entry.ids.push(...upserted);
      if (items.length >= 20) allShort = false; // a full page means there may be more
    }
    return {
      ids: [...new Set(entry.ids)],
      genreIds: entry.genreIds,
      tmdbPagesFetched: nextPage,
      exhausted: allShort,
    };
  }

  /**
   * Stable poster-last ordering for a merged id window: ids whose media row has a poster
   * keep their existing (relevance) order, ids without one are pushed to the end.
   * One batched read per search request.
   */
  async posterLast(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return ids;
    const rows = await this.prisma.mediaItem.findMany({
      where: { id: { in: ids } },
      select: { id: true, posterUrl: true },
    });
    const withPoster = new Set(rows.filter((r) => r.posterUrl).map((r) => r.id));
    const poster: string[] = [];
    const noPoster: string[] = [];
    for (const id of ids) (withPoster.has(id) ? poster : noPoster).push(id);
    return [...poster, ...noPoster];
  }

  private async searchViaDb(term: string, q: SearchQueryDto, userId?: string) {
    const where = {
      title: { contains: term, mode: 'insensitive' as const },
      ...(q.type ? { type: q.type } : {}),
      ...(q.genre?.trim()
        ? { genres: { some: { genre: { slug: { equals: q.genre.trim(), mode: 'insensitive' as const } } } } }
        : {}),
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
    // Poster-last within the page (same ranking rule as the provider search).
    const ordered = [...rows.filter((r) => r.posterUrl), ...rows.filter((r) => !r.posterUrl)];
    const ids = ordered.map((r) => r.id);
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
   * Trending entries with a short cache: resolving a page costs a TMDb call plus one
   * lightUpsert per item (each = 1 externalId read + a mediaItem write), so an
   * uncached Discover open did ~80 queries, half of them writes. Entries are
   * user-agnostic and carry the payload's TMDB genre ids so genre filters need no
   * extra provider call; user-specific flags are applied by fetchListDtos afterwards.
   */
  private async cachedTrendingEntries(
    kind: 'show' | 'movie',
    page: number,
  ): Promise<{ id: string; g: number[] }[]> {
    const key = `trending:ids:v2:${kind}:${currentLanguage()}:${page}`;
    const cached = await this.redis.get<{ id: string; g: number[] }[]>(key);
    if (cached?.length) return cached;
    const items = kind === 'show'
      ? await this.tmdb.trendingShows('week', page)
      : await this.tmdb.trendingMovies('week', page);
    const entries = await Promise.all(
      items.map(async (i) => ({
        id: await (kind === 'show' ? this.meta.lightUpsertShow(i) : this.meta.lightUpsertMovie(i)),
        g: i.genreIds ?? [],
      })),
    );
    if (entries.length) await this.redis.set(key, entries, 300);
    return entries;
  }

  async trendingShows(userId?: string, page = 1, pageSize = 20, genre?: string) {
    if (!this.tmdb.enabled)
      return {
        items: await this.topDb(MediaType.SHOW, pageSize, userId, genre ? ({ genre } as DiscoverQueryDto) : undefined),
        page,
        hasMore: false,
      };
    const g = genre?.trim();
    if (g) {
      const win = await this.trendingWindow('show', g, page * pageSize);
      const items = await this.fetchListDtos(
        win.ids.slice((page - 1) * pageSize, page * pageSize),
        userId,
        pageSize,
      );
      return { items, page, hasMore: win.ids.length > page * pageSize || !win.exhausted };
    }
    const entries = await this.cachedTrendingEntries('show', page);
    const listItems = await this.fetchListDtos(entries.map((e) => e.id), userId, pageSize);
    return { items: listItems, page, hasMore: entries.length === 20 };
  }

  async trendingMovies(userId?: string, page = 1, pageSize = 20, genre?: string) {
    if (!this.tmdb.enabled)
      return {
        items: await this.topDb(MediaType.MOVIE, pageSize, userId, genre ? ({ genre } as DiscoverQueryDto) : undefined),
        page,
        hasMore: false,
      };
    const g = genre?.trim();
    if (g) {
      const win = await this.trendingWindow('movie', g, page * pageSize);
      const items = await this.fetchListDtos(
        win.ids.slice((page - 1) * pageSize, page * pageSize),
        userId,
        pageSize,
      );
      return { items, page, hasMore: win.ids.length > page * pageSize || !win.exhausted };
    }
    const entries = await this.cachedTrendingEntries('movie', page);
    const listItems = await this.fetchListDtos(entries.map((e) => e.id), userId, pageSize);
    return { items: listItems, page, hasMore: entries.length === 20 };
  }

  /**
   * Genre-filtered trending window: a genre chip applied to a single 20-item
   * trending page leaves only a handful of cards (and an unscrollable see-all —
   * short content never fires onEndReached), so filtered results are accumulated
   * across upstream pages (cap 10) and cached per (kind, lang, genre). The window
   * expands on demand when deeper pages are requested.
   */
  private async trendingWindow(
    kind: 'show' | 'movie',
    genre: string,
    target: number,
  ): Promise<{ ids: string[]; upstreamPages: number; exhausted: boolean }> {
    const key = `trending:filtered:v1:${kind}:${currentLanguage()}:${genre.toLowerCase()}`;
    const win = (await this.redis.get<{ ids: string[]; upstreamPages: number; exhausted: boolean }>(key))
      ?? { ids: [], upstreamPages: 0, exhausted: false };
    let rounds = 0;
    while (win.ids.length < target && !win.exhausted && rounds < 5) {
      if (win.upstreamPages >= 10) {
        win.exhausted = true;
        break;
      }
      const entries = await this.cachedTrendingEntries(kind, win.upstreamPages + 1);
      win.upstreamPages += 1;
      rounds += 1;
      if (!entries.length) {
        win.exhausted = true;
        break;
      }
      win.ids.push(...(await this.applyGenreToEntries(entries, genre)));
      if (entries.length < 20) win.exhausted = true;
    }
    win.ids = [...new Set(win.ids)];
    await this.redis.set(key, win, 300);
    return win;
  }

  private async applyGenreToEntries(
    entries: { id: string; g: number[] }[],
    genre?: string,
  ): Promise<string[]> {
    const ids = entries.map((e) => e.id);
    if (!genre?.trim()) return ids;
    const payload: Record<string, number[]> = {};
    for (const e of entries) payload[e.id] = e.g;
    return this.filterIdsByGenre(ids, genre.trim(), payload);
  }

  /**
   * TMDB genre ids (tv + movie lists) matching a genre name — used to filter light
   * rows by the genre ids carried in provider payloads. Lists cached 24h.
   */
  private async tmdbGenreIds(name: string): Promise<number[]> {
    const key = 'tmdb:genre-lists:v1';
    let lists = await this.redis.get<{
      tv: { id: number; name: string }[];
      movie: { id: number; name: string }[];
    }>(key);
    if (!lists) {
      const [tv, movie] = this.tmdb.enabled
        ? await Promise.all([
            this.tmdb.genres('tv').catch(() => [] as { id: number; name: string }[]),
            this.tmdb.genres('movie').catch(() => [] as { id: number; name: string }[]),
          ])
        : [[], []];
      lists = { tv, movie };
      await this.redis.set(key, lists, 86400);
    }
    const needle = name.trim().toLowerCase();
    return [...lists.tv, ...lists.movie]
      .filter((g) => g.name.toLowerCase() === needle)
      .map((g) => g.id);
  }

  /**
   * Genre filter over an id window. The filter value is a genre SLUG (locale-
   * independent): hydrated rows match through the media_genres join on slug,
   * light rows through the TMDB genre ids cached from the provider payload
   * (the row's English base name maps slug → TMDB genre id).
   */
  private async filterIdsByGenre(
    ids: string[],
    genre: string,
    payloadGenreIds: Record<string, number[]>,
  ): Promise<string[]> {
    if (ids.length === 0) return ids;
    const [row, dbRows] = await Promise.all([
      this.prisma.genre.findFirst({
        where: { slug: { equals: genre, mode: 'insensitive' } },
        select: { name: true },
      }),
      this.prisma.mediaItem.findMany({
        where: {
          id: { in: ids },
          genres: { some: { genre: { slug: { equals: genre, mode: 'insensitive' } } } },
        },
        select: { id: true },
      }),
    ]);
    const tmdbIds = await this.tmdbGenreIds(row?.name ?? genre);
    const dbMatched = new Set(dbRows.map((r) => r.id));
    return ids.filter(
      (id) => dbMatched.has(id) || (payloadGenreIds[id] ?? []).some((g) => tmdbIds.includes(g)),
    );
  }

  /** Genres present in the catalog, most-used first — filter chip lists. */
  async listGenres(): Promise<GenreFilterDto[]> {
    const rows = await this.prisma.genre.findMany({
      where: { media: { some: {} } },
      include: { _count: { select: { media: true } } },
      orderBy: { media: { _count: 'desc' } },
    });
    return rows.map((g) => ({
      id: g.id,
      name: localized(g, 'names', 'name') ?? g.name,
      slug: g.slug,
    }));
  }

  async discoverSections(userId?: string, genre?: string) {
    const g = genre?.trim() || undefined;
    const [trendingShows, trendingMovies] = await Promise.all([
      this.tmdb.enabled
        ? this.trendingShows(userId, 1, 20, g)
        : { items: await this.topDb(MediaType.SHOW, 20, userId, g ? ({ genre: g } as DiscoverQueryDto) : undefined), page: 1, hasMore: false },
      this.tmdb.enabled
        ? this.trendingMovies(userId, 1, 20, g)
        : { items: await this.topDb(MediaType.MOVIE, 20, userId, g ? ({ genre: g } as DiscoverQueryDto) : undefined), page: 1, hasMore: false },
    ]);
    const topForYou = userId
      ? (await this.forYou(userId, 1, 10, g)).items
      : trendingShows.items.slice(0, 10);
    return { topForYou, trendingShows: trendingShows.items, trendingMovies: trendingMovies.items };
  }

  /**
   * Paginated "Top shows for you": the full ranked suggestion list is cached per
   * (user, genre, lang) for 5 min, so both the Explore carousel (page 1, size 10)
   * and the see-all (20/page, infinite scroll) page through ONE ranking ordered
   * best-first. Anonymous users get trending shows.
   */
  async forYou(userId: string | undefined, page = 1, pageSize = 20, genre?: string) {
    if (!userId) return this.trendingShows(undefined, page, pageSize, genre);
    const key = `foryou:v1:${userId}:${genre?.trim().toLowerCase() || 'all'}:${currentLanguage()}`;
    let ids = await this.redis.get<string[]>(key);
    if (!ids) {
      ids = await this.rankForYouIds(userId, genre?.trim() || undefined);
      await this.redis.set(key, ids, 300);
    }
    const items = await this.fetchListDtos(ids.slice((page - 1) * pageSize, page * pageSize), userId, pageSize);
    return { items, page, hasMore: ids.length > page * pageSize };
  }

  /**
   * Personalized "Top shows for you" ranking. Affinity comes from the user's genres
   * (history ×2, favorites ×1) AND the TMDB keywords of what they watch/love;
   * candidates are then ranked by affinity + community rating + recency, so
   * fresh well-rated matches beat old catalog filler. Anything the user already
   * watched, watchlisted, or favorited is excluded. With a genre filter active the
   * pool is that genre's whole catalog (affinity still drives the ranking), so a
   * filter never starves the section. Returns the ranked ids (cap 300).
   */
  private async rankForYouIds(userId: string, genre?: string): Promise<string[]> {
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
    const topGenres = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const genreNames = topGenres.map(([name]) => name);
    // No taste signal at all: only a genre-filtered browse can still rank by rating+recency.
    if (genreNames.length === 0 && !genre) return [];

    // Keyword affinity: frequency of TMDB keywords over the user's watched +
    // favorited shows/movies (persisted at hydration) — catches taste signals
    // genres are too coarse for (e.g. "isekai", "true crime", "sitcom").
    const topKeywords = await this.prisma.$queryRaw<{ kw: string; c: number }[]>`
      SELECT kw, COUNT(*)::int AS c FROM (
        SELECT jsonb_array_elements_text(s.keywords::jsonb) AS kw
        FROM shows s
        WHERE jsonb_typeof(s.keywords::jsonb) = 'array' AND (
          EXISTS (SELECT 1 FROM watch_history wh WHERE wh.media_id = s.media_id AND wh.user_id = ${userId})
          OR EXISTS (SELECT 1 FROM favorites f WHERE f.media_id = s.media_id AND f.user_id = ${userId})
        )
        UNION ALL
        SELECT jsonb_array_elements_text(m.keywords::jsonb) AS kw
        FROM movies m
        WHERE jsonb_typeof(m.keywords::jsonb) = 'array' AND (
          EXISTS (SELECT 1 FROM watch_history wh WHERE wh.media_id = m.media_id AND wh.user_id = ${userId})
          OR EXISTS (SELECT 1 FROM favorites f WHERE f.media_id = m.media_id AND f.user_id = ${userId})
        )
      ) kws
      GROUP BY kw
      ORDER BY c DESC
      LIMIT 12
    `;
    const keywordWeight = new Map(topKeywords.map((r, i) => [r.kw.toLowerCase(), 12 - i]));

    // Novelty: never recommend what the user already tracks.
    const excludedIds = (
      await this.prisma.$queryRaw<{ media_id: string }[]>`
        SELECT media_id FROM watch_history WHERE user_id = ${userId}
        UNION SELECT media_id FROM watchlist_items WHERE user_id = ${userId}
        UNION SELECT media_id FROM favorites WHERE user_id = ${userId}
      `
    ).map((r) => r.media_id);

    const candidates = await this.prisma.mediaItem.findMany({
      where: {
        type: MediaType.SHOW,
        posterUrl: { not: null },
        // Genre filter active: the pool is that genre's catalog (affinity only ranks).
        // Otherwise: the pool is the user's affinity genres.
        genres: genre
          ? { some: { genre: { slug: { equals: genre, mode: 'insensitive' } } } }
          : { some: { genre: { name: { in: genreNames } } } },
        id: { notIn: excludedIds },
      },
      include: {
        genres: { include: { genre: true } },
        show: { select: { keywords: true, yearStart: true } },
      },
      orderBy: { popularity: 'desc' },
      take: 600,
    });

    // Rank: genre affinity (rank-weighted) + keyword affinity (capped) +
    // community rating + recency boost (old catalogs sink, fresh shows float).
    const genreRank = new Map(topGenres.map(([name], idx) => [name, idx]));
    const thisYear = new Date().getFullYear();
    const scored = candidates.map((m) => {
      let score = 0;
      for (const mg of m.genres) {
        const rank = genreRank.get(mg.genre.name);
        if (rank !== undefined) score += 12 - rank * 2;
      }
      const kws = Array.isArray(m.show?.keywords) ? (m.show!.keywords as string[]) : [];
      let kwScore = 0;
      for (const k of kws) kwScore += keywordWeight.get(k.toLowerCase()) ?? 0;
      score += Math.min(kwScore, 18);
      score += m.rating ?? 0;
      const year = m.show?.yearStart ?? null;
      if (year) {
        const age = thisYear - year;
        if (age <= 3) score += 10;
        else if (age <= 7) score += 6;
        else if (age <= 12) score += 3;
        else if (age > 25) score -= 6;
      }
      return { id: m.id, score };
    });
    scored.sort((a, b) => b.score - a.score);
    // Cap the cached ranking at 300 — plenty of scroll depth, bounded Redis payload.
    return scored.slice(0, 300).map((s) => s.id);
  }

  private async discoverViaDb(type: MediaType, q: DiscoverQueryDto, userId?: string) {
    return this.topDb(type, q.pageSize || 20, userId, q);
  }

  private async topDb(type: MediaType, limit: number, userId?: string, q?: DiscoverQueryDto) {
    const where = {
      type,
      ...(q?.genre?.trim()
        ? { genres: { some: { genre: { slug: { equals: q.genre.trim(), mode: 'insensitive' as const } } } } }
        : {}),
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
