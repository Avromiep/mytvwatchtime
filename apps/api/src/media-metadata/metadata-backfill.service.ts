import { Injectable, Logger } from '@nestjs/common';
import { ExternalProvider, MediaType, ProviderEntityKind } from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { MediaMetadataService } from './media-metadata.service';
import { HydrationQueue } from './hydration/hydration.queue';
import { TmdbClient } from './providers/tmdb.client';
import { TmdbProvider } from './providers/tmdb.provider';
import { TvdbProvider } from './providers/tvdb.provider';
import { isProviderError } from './providers/shared/provider-errors';
import { ProviderThrottled } from './providers/shared/provider-http';
import { StructureRemapService } from './structure-remap.service';
import { slugify } from './util/slugify';

/**
 * Metadata health stats + background backfill.
 *
 * Backfill hydrates incomplete media in small, rate-limited batches:
 *   - TMDB-first when a TMDB id exists; TVDB-only fallback when it doesn't.
 *   - After hydration it enqueues classification, which applies the anime priority
 *     Kitsu > Jikan/MyAnimeList > TVDB > TMDB (field-by-field) via the enrichment worker.
 *   - Each item is best-effort (one failure never aborts the batch) and the global
 *     provider rate limiter bounds TVDB/TMDB/Kitsu/Jikan load.
 */
@Injectable()
export class MetadataBackfillService {
  private readonly logger = new Logger(MetadataBackfillService.name);
  /** Items processed per cron run (default). Override per-call with backfillBatch(count). */
  private readonly defaultBatchSize = 1000;
  /** Prevents concurrent batches from picking the same items. */
  private backfillRunning = false;
  /** Prevents concurrent anime→TVDB rehydration batches. */
  private animeFixRunning = false;
  /** Prevents concurrent type-mismatch repair batches. */
  private typeRepairRunning = false;
  /** Prevents concurrent cast character-id backfills. */
  private charIdFixRunning = false;
  /** In-flight per-show repairs — concurrent callers (detail + episodes requests arriving
   *  together, or a view racing the cron) share ONE repair instead of double-hydrating. */
  private readonly animeFixInflight = new Map<string, Promise<{ fixed: boolean; remapped: number }>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly meta: MediaMetadataService,
    private readonly hydration: HydrationQueue,
    private readonly redis: RedisService,
    private readonly tmdb: TmdbClient,
    private readonly tvdb: TvdbProvider,
    private readonly tmdbProvider: TmdbProvider,
    private readonly structureRemap: StructureRemapService,
  ) {}

  /** Counts of media needing attention — powers the admin "metadata health" view. */
  async getHealthStats() {
    // Optimized queries: avoid NOT EXISTS on episodes (573k rows); check at the season level.
    const [
      total,
      neverHydrated,
      showsNoSeasons,
      moviesMissingOverview,
      tvdbOnly,
      stale,
      classification,
      animeOnTmdb,
      animeOnTmdbNoTvdbId,
      structuralTypeMismatch,
      castMissingCharacterIds,
      movieDataOnShows,
    ] = await Promise.all([
      this.prisma.mediaItem.count(),
      this.prisma.mediaItem.count({ where: { metadataRefreshedAt: null } }),
      this.prisma.$queryRaw<{ c: bigint }[]>`SELECT count(*)::bigint AS c FROM media_items m
          JOIN shows sh ON sh.media_id = m.id
          WHERE m.type='SHOW' AND NOT EXISTS (SELECT 1 FROM seasons s WHERE s.show_id = sh.id)`,
      this.prisma.mediaItem.count({ where: { type: 'MOVIE', overview: null } }),
      this.prisma.$queryRaw<{ c: bigint }[]>`SELECT count(*)::bigint AS c FROM media_items m
          WHERE EXISTS (SELECT 1 FROM external_ids e WHERE e.media_id=m.id AND e.provider='THE_TVDB')
            AND NOT EXISTS (SELECT 1 FROM external_ids e WHERE e.media_id=m.id AND e.provider='TMDB')`,
      this.prisma.mediaItem.count({
        where: { metadataRefreshedAt: { lt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30) } },
      }),
      this.prisma.mediaItem.groupBy({
        by: ['contentClassification'],
        _count: { _all: true },
      }),
      // Animation-genre shows with stale TMDB-structured episode rows (TMDB anime
      // structures are often wrong — these should be TVDB-hydrated). "Stale" = the row
      // has a TMDB episode external id and no TVDB one; fresh rows carry both after the
      // union upsert, so partially-switched shows are still counted. The animation genre
      // matches slug OR English name (localized genre rows exist from non-en hydrations).
      this.prisma.$queryRaw<{ c: bigint }[]>`SELECT count(*)::bigint AS c FROM media_items m
          JOIN shows sh ON sh.media_id = m.id
          WHERE m.type='SHOW'
            AND EXISTS (SELECT 1 FROM media_genres mg JOIN genres g ON g.id = mg.genre_id
                        WHERE mg.media_id = m.id AND (g.slug = 'animation' OR lower(g.name) = 'animation'))
            AND EXISTS (SELECT 1 FROM seasons s
                        JOIN episodes e ON e.season_id = s.id
                        JOIN episode_external_ids ee ON ee.episode_id = e.id AND ee.provider = 'TMDB'
                        WHERE s.show_id = sh.id
                          AND NOT EXISTS (SELECT 1 FROM episode_external_ids tv
                                          WHERE tv.episode_id = e.id AND tv.provider = 'THE_TVDB'))`,
      // Same set, but missing the series-level TVDB id (the fix needs a cross-id lookup).
      this.prisma.$queryRaw<{ c: bigint }[]>`SELECT count(*)::bigint AS c FROM media_items m
          JOIN shows sh ON sh.media_id = m.id
          WHERE m.type='SHOW'
            AND EXISTS (SELECT 1 FROM media_genres mg JOIN genres g ON g.id = mg.genre_id
                        WHERE mg.media_id = m.id AND (g.slug = 'animation' OR lower(g.name) = 'animation'))
            AND EXISTS (SELECT 1 FROM seasons s
                        JOIN episodes e ON e.season_id = s.id
                        JOIN episode_external_ids ee ON ee.episode_id = e.id AND ee.provider = 'TMDB'
                        WHERE s.show_id = sh.id
                          AND NOT EXISTS (SELECT 1 FROM episode_external_ids tv
                                          WHERE tv.episode_id = e.id AND tv.provider = 'THE_TVDB'))
            AND NOT EXISTS (SELECT 1 FROM external_ids x WHERE x.media_id = m.id AND x.provider = 'THE_TVDB')`,
      // Cross-type contamination: a MOVIE row carrying a shows row (or the reverse) —
      // two entities merged into one record by a cross-namespace id confusion.
      this.prisma.$queryRaw<{ c: bigint }[]>`SELECT count(*)::bigint AS c FROM media_items m
          WHERE (m.type='MOVIE' AND EXISTS (SELECT 1 FROM shows sh WHERE sh.media_id = m.id))
             OR (m.type='SHOW' AND EXISTS (SELECT 1 FROM movies mv WHERE mv.media_id = m.id))`,
      // Shows with a cast but NO TVDB character ids yet (cast predates the
      // characterExternalId field — a TVDB rehydration fills the whole cast at once).
      this.prisma.$queryRaw<{ c: bigint }[]>`SELECT count(*)::bigint AS c FROM media_items m
          WHERE m.type='SHOW'
            AND EXISTS (SELECT 1 FROM media_cast mc WHERE mc.media_id = m.id)
            AND NOT EXISTS (SELECT 1 FROM media_cast mc WHERE mc.media_id = m.id AND mc.character_external_id IS NOT NULL)`,
      // User-data type mismatch: movie statuses/history written onto SHOW rows (never
      // legitimate — purged by the type-mismatch repair).
      this.prisma.$queryRaw<{ c: bigint }[]>`
        SELECT (SELECT count(*)::bigint FROM user_movie_status u JOIN media_items m ON m.id = u.media_id WHERE m.type='SHOW')
             + (SELECT count(*)::bigint FROM watch_history h JOIN media_items m ON m.id = h.media_id WHERE m.type='SHOW' AND h.media_type='MOVIE') AS c`,
    ]);
    const toNum = (r: { c: bigint }[] | undefined) => Number(r?.[0]?.c ?? 0);
    return {
      total,
      neverHydrated,
      showsMissingEpisodes: toNum(showsNoSeasons as any),
      moviesMissingOverview,
      tvdbOnly: toNum(tvdbOnly as any),
      stale,
      byClassification: Object.fromEntries(
        classification.map((c: { contentClassification: string; _count: { _all: number } }) => [
          c.contentClassification,
          c._count._all,
        ]),
      ),
      animeOnTmdb: toNum(animeOnTmdb as any),
      animeOnTmdbNoTvdbId: toNum(animeOnTmdbNoTvdbId as any),
      structuralTypeMismatch: toNum(structuralTypeMismatch as any),
      castMissingCharacterIds: toNum(castMissingCharacterIds as any),
      movieDataOnShows: toNum(movieDataOnShows as any),
    };
  }

  /** One batch: hydrate up to `count` media that is GENUINELY incomplete (missing data).
   *  Complete media (has episodes + overview) is NEVER selected — no point re-hydrating it. */
  async backfillBatch(count?: number, maxRps?: number): Promise<{ processed: number; succeeded: number; failed: number; sample: string[] }> {
    if (this.backfillRunning) {
      this.logger.log('Backfill already running — skipping');
      return { processed: 0, succeeded: 0, failed: 0, sample: [] };
    }
    this.backfillRunning = true;
    const limit = Math.max(1, Math.min(count ?? this.defaultBatchSize, 100000));
    const delayMs = maxRps && maxRps > 0 ? Math.round(60000 / maxRps) : 0;
    if (delayMs > 0) this.logger.log(`Backfill throttled to ~${maxRps} items/min (${delayMs}ms delay between items)`);
    try {
    const candidates = await this.prisma.mediaItem.findMany({
      where: {
        OR: [
          { metadataRefreshedAt: null }, // never hydrated (stub)
          { type: 'SHOW', show: { seasons: { none: {} } } }, // show with zero seasons
          { overview: null }, // missing overview (show or movie)
        ],
      },
      orderBy: { createdAt: 'asc' }, // oldest first
      take: limit,
      include: { externalIds: true, genres: { include: { genre: true } } },
    });

    let succeeded = 0;
    let failed = 0;
    const sample: string[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const m = candidates[i];
      try {
        await this.hydrateOne(
          m.id,
          m.externalIds as unknown as { provider: ExternalProvider; value: string }[],
          m.type,
          // Genre identity is locale-tolerant: slug OR lowercased name (localized genre
          // rows exist from non-en hydrations).
          m.genres.flatMap((g) => [g.genre.slug, g.genre.name.toLowerCase()]),
        );
        succeeded++;
        if (sample.length < 5) sample.push(m.title);
      } catch (e) {
        failed++;
        this.logger.debug(`backfill failed for ${m.title}: ${(e as Error).message}`);
      }
      // Progress log every 50 items so the admin can see it's working.
      if ((i + 1) % 50 === 0) {
        this.logger.log(`Backfill progress: ${i + 1}/${candidates.length} (${succeeded} ok, ${failed} fail)`);
      }
      // Throttle: wait between items so normal user requests aren't starved.
      if (delayMs > 0 && i < candidates.length - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    this.logger.log(`Metadata backfill batch: ${succeeded}/${candidates.length} succeeded, ${failed} failed`);
    return { processed: candidates.length, succeeded, failed, sample };
    } finally {
      this.backfillRunning = false;
    }
  }

  /**
   * Hydrate a single media item by its best available provider, then enqueue anime classification.
   *
   * CRITICAL: if the media ALREADY has episodes/structure AND has a TVDB id, it was hydrated
   * from TVDB — re-hydrate from TVDB (NEVER switch to TMDB). This preserves the existing
   * season/episode structure that the user's watch history is built on. TMDB is only used for:
   *   - media with no existing structure (never-hydrated stubs)
   *   - media with no TVDB id (TMDB is the only source)
   *
   * Animation-genre shows with a TVDB id are TVDB-authoritative: they re-hydrate from TVDB
   * even when their current structure came from TMDB (the bulk fix is owned by
   * rehydrateAnimeFromTvdb / the anime_tvdb_rehydrate cron).
   */
  private async hydrateOne(
    mediaId: string,
    externals: { provider: ExternalProvider; value: string }[],
    type: string,
    genreKeys: string[] = [],
  ) {
    const tmdb = externals.find((e) => e.provider === ExternalProvider.TMDB);
    const tvdb = externals.find((e) => e.provider === ExternalProvider.THE_TVDB);
    const isShow = type === 'SHOW';
    const hasAnimation = genreKeys.includes('animation');

    // Detect existing structure: shows with ≥1 episode, movies with overview.
    const hasStructure = isShow
      ? (await this.prisma.episode.count({ where: { season: { show: { mediaId } } }, take: 1 })) > 0
      : (await this.prisma.mediaItem.count({ where: { id: mediaId, type: 'MOVIE', overview: { not: null } } })) > 0;

    if (isShow && hasAnimation && tvdb) {
      // Animation show with a TVDB id → TVDB, even if currently TMDB-structured (the fix
      // also remaps user watch data onto the TVDB structure).
      const { fixed } = await this.fixAnimeShowFromTvdb(mediaId).catch(() => ({ fixed: false, remapped: 0 }));
      if (!fixed) await this.meta.ensureShowFullTvdb(Number(tvdb.value)).catch(() => undefined);
    } else if (hasStructure && tvdb) {
      // Already has TVDB-sourced structure → keep TVDB. NEVER override with TMDB.
      if (isShow) await this.meta.ensureShowFullTvdb(Number(tvdb.value)).catch(() => undefined);
      else await this.meta.ensureMovieFullTvdb(Number(tvdb.value)).catch(() => undefined);
    } else if (tmdb) {
      // No existing structure (stub), or no TVDB id → TMDB primary.
      if (isShow) await this.meta.ensureShowFull(Number(tmdb.value));
      else await this.meta.ensureMovieFull(Number(tmdb.value));
    } else if (tvdb) {
      // TVDB-only fallback.
      if (isShow) await this.meta.ensureShowFullTvdb(Number(tvdb.value)).catch(() => undefined);
      else await this.meta.ensureMovieFullTvdb(Number(tvdb.value)).catch(() => undefined);
    } else {
      return; // no provider id to hydrate from
    }
    // Enqueue classification — the worker applies anime priority Kitsu > Jikan > TVDB > TMDB.
    await this.meta.scheduleClassification(mediaId).catch(() => undefined);
  }

  // ---- Anime → TVDB rehydration (admin button + anime_tvdb_rehydrate cron) ----

  /**
   * Re-hydrate Animation-genre shows whose structure came from TMDB. TMDB anime
   * season/episode structures are often wrong, so these shows are TVDB-authoritative.
   *
   * Selection mirrors the `animeOnTmdb` health stat: genre slug `animation`, has TMDB
   * episode external ids, no TVDB episode external ids. Per show: resolve the TVDB series
   * id (stored external id → TMDB /external_ids cross-id → STRICT exact-title+year TVDB
   * search), clear `metadataRefreshedAt` to bypass the 24h staleness gate, then
   * ensureShowFullTvdb (union upsert — never deletes existing structure or watch history).
   * Afterwards StructureRemapService transfers user watch data from any stale TMDB-only
   * episode rows onto the fresh TVDB structure.
   *
   * When TVDB rate-limits us the batch stops early — remaining shows stay on TMDB until
   * the next cron run or a manual "Fix Anime → TVDB" click.
   */
  async rehydrateAnimeFromTvdb(limit?: number): Promise<{
    processed: number;
    succeeded: number;
    failed: number;
    rateLimited: number;
    noTvdbId: number;
    remapped: number;
    sample: string[];
  }> {
    const empty = {
      processed: 0,
      succeeded: 0,
      failed: 0,
      rateLimited: 0,
      noTvdbId: 0,
      remapped: 0,
      sample: [] as string[],
    };
    if (this.animeFixRunning) {
      this.logger.log('Anime TVDB rehydration already running — skipping');
      return empty;
    }
    if (!this.tvdb.enabled) {
      this.logger.warn('TVDB not configured — skipping anime TVDB rehydration');
      return empty;
    }
    this.animeFixRunning = true;
    try {
      const candidates = await this.prisma.mediaItem.findMany({
        where: {
          type: 'SHOW',
          genres: {
            some: { genre: { OR: [{ slug: 'animation' }, { name: { equals: 'Animation', mode: 'insensitive' } }] } },
          },
          // At least one stale TMDB-only episode row. Fresh TVDB rows may coexist after a
          // partial switch (e.g. an earlier detail-view hydration) — those shows still
          // need the remap, so "has any TVDB id" does NOT exclude them.
          show: {
            seasons: {
              some: {
                episodes: {
                  some: {
                    externalIds: { some: { provider: ExternalProvider.TMDB } },
                    NOT: { externalIds: { some: { provider: ExternalProvider.THE_TVDB } } },
                  },
                },
              },
            },
          },
        },
        orderBy: { title: 'asc' },
        take: Math.max(1, Math.min(limit ?? 1000, 100000)),
        select: { id: true, title: true },
      });

      let succeeded = 0;
      let failed = 0;
      let rateLimited = 0;
      let noTvdbId = 0;
      let remapped = 0;
      const sample: string[] = [];
      for (let i = 0; i < candidates.length; i++) {
        const m = candidates[i];
        try {
          const { fixed, remapped: moved } = await this.fixAnimeShowFromTvdb(m.id);
          if (!fixed) {
            noTvdbId++;
            continue;
          }
          remapped += moved;
          succeeded++;
          if (sample.length < 5) sample.push(m.title);
        } catch (e) {
          if (this.isRateLimitError(e)) {
            rateLimited++;
            this.logger.warn(`Anime TVDB rehydration rate-limited after ${i} items — deferring the rest`);
            break;
          }
          failed++;
          this.logger.debug(`anime tvdb rehydration failed for ${m.title}: ${(e as Error).message}`);
        }
        if ((i + 1) % 25 === 0) {
          this.logger.log(`Anime TVDB rehydration progress: ${i + 1}/${candidates.length} (${succeeded} ok, ${failed} fail, ${noTvdbId} no-tvdb-id)`);
        }
      }
      this.logger.log(
        `Anime TVDB rehydration: ${succeeded}/${candidates.length} rehydrated, ${failed} failed, ${rateLimited} rate-limited, ${noTvdbId} skipped (no TVDB id / already repaired), ${remapped} episodes remapped`,
      );
      return { processed: candidates.length, succeeded, failed, rateLimited, noTvdbId, remapped, sample };
    } finally {
      this.animeFixRunning = false;
    }
  }

  /**
   * Repair one Animation-genre show whose structure (partly) came from TMDB: resolve the
   * TVDB series id, force a full TVDB hydration (bypassing the 24h staleness gate), then
   * remap user watch data from stale TMDB-only episode rows onto the TVDB structure.
   *
   * Cheap no-op (`fixed: false`) when the show has no stale TMDB-only rows — safe to call
   * on every anime detail/episodes view. Concurrent calls for the same show COALESCE into
   * one repair, so the detail + episodes requests of one screen load both answer with the
   * post-fix TVDB structure. Shared by the batch fix, the backfill, and the shows service.
   */
  async fixAnimeShowFromTvdb(mediaId: string): Promise<{ fixed: boolean; remapped: number }> {
    const existing = this.animeFixInflight.get(mediaId);
    if (existing) return existing;
    const p = this.doFixAnimeShowFromTvdb(mediaId).finally(() => this.animeFixInflight.delete(mediaId));
    this.animeFixInflight.set(mediaId, p);
    return p;
  }

  private async doFixAnimeShowFromTvdb(mediaId: string): Promise<{ fixed: boolean; remapped: number }> {
    const notFixed = { fixed: false, remapped: 0 };
    if (!this.tvdb.enabled) return notFixed;

    // Stale rows only the TMDB structure has (TMDB episode id, no TVDB one). None →
    // already fully TVDB-structured; nothing to repair.
    const staleRows = await this.prisma.episode.count({
      where: {
        season: { show: { mediaId } },
        externalIds: { some: { provider: ExternalProvider.TMDB } },
        NOT: { externalIds: { some: { provider: ExternalProvider.THE_TVDB } } },
      },
    });
    if (staleRows === 0) return notFixed;

    const media = await this.prisma.mediaItem.findUnique({
      where: { id: mediaId },
      include: { externalIds: true, show: { select: { yearStart: true } } },
    });
    if (!media) return notFixed;

    // Skip when nothing new appeared since the last repair: rows KEPT by the remap
    // (unmapped, but carrying user data) still look stale forever — without this gate
    // every view re-runs a full TVDB hydration + remap for zero effect. A stale count
    // that grew past the kept count means new contamination → re-arm the repair.
    const keptBefore = (media.metadataProvenance as any)?.animeTvdbKeptUnmapped;
    if (typeof keptBefore === 'number' && staleRows <= keptBefore) return notFixed;

    const tvdbId = await this.resolveAnimeTvdbId({
      id: media.id,
      title: media.title,
      externalIds: media.externalIds as unknown as { provider: ExternalProvider; value: string }[],
      show: media.show,
    });
    if (!tvdbId) return notFixed;

    // Bypass the 24h isStale gate inside ensureShowFullTvdb — this is a forced provider
    // switch, not a routine refresh.
    await this.prisma.mediaItem.update({ where: { id: mediaId }, data: { metadataRefreshedAt: null } });
    await this.meta.ensureShowFullTvdb(tvdbId);
    const remap = await this.structureRemap.remapShow(mediaId);
    // Remember the kept-unmapped count so kept rows alone never re-arm this repair.
    await this.prisma.mediaItem.update({
      where: { id: mediaId },
      data: {
        metadataProvenance: {
          ...((media.metadataProvenance as any) ?? {}),
          animeTvdbKeptUnmapped: remap.unmapped,
        },
      },
    });
    return { fixed: true, remapped: remap.mapped };
  }

  /**
   * TVDB series id for an anime show, in trust order:
   *   1. the stored THE_TVDB external id;
   *   2. TMDB's `/tv/{id}/external_ids` lookup (authoritative cross-id — no wrong-match risk);
   *   3. a STRICT TVDB search fallback (exact normalized title + matching year — a wrong
   *      match would corrupt the show's structure).
   * Returns null when no id can be trusted.
   */
  private async resolveAnimeTvdbId(media: {
    id: string;
    title: string;
    externalIds: { provider: ExternalProvider; value: string }[];
    show: { yearStart: number | null } | null;
  }): Promise<number | null> {
    const existing = media.externalIds.find((e) => e.provider === ExternalProvider.THE_TVDB);
    if (existing) return Number(existing.value);

    // TMDB cross-id lookup: TMDB knows the equivalent TVDB series id for most shows.
    const tmdbExt = media.externalIds.find((e) => e.provider === ExternalProvider.TMDB);
    if (tmdbExt) {
      const tvdbId = await this.tmdbProvider.getTvdbIdForShow(Number(tmdbExt.value));
      if (tvdbId) {
        // TMDB's own cross-id is authoritative: when it is already claimed by another
        // media row this show is a duplicate — never title-search past it (a wrong
        // search hit would merge structures).
        const claimed = await this.claimTvdbId(media.id, tvdbId);
        return claimed ? tvdbId : null;
      }
    }

    const res = await this.tvdb.searchShows(media.title, 1);
    const want = slugify(media.title);
    const year = media.show?.yearStart ?? null;
    const hit = res.items.find(
      (it) =>
        it.tvdbId &&
        slugify(it.title) === want &&
        (year == null || (it.year != null && Math.abs(it.year - year) <= 1)),
    );
    if (!hit?.tvdbId) return null;
    const claimed = await this.claimTvdbId(media.id, hit.tvdbId);
    return claimed ? hit.tvdbId : null;
  }

  /**
   * Link a TVDB series id to our media row (required before ensureShowFullTvdb, which
   * resolves the row via this external id). Never hijacks an id already linked to a
   * different media row — that would merge this show's structure into the other row.
   * Returns false when the id cannot be claimed.
   */
  private async claimTvdbId(mediaId: string, tvdbId: number): Promise<boolean> {
    const linked = await this.prisma.externalId.findFirst({
      where: { provider: ExternalProvider.THE_TVDB, value: String(tvdbId) },
      select: { mediaId: true },
    });
    if (linked) return linked.mediaId === mediaId;
    await this.prisma.externalId.create({
      data: {
        mediaId,
        provider: ExternalProvider.THE_TVDB,
        providerEntityKind: ProviderEntityKind.SERIES,
        value: String(tvdbId),
      },
    });
    return true;
  }

  /** Real TVDB 429 (ProviderError) or internal fixed-window throttle (ProviderThrottled). */
  private isRateLimitError(e: unknown): boolean {
    return e instanceof ProviderThrottled || (isProviderError(e) && e.category === 'rate_limited');
  }

  // ---- Structural type mismatch repair (admin button) ----

  /**
   * Split cross-type contaminated records: a MOVIE row that carries a `shows` row (or a
   * SHOW row carrying a `movies` row) — two entities merged into one by a cross-namespace
   * id confusion (e.g. TVDB series 280103 attached to TMDB movie 62211).
   *
   * Per row: the cross-type entity is re-created correctly (detach the stray-kind
   * external id → fresh hydration), user watch data on the stray episodes is remapped
   * onto it (StructureRemapService, conservative matching — unmapped rows keep the stray
   * structure alive instead of losing data), then the contaminated row is rehydrated
   * from its OWN provider to restore its base metadata.
   */
  async repairTypeMismatches(): Promise<{ processed: number; repaired: number; skipped: number; failed: number }> {
    const empty = { processed: 0, repaired: 0, skipped: 0, failed: 0 };
    if (this.typeRepairRunning) {
      this.logger.log('Type mismatch repair already running — skipping');
      return empty;
    }
    this.typeRepairRunning = true;
    try {
      // User-data type mismatches first: movie statuses/history written onto SHOW rows
      // (e.g. by a mis-tagged import item). These rows are provably garbage — a movie
      // status/history on a show can never be legitimate — and hide shows under My Movies.
      const [statusDel, historyDel] = await this.prisma.$transaction([
        this.prisma.userMovieStatus.deleteMany({ where: { media: { type: 'SHOW' } } }),
        this.prisma.watchHistory.deleteMany({ where: { mediaType: 'MOVIE', media: { type: 'SHOW' } } }),
      ]);
      if (statusDel.count + historyDel.count > 0) {
        this.logger.log(
          `Type mismatch repair: removed ${statusDel.count} movie statuses + ${historyDel.count} movie history rows on shows`,
        );
      }

      const mismatches = await this.prisma.mediaItem.findMany({
        where: {
          OR: [
            { type: 'MOVIE', show: { isNot: null } },
            { type: 'SHOW', movie: { isNot: null } },
          ],
        },
        include: { externalIds: true },
        orderBy: { createdAt: 'asc' },
      });

      let repaired = 0;
      let skipped = 0;
      let failed = 0;
      for (const m of mismatches) {
        try {
          const ok = await this.repairOneMismatch(
            m.id,
            m.type,
            m.title,
            m.externalIds as unknown as {
              provider: ExternalProvider;
              providerEntityKind: ProviderEntityKind;
              value: string;
            }[],
          );
          if (ok) repaired++;
          else skipped++;
        } catch (e) {
          failed++;
          this.logger.warn(`type mismatch repair failed for ${m.title} (${m.id}): ${(e as Error).message}`);
        }
      }
      this.logger.log(
        `Type mismatch repair: ${repaired}/${mismatches.length} repaired, ${skipped} skipped, ${failed} failed`,
      );
      return { processed: mismatches.length, repaired, skipped, failed };
    } finally {
      this.typeRepairRunning = false;
    }
  }

  /** One contaminated row → true when fully repaired, false when skipped (needs a human). */
  private async repairOneMismatch(
    mediaId: string,
    type: string,
    title: string,
    externalIds: { provider: ExternalProvider; providerEntityKind: ProviderEntityKind; value: string }[],
  ): Promise<boolean> {
    const isMovieRow = type === MediaType.MOVIE;
    // The cross-type entity's identity: the external id whose KIND matches the stray
    // structure (SERIES id on a MOVIE row, MOVIE id on a SHOW row).
    const strayKind = isMovieRow ? ProviderEntityKind.SERIES : ProviderEntityKind.MOVIE;
    const ownKind = isMovieRow ? ProviderEntityKind.MOVIE : ProviderEntityKind.SERIES;
    const strayExt =
      externalIds.find((e) => e.provider === ExternalProvider.THE_TVDB && e.providerEntityKind === strayKind) ??
      externalIds.find((e) => e.provider === ExternalProvider.TMDB && e.providerEntityKind === strayKind);
    const ownExt =
      externalIds.find((e) => e.provider === ExternalProvider.TMDB && e.providerEntityKind === ownKind) ??
      externalIds.find((e) => e.provider === ExternalProvider.THE_TVDB && e.providerEntityKind === ownKind);

    if (!strayExt) {
      // No identity to rebuild the cross-type entity from: remove the stray structural
      // row only when it carries NO episodes with user data.
      if (isMovieRow && (await this.strayShowHasUserData(mediaId))) return false;
      await this.deleteStrayStructure(mediaId, isMovieRow);
      this.logger.log(`type mismatch: removed stray structure on ${title} (${mediaId}) — no cross-type id`);
      return true;
    }

    // 1. Detach the stray-kind external id GLOBALLY (it may be parked on any row — the
    // recreated entity must be able to claim it). Re-attached to this row on failure so a
    // retry can resolve the cross-type entity again.
    const detached = await this.prisma.externalId.deleteMany({
      where: {
        provider: strayExt.provider,
        providerEntityKind: strayExt.providerEntityKind,
        value: strayExt.value,
      },
    });
    try {
      // 2. Recreate the cross-type entity correctly from its own provider.
      const newEntityId =
        strayExt.provider === ExternalProvider.THE_TVDB
          ? isMovieRow
            ? await this.meta.ensureShowFullTvdb(Number(strayExt.value))
            : await this.meta.ensureMovieFullTvdb(Number(strayExt.value))
          : isMovieRow
            ? await this.meta.ensureShowFull(Number(strayExt.value))
            : await this.meta.ensureMovieFull(Number(strayExt.value));

      // 3. Transfer watch data from the stray episodes onto the new entity.
      if (isMovieRow) {
        const remap = await this.structureRemap.remapEpisodesToMedia(mediaId, newEntityId);
        // Safety net independent of the remap result: NEVER delete the stray structure
        // while any of its episodes still carries user data — e.g. when the new entity
        // came back with 0 episodes (partial provider fetch) the remap early-exits with
        // unmapped=0 and the data would cascade away silently.
        const remaining = await this.strayShowHasUserData(mediaId);
        if (remap.unmapped > 0 || remaining) {
          this.logger.warn(
            `type mismatch: ${title} (${mediaId}) split into ${newEntityId}, but ${remap.unmapped} episodes kept unmapped user data — stray shows row retained`,
          );
          return false; // stray shows row must stay (holds user data)
        }
      }

      // 4. Remove the now-empty stray structure, then restore the row's own base metadata.
      await this.deleteStrayStructure(mediaId, isMovieRow);
      await this.prisma.mediaItem.update({ where: { id: mediaId }, data: { metadataRefreshedAt: null } });
      if (ownExt) {
        if (isMovieRow) {
          if (ownExt.provider === ExternalProvider.TMDB) await this.meta.ensureMovieFull(Number(ownExt.value));
          else await this.meta.ensureMovieFullTvdb(Number(ownExt.value));
        } else {
          if (ownExt.provider === ExternalProvider.TMDB) await this.meta.ensureShowFull(Number(ownExt.value));
          else await this.meta.ensureShowFullTvdb(Number(ownExt.value));
        }
      }
      this.logger.log(`type mismatch: split ${title} (${mediaId}) — cross-type entity is ${newEntityId}`);
      return true;
    } catch (e) {
      // Restore the detached id so the next run can resolve the cross-type entity again.
      if (detached.count > 0) {
        await this.prisma.externalId
          .create({
            data: {
              mediaId,
              provider: strayExt.provider,
              providerEntityKind: strayExt.providerEntityKind,
              value: strayExt.value,
            },
          })
          .catch(() => undefined);
      }
      throw e;
    }
  }

  /** Any user data (status/rating/reaction/vote/comment) on episodes of a media's shows row? */
  private async strayShowHasUserData(mediaId: string): Promise<boolean> {
    const episodeScope = { episode: { season: { show: { mediaId } } } };
    const [statuses, ratings, reactions, votes, comments] = await Promise.all([
      this.prisma.userEpisodeStatus.count({ where: { ...episodeScope }, take: 1 }),
      this.prisma.rating.count({ where: { ...episodeScope }, take: 1 }),
      this.prisma.reaction.count({ where: { ...episodeScope }, take: 1 }),
      this.prisma.characterVote.count({ where: { ...episodeScope }, take: 1 }),
      // Comments key episodes by thread_id string (no FK relation) — raw count instead.
      this.countEpisodeThreadComments(mediaId),
    ]);
    return statuses + ratings + reactions + votes + comments > 0;
  }

  /** Episode-thread comments for any episode of a media's shows row. */
  private async countEpisodeThreadComments(mediaId: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ c: bigint }[]>`
      SELECT count(*)::bigint AS c FROM comments cm
      JOIN episodes e ON cm.thread_id = e.id
      JOIN seasons s ON e.season_id = s.id
      JOIN shows sh ON s.show_id = sh.id
      WHERE cm.thread_type = 'EPISODE' AND sh.media_id = ${mediaId}`;
    return Number(rows?.[0]?.c ?? 0);
  }

  /** Delete the stray structural row (shows on a MOVIE row cascades seasons+episodes). */
  private async deleteStrayStructure(mediaId: string, isMovieRow: boolean): Promise<void> {
    if (isMovieRow) await this.prisma.show.delete({ where: { mediaId } }).catch(() => undefined);
    else await this.prisma.movie.delete({ where: { mediaId } }).catch(() => undefined);
  }

  // ---- Cast character-id backfill (admin button) ----

  /**
   * Fill `media_cast.characterExternalId` (TVDB character ids) for shows whose cast rows
   * predate the field. One full TVDB hydration per show — the cast rewrite fills every
   * role at once; never per-character calls. Powers TVTime character-vote resolution.
   * Stops early on TVDB rate limits (the stat shows the remainder).
   */
  async backfillCharacterIds(limit?: number): Promise<{
    processed: number;
    succeeded: number;
    failed: number;
    rateLimited: number;
    sample: string[];
  }> {
    const empty = { processed: 0, succeeded: 0, failed: 0, rateLimited: 0, sample: [] as string[] };
    if (this.charIdFixRunning) {
      this.logger.log('Character-id backfill already running — skipping');
      return empty;
    }
    if (!this.tvdb.enabled) {
      this.logger.warn('TVDB not configured — skipping character-id backfill');
      return empty;
    }
    this.charIdFixRunning = true;
    try {
      const candidates = await this.prisma.mediaItem.findMany({
        where: {
          type: 'SHOW',
          cast: { some: {} },
          NOT: { cast: { some: { characterExternalId: { not: null } } } },
          externalIds: { some: { provider: ExternalProvider.THE_TVDB } },
        },
        orderBy: { title: 'asc' },
        take: Math.max(1, Math.min(limit ?? 500, 100000)),
        select: {
          id: true,
          title: true,
          externalIds: { where: { provider: ExternalProvider.THE_TVDB }, take: 1, select: { value: true } },
        },
      });

      let succeeded = 0;
      let failed = 0;
      let rateLimited = 0;
      const sample: string[] = [];
      for (let i = 0; i < candidates.length; i++) {
        const m = candidates[i];
        try {
          // Bypass the 24h isStale gate — the cast rewrite only happens on a full refresh.
          await this.prisma.mediaItem.update({ where: { id: m.id }, data: { metadataRefreshedAt: null } });
          // skipClassification: this is a cast-only refresh — re-enqueueing anime
          // classification for every backfilled show saturates Kitsu/Jikan for nothing.
          await this.meta.ensureShowFullTvdb(Number(m.externalIds[0].value), undefined, { skipClassification: true });
          succeeded++;
          if (sample.length < 5) sample.push(m.title);
        } catch (e) {
          if (this.isRateLimitError(e)) {
            rateLimited++;
            this.logger.warn(`Character-id backfill rate-limited after ${i} shows — deferring the rest`);
            break;
          }
          failed++;
          this.logger.debug(`character-id backfill failed for ${m.title}: ${(e as Error).message}`);
        }
        if ((i + 1) % 25 === 0) {
          this.logger.log(`Character-id backfill progress: ${i + 1}/${candidates.length} (${succeeded} ok, ${failed} fail)`);
        }
      }
      this.logger.log(
        `Character-id backfill: ${succeeded}/${candidates.length} rehydrated, ${failed} failed, ${rateLimited} rate-limited`,
      );
      return { processed: candidates.length, succeeded, failed, rateLimited, sample };
    } finally {
      this.charIdFixRunning = false;
    }
  }

  // ---- TMDB Changes sync (daily cron) ----

  /**
   * Call TMDB's /tv/changes and /movie/changes to detect media whose TMDB data changed
   * since the last run. For each changed ID that exists in our DB: clear the TMDB provider
   * cache, then ACTUALLY re-hydrate (ensureShowFull/ensureMovieFull) so the data is updated
   * immediately — not just marked stale. Animation-genre shows are skipped: they are
   * TVDB-authoritative and owned by the anime TVDB rehydration job.
   *
   * First run goes back 14 days; subsequent runs use the date stored in Redis.
   * Fully paginated (no arbitrary cap).
   *
   * `startDate` (YYYY-MM-DD): manual one-off backfill from a specific date. Custom-range
   * runs do NOT move the Redis cursor, so the daily progression is never disturbed.
   */
  async syncTmdbChanges(startDate?: string): Promise<{
    tvChanged: number;
    movieChanged: number;
    matched: number;
    hydrated: number;
    failed: number;
    skippedAnime: number;
  }> {
    if (!this.tmdb.enabled) {
      this.logger.warn('TMDB not configured — skipping changes sync');
      return { tvChanged: 0, movieChanged: 0, matched: 0, hydrated: 0, failed: 0, skippedAnime: 0 };
    }

    // Start date: explicit param (one-off), else last sync (Redis), else 14 days ago.
    const lastRunStr = await this.redis.get<string>('TMDB_CHANGES_LAST_RUN');
    const startDate_ = startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate) ? new Date(`${startDate}T00:00:00Z`) : lastRunStr ? new Date(lastRunStr) : new Date(Date.now() - 1000 * 60 * 60 * 24 * 14);
    const endDate = new Date();
    const fmt = (d: Date) => d.toISOString().slice(0, 10);

    this.logger.log(`TMDB changes sync: ${fmt(startDate_)} → ${fmt(endDate)}${startDate ? ' (custom range)' : ''}`);

    // Fetch ALL changed IDs from TMDB (fully paginated).
    const tvIds = await this.fetchChangedIds('tv', fmt(startDate_), fmt(endDate));
    const movieIds = await this.fetchChangedIds('movie', fmt(startDate_), fmt(endDate));
    const allIds = [...tvIds, ...movieIds];
    this.logger.log(`TMDB changes: ${tvIds.length} TV + ${movieIds.length} movie = ${allIds.length} total changed IDs`);

    // Store the end date so the next run starts from here — EXCEPT for custom-range
    // one-offs, which must never disturb the daily progression.
    if (!startDate) {
      await this.redis.set('TMDB_CHANGES_LAST_RUN', endDate.toISOString(), 86400 * 30);
    }

    if (allIds.length === 0)
      return { tvChanged: 0, movieChanged: 0, matched: 0, hydrated: 0, failed: 0, skippedAnime: 0 };

    // Match against our DB in chunks (PostgreSQL has a 32767 bind-variable limit).
    const matched: { mediaId: string; value: string; media: { type: string; externalIds: any[] } }[] = [];
    const CHUNK = 5000;
    for (let i = 0; i < allIds.length; i += CHUNK) {
      const chunk = allIds.slice(i, i + CHUNK).map(String);
      const rows = await this.prisma.externalId.findMany({
        where: { provider: ExternalProvider.TMDB, value: { in: chunk } },
        select: { mediaId: true, value: true, media: { select: { type: true, externalIds: true } } },
      });
      matched.push(...(rows as any[]));
    }
    this.logger.log(`TMDB changes: ${matched.length} changed IDs match media in our DB`);

    // Clear ALL TMDB caches in ONE bulk scan (much faster than per-item KEYS).
    // The caches re-populate on next access; this ensures re-hydration gets fresh TMDB data.
    await this.bulkClearTmdbCache();

    // Animation-genre shows are TVDB-authoritative — never re-hydrate them from TMDB here.
    // The anime_tvdb_rehydrate cron (and the Metadata Health fix button) owns them.
    const animationRows = await this.prisma.mediaItem.findMany({
      where: {
        type: 'SHOW',
        genres: {
          some: { genre: { OR: [{ slug: 'animation' }, { name: { equals: 'Animation', mode: 'insensitive' } }] } },
        },
      },
      select: { id: true },
    });
    const animationShows = new Set(animationRows.map((r) => r.id));

    // Actually re-hydrate each matched media from TMDB (rate-limited by the gateway).
    let hydrated = 0;
    let failed = 0;
    let skippedAnime = 0;
    for (let i = 0; i < matched.length; i++) {
      const m = matched[i];
      if (m.media.type === 'SHOW' && animationShows.has(m.mediaId)) {
        skippedAnime++;
        continue;
      }
      try {
        if (m.media.type === 'SHOW') {
          await this.meta.ensureShowFull(Number(m.value));
        } else {
          await this.meta.ensureMovieFull(Number(m.value));
        }
        await this.meta.scheduleClassification(m.mediaId).catch(() => undefined);
        hydrated++;
      } catch (e) {
        failed++;
        this.logger.debug(`TMDB changes re-hydration failed for ${m.value}: ${(e as Error).message}`);
      }
      // Progress log every 500 items so the admin can see it's working.
      if ((i + 1) % 500 === 0) {
        this.logger.log(
          `TMDB changes sync progress: ${i + 1}/${matched.length} processed (${hydrated} ok, ${failed} fail, ${skippedAnime} anime-skipped)`,
        );
      }
    }

    this.logger.log(
      `TMDB changes sync complete: ${hydrated} re-hydrated, ${failed} failed, ${skippedAnime} anime shows skipped`,
    );
    return {
      tvChanged: tvIds.length,
      movieChanged: movieIds.length,
      matched: matched.length,
      hydrated,
      failed,
      skippedAnime,
    };
  }

  /** Bulk-clear all cached TMDB responses (one SCAN pass, non-blocking). */
  private async bulkClearTmdbCache(): Promise<void> {
    try {
      const c = this.redis.client as unknown as {
        scan: (cursor: number, opts: any) => Promise<[string, string[]]>;
        del: (...keys: string[]) => Promise<number>;
      };
      let cursor = 0;
      let cleared = 0;
      do {
        const [next, keys] = await c.scan(cursor, { MATCH: 'PC:tmdb:*', COUNT: 500 });
        if (keys.length > 0) {
          await c.del(...keys);
          cleared += keys.length;
        }
        cursor = Number(next);
      } while (cursor !== 0);
      this.logger.log(`Bulk-cleared ${cleared} TMDB cache entries`);
    } catch (e) {
      this.logger.debug(`TMDB bulk cache clear failed (non-fatal): ${(e as Error).message}`);
    }
  }

  /** Fetch ALL changed TMDB IDs for a media type (fully paginated, no arbitrary cap). */
  private async fetchChangedIds(type: 'tv' | 'movie', startDate: string, endDate: string): Promise<number[]> {
    const ids: number[] = [];
    let page = 1;
    let totalPages = 1;
    while (page <= totalPages) {
      try {
        const res = await this.tmdb.get<any>(`/${type}/changes`, { start_date: startDate, end_date: endDate, page });
        const results = Array.isArray(res?.results) ? res.results : [];
        if (results.length === 0) break;
        ids.push(...results.map((r: any) => Number(r.id)).filter(Number.isFinite));
        totalPages = res?.total_pages ?? 1;
        page++;
      } catch (e) {
        this.logger.debug(`TMDB changes fetch failed (page ${page}, ${type}): ${(e as Error).message}`);
        break;
      }
    }
    return ids;
  }

}
