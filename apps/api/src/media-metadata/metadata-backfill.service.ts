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

  // ---- Live repair progress (admin Metadata Health page) ----
  private readonly repairProgress = new Map<
    string,
    {
      running: boolean;
      processed: number;
      total: number;
      succeeded: number;
      failed: number;
      current?: string;
      finishedAt?: Date;
    }
  >();

  private trackRepair(
    job: string,
    patch: Partial<{
      running: boolean;
      processed: number;
      total: number;
      succeeded: number;
      failed: number;
      current: string;
      finishedAt: Date | null;
    }>,
  ) {
    const prev = this.repairProgress.get(job) ?? {
      running: false,
      processed: 0,
      total: 0,
      succeeded: 0,
      failed: 0,
    };
    this.repairProgress.set(job, {
      ...prev,
      ...patch,
      ...(patch.finishedAt === null ? { finishedAt: undefined } : {}),
    } as any);
  }

  /** Live progress snapshot for every repair job (running or recently finished). */
  getRepairProgress() {
    const now = Date.now();
    const out: Record<string, any> = {};
    for (const [job, p] of this.repairProgress) {
      // Recently-finished jobs stay visible for 60s so the UI shows the completion.
      if (p.running || !p.finishedAt || now - p.finishedAt.getTime() < 60_000) out[job] = p;
    }
    return out;
  }
  /** Prevents concurrent type-mismatch repair batches. */
  private typeRepairRunning = false;
  /** Prevents concurrent cast character-id backfills. */
  private charIdFixRunning = false;
  /** In-flight per-show repairs — concurrent callers (detail + episodes requests arriving
   *  together, or a view racing the cron) share ONE repair instead of double-hydrating. */
  private readonly animeFixInflight = new Map<
    string,
    Promise<{ fixed: boolean; remapped: number }>
  >();

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
      multiTvdbIds,
      nonEnglishBase,
      nonEnglishContent,
      bannerAsPoster,
      missingRating,
      animeTvdbUnresolvable,
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
      // Rows whose TVDB id recently proved UNRESOLVABLE (animeTvdbNoId stamp < 30d) are
      // excluded — they are parked, not actionable.
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
            AND COALESCE(m.metadata_provenance #>> '{animeTvdbNoId,at}', '1970-01-01')::timestamptz < NOW() - INTERVAL '30 days'`,
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
            AND NOT EXISTS (SELECT 1 FROM external_ids x WHERE x.media_id = m.id AND x.provider = 'THE_TVDB')
            AND COALESCE(m.metadata_provenance #>> '{animeTvdbNoId,at}', '1970-01-01')::timestamptz < NOW() - INTERVAL '30 days'`,
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
      // Rows carrying MORE THAN ONE TVDB id (same entity kind): merge leftovers (benign)
      // or id-poisoning (one id belongs to a different show — the old title-attach bug).
      this.prisma.$queryRaw<{ c: bigint }[]>`
        SELECT count(*)::bigint AS c FROM (
          SELECT media_id FROM external_ids
          WHERE provider='THE_TVDB'
          GROUP BY media_id, provider_entity_kind
          HAVING count(*) > 1
        ) x`,
      // Rows EXPLICITLY marked as non-English base (title_locale set and != 'en') — the
      // only cheap SQL signal for wrong-language bases. Rows with an UNSET marker are
      // not counted (most have a fine English base title and just predate the overrides
      // structure). Rows marked 'en' with wrong content can't be counted here — see the
      // content-based suspect stat below.
      this.prisma.$queryRaw<{ c: bigint }[]>`
        SELECT count(*)::bigint AS c FROM media_items m
        WHERE m.title_locale IS NOT NULL AND m.title_locale != 'en'`,
      // Content-based suspects STILL NEEDING verification: the title an English user
      // SEES ('en' override → base) contains non-ASCII — catches wrong-language bases
      // whose marker LIES ('en'/unset), which the marker stat above cannot see. Rows
      // already verified as English (remembered in metadata_provenance) are excluded;
      // a title change re-enters the row. The verify+repair checks each against the
      // provider's real English title before touching anything.
      this.prisma.$queryRaw<{ c: bigint }[]>`
        SELECT count(*)::bigint AS c FROM media_items m
        WHERE COALESCE(NULLIF(m.titles->>'en',''), m.title) ~ '[^ -~]'
          AND EXISTS (SELECT 1 FROM external_ids e WHERE e.media_id = m.id)
          AND COALESCE(NULLIF(m.titles->>'en',''), m.title)
                IS DISTINCT FROM m.metadata_provenance->>'enContentVerifiedTitle'`,
      // Rows whose POSTER is a TVDB banner (wide artwork in a poster slot) — legacy of
      // the swapped TVDB series artwork mapping (type 1=banner was taken as poster).
      // URL shape: artworks.thetvdb.com/banners/v4/{kind}/{id}/banners/<file>.
      // Fixed by a TVDB rehydration (the corrected mapper re-picks poster=type 2).
      this.prisma.$queryRaw<{ c: bigint }[]>`
        SELECT count(*)::bigint AS c FROM media_items m
        WHERE m.poster_url ~ '/banners/[^/]+$'
          AND EXISTS (SELECT 1 FROM external_ids e WHERE e.media_id = m.id AND e.provider = 'THE_TVDB')`,
      // Actionable rating backlog: no rating stored, has a provider id to resolve
      // one from, and not already checked (and found unrated at the source) in the
      // last 90 days. Mostly TVDB-hydrated rows — TVDB has no public 0–10 rating,
      // so those are born unrated and reach TMDB's vote_average via cross-ids.
      this.prisma.$queryRaw<{ c: bigint }[]>`
        SELECT count(*)::bigint AS c FROM media_items m
        WHERE m.rating IS NULL
          AND EXISTS (SELECT 1 FROM external_ids e WHERE e.media_id = m.id AND e.provider IN ('TMDB','THE_TVDB'))
          AND (m.metadata_provenance->>'ratingCheckedAt' IS NULL
               OR (m.metadata_provenance->>'ratingCheckedAt')::timestamptz < NOW() - INTERVAL '90 days')`,
      // Animation rows PARKED as unresolvable (no trustworthy TVDB id) in the last
      // 30 days — informational; excluded from animeOnTmdb so it stays actionable.
      this.prisma.$queryRaw<{ c: bigint }[]>`
        SELECT count(*)::bigint AS c FROM media_items m
        WHERE COALESCE(m.metadata_provenance #>> '{animeTvdbNoId,at}', '1970-01-01')::timestamptz >= NOW() - INTERVAL '30 days'`,
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
      multiTvdbIds: toNum(multiTvdbIds as any),
      nonEnglishBase: toNum(nonEnglishBase as any),
      nonEnglishContent: toNum(nonEnglishContent as any),
      bannerAsPoster: toNum(bannerAsPoster as any),
      missingRating: toNum(missingRating as any),
      animeTvdbUnresolvable: toNum(animeTvdbUnresolvable as any),
    };
  }

  /** One batch: hydrate up to `count` media that is GENUINELY incomplete (missing data).
   *  Complete media (has episodes + overview) is NEVER selected — no point re-hydrating it. */
  async backfillBatch(
    count?: number,
    maxRps?: number,
  ): Promise<{ processed: number; succeeded: number; failed: number; sample: string[] }> {
    if (this.backfillRunning) {
      this.logger.log('Backfill already running — skipping');
      return { processed: 0, succeeded: 0, failed: 0, sample: [] };
    }
    this.backfillRunning = true;
    const limit = Math.max(1, Math.min(count ?? this.defaultBatchSize, 100000));
    const delayMs = maxRps && maxRps > 0 ? Math.round(60000 / maxRps) : 0;
    if (delayMs > 0)
      this.logger.log(
        `Backfill throttled to ~${maxRps} items/min (${delayMs}ms delay between items)`,
      );
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
        include: {
          externalIds: true,
          genres: { include: { genre: true } },
          show: { select: { keywords: true } },
          movie: { select: { keywords: true } },
        },
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
            // Anime routing uses the app's real signals (classification / keyword / genre).
            this.isAnimeMedia(m),
          );
          succeeded++;
          if (sample.length < 5) sample.push(m.title);
        } catch (e) {
          failed++;
          this.logger.debug(`backfill failed for ${m.title}: ${(e as Error).message}`);
        }
        // Progress log every 50 items so the admin can see it's working.
        if ((i + 1) % 50 === 0) {
          this.logger.log(
            `Backfill progress: ${i + 1}/${candidates.length} (${succeeded} ok, ${failed} fail)`,
          );
        }
        // Throttle: wait between items so normal user requests aren't starved.
        if (delayMs > 0 && i < candidates.length - 1) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
      this.logger.log(
        `Metadata backfill batch: ${succeeded}/${candidates.length} succeeded, ${failed} failed`,
      );
      return { processed: candidates.length, succeeded, failed, sample };
    } finally {
      this.backfillRunning = false;
    }
  }

  /**
   * The app's REAL anime signals (shared by all hydration routing): the classifier's
   * persisted verdict, the persisted TMDB `anime` keyword (id 210024 — decisive), and
   * the Animation genre (weakest fallback). NOT a genre guess.
   */
  isAnimeMedia(m: {
    contentClassification?: string | null;
    show?: { keywords?: unknown } | null;
    movie?: { keywords?: unknown } | null;
    genres?: { genre: { slug: string; name: string } }[];
  }): boolean {
    if (m.contentClassification === 'ANIME') return true;
    const kw = ((m.show?.keywords ?? m.movie?.keywords ?? []) as string[]).map((k) =>
      String(k).toLowerCase(),
    );
    if (kw.includes('anime')) return true;
    return (m.genres ?? []).some(
      (g) => g.genre.slug === 'animation' || g.genre.name.toLowerCase() === 'animation',
    );
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
   * Anime (classification verdict / anime keyword / Animation genre) is TVDB-authoritative
   * everywhere: always the anime repair (resolves the TVDB id when missing, force-hydrates
   * from TVDB, remaps structure) — TMDB only as a last resort when no TVDB id can be resolved.
   */
  private async hydrateOne(
    mediaId: string,
    externals: { provider: ExternalProvider; value: string }[],
    type: string,
    isAnime: boolean = false,
  ) {
    const tmdb = externals.find((e) => e.provider === ExternalProvider.TMDB);
    const tvdb = externals.find((e) => e.provider === ExternalProvider.THE_TVDB);
    const isShow = type === 'SHOW';

    if (isShow && isAnime) {
      // Anime → always the anime repair: resolves the TVDB id in trust order when missing,
      // force-hydrates from TVDB, remaps structure/user data. If it can't resolve an id,
      // TMDB below is the unavoidable last resort.
      const { fixed } = await this.fixAnimeShowFromTvdb(mediaId).catch(() => ({
        fixed: false,
        remapped: 0,
      }));
      if (fixed) {
        await this.meta.scheduleClassification(mediaId).catch(() => undefined);
        return;
      }
      if (tvdb) {
        await this.meta.ensureShowFullTvdb(Number(tvdb.value)).catch(() => undefined);
        await this.meta.scheduleClassification(mediaId).catch(() => undefined);
        return;
      }
    }

    // Detect existing structure: shows with ≥1 episode, movies with overview.
    const hasStructure = isShow
      ? (await this.prisma.episode.count({ where: { season: { show: { mediaId } } }, take: 1 })) > 0
      : (await this.prisma.mediaItem.count({
          where: { id: mediaId, type: 'MOVIE', overview: { not: null } },
        })) > 0;

    if (hasStructure && tvdb) {
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
   *
   * CONVERGENCE: rows whose TVDB id can't be resolved (no stored id, TMDB has no
   * cross-id, strict title+year search fails, or the cross-id is claimed by a
   * duplicate) can NEVER succeed and used to be re-attempted EVERY run (~60 rows ×
   * provider calls = 1.5h runs and hourly collisions with the overlap guard). They
   * are remembered in metadata_provenance.animeTvdbNoId ({at, stale}) and skipped
   * for 30 days — re-armed early only if their stale-row count grows (new TMDB
   * contamination). Repeat failures are strike-counted (animeTvdbFail) and skipped
   * after 5 strikes within 30 days.
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
    this.trackRepair('anime-rehydrate', {
      running: true,
      processed: 0,
      total: 0,
      succeeded: 0,
      failed: 0,
      finishedAt: null,
    });
    try {
      const noIdRearmThreshold = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      // Rows whose TVDB id recently proved unresolvable — excluded from candidates.
      // (Raw pre-query: a Prisma NOT JSON-path filter falls into SQL three-valued
      // logic and would wrongly exclude every row WITHOUT the stamp.)
      const recentlyStamped = (
        await this.prisma.$queryRaw<{ id: string }[]>`
          SELECT id FROM media_items
          WHERE COALESCE(metadata_provenance #>> '{animeTvdbNoId,at}', '') > ${noIdRearmThreshold}
        `
      ).map((r) => r.id);
      const candidates = await this.prisma.mediaItem.findMany({
        where: {
          type: 'SHOW',
          id: { notIn: recentlyStamped },
          genres: {
            some: {
              genre: {
                OR: [{ slug: 'animation' }, { name: { equals: 'Animation', mode: 'insensitive' } }],
              },
            },
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
        select: { id: true, title: true, metadataProvenance: true },
      });

      this.trackRepair('anime-rehydrate', { total: candidates.length });

      let succeeded = 0;
      let failed = 0;
      let rateLimited = 0;
      let noTvdbId = 0;
      let remapped = 0;
      const sample: string[] = [];
      for (let i = 0; i < candidates.length; i++) {
        const m = candidates[i];
        // Strike-counted failures: skip after 5 strikes within 30 days (a row that
        // throws every run otherwise burns a repair slot forever).
        const failMark = (m.metadataProvenance as any)?.animeTvdbFail;
        if (
          failMark?.count >= 5 &&
          typeof failMark.at === 'string' &&
          failMark.at > noIdRearmThreshold
        ) {
          this.trackRepair('anime-rehydrate', { processed: i + 1, succeeded, failed });
          continue;
        }
        this.trackRepair('anime-rehydrate', {
          processed: i + 1,
          succeeded,
          failed,
          current: m.title,
        });
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
            this.logger.warn(
              `Anime TVDB rehydration rate-limited after ${i} items — deferring the rest`,
            );
            break;
          }
          failed++;
          // WARN (not debug): a persistent per-row failure must be identifiable in
          // prod logs — the run report only shows the count.
          if (failed <= 10)
            this.logger.warn(
              `anime tvdb rehydration failed for "${m.title}" (${m.id}): ${(e as Error).message}`,
            );
          await this.stampAnimeTvdbFail(m.id, m.metadataProvenance as any);
        }
        if ((i + 1) % 25 === 0) {
          this.logger.log(
            `Anime TVDB rehydration progress: ${i + 1}/${candidates.length} (${succeeded} ok, ${failed} fail, ${noTvdbId} no-tvdb-id)`,
          );
        }
      }
      this.trackRepair('anime-rehydrate', {
        running: false,
        processed: candidates.length,
        succeeded,
        failed,
        finishedAt: new Date(),
      });
      this.logger.log(
        `Anime TVDB rehydration: ${succeeded}/${candidates.length} rehydrated, ${failed} failed, ${rateLimited} rate-limited, ${noTvdbId} skipped (no TVDB id / already repaired), ${remapped} episodes remapped`,
      );
      return {
        processed: candidates.length,
        succeeded,
        failed,
        rateLimited,
        noTvdbId,
        remapped,
        sample,
      };
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
    const p = this.doFixAnimeShowFromTvdb(mediaId).finally(() =>
      this.animeFixInflight.delete(mediaId),
    );
    this.animeFixInflight.set(mediaId, p);
    return p;
  }

  private async doFixAnimeShowFromTvdb(
    mediaId: string,
  ): Promise<{ fixed: boolean; remapped: number }> {
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

    // Skip when the TVDB id recently proved UNRESOLVABLE for this row — every detail
    // view / cron run would otherwise redo the cross-id lookups for a row that can't
    // succeed. Re-arms after 30 days (providers add cross-ids eventually) or early
    // when the stale count grows (new TMDB contamination to rescue).
    const noIdMark = (media.metadataProvenance as any)?.animeTvdbNoId;
    if (
      noIdMark &&
      typeof noIdMark.at === 'string' &&
      Date.now() - new Date(noIdMark.at).getTime() < 30 * 24 * 60 * 60 * 1000 &&
      (typeof noIdMark.stale !== 'number' || staleRows <= noIdMark.stale)
    ) {
      return notFixed;
    }

    const tvdbId = await this.resolveAnimeTvdbId({
      id: media.id,
      title: media.title,
      externalIds: media.externalIds as unknown as { provider: ExternalProvider; value: string }[],
      show: media.show,
    });
    if (!tvdbId) {
      await this.prisma.mediaItem.update({
        where: { id: mediaId },
        data: {
          metadataProvenance: {
            ...((media.metadataProvenance as any) ?? {}),
            animeTvdbNoId: { at: new Date().toISOString(), stale: staleRows },
          },
        },
      });
      return notFixed;
    }

    // Bypass the 24h isStale gate inside ensureShowFullTvdb — this is a forced provider
    // switch, not a routine refresh.
    await this.prisma.mediaItem.update({
      where: { id: mediaId },
      data: { metadataRefreshedAt: null },
    });
    await this.meta.ensureShowFullTvdb(tvdbId);
    const remap = await this.structureRemap.remapShow(mediaId);
    // Remember the kept-unmapped count so kept rows alone never re-arm this repair.
    // A success also clears the no-id / fail-strike marks.
    const provenance = { ...((media.metadataProvenance as any) ?? {}) } as Record<string, any>;
    delete provenance.animeTvdbNoId;
    delete provenance.animeTvdbFail;
    provenance.animeTvdbKeptUnmapped = remap.unmapped;
    await this.prisma.mediaItem.update({
      where: { id: mediaId },
      data: { metadataProvenance: provenance },
    });
    return { fixed: true, remapped: remap.mapped };
  }

  /** Strike-count a per-row repair failure (skipped after 5 strikes within 30 days). */
  private async stampAnimeTvdbFail(mediaId: string, prev: Record<string, any> | null) {
    try {
      const before = (prev?.animeTvdbFail as any) ?? {};
      await this.prisma.mediaItem.update({
        where: { id: mediaId },
        data: {
          metadataProvenance: {
            ...(prev ?? {}),
            animeTvdbFail: { at: new Date().toISOString(), count: (before.count ?? 0) + 1 },
          },
        },
      });
    } catch {
      /* best-effort marker */
    }
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
  async repairTypeMismatches(): Promise<{
    processed: number;
    repaired: number;
    skipped: number;
    failed: number;
  }> {
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
        this.prisma.watchHistory.deleteMany({
          where: { mediaType: 'MOVIE', media: { type: 'SHOW' } },
        }),
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
          this.logger.warn(
            `type mismatch repair failed for ${m.title} (${m.id}): ${(e as Error).message}`,
          );
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
    externalIds: {
      provider: ExternalProvider;
      providerEntityKind: ProviderEntityKind;
      value: string;
    }[],
  ): Promise<boolean> {
    const isMovieRow = type === MediaType.MOVIE;
    // The cross-type entity's identity: the external id whose KIND matches the stray
    // structure (SERIES id on a MOVIE row, MOVIE id on a SHOW row).
    const strayKind = isMovieRow ? ProviderEntityKind.SERIES : ProviderEntityKind.MOVIE;
    const ownKind = isMovieRow ? ProviderEntityKind.MOVIE : ProviderEntityKind.SERIES;
    const strayExt =
      externalIds.find(
        (e) => e.provider === ExternalProvider.THE_TVDB && e.providerEntityKind === strayKind,
      ) ??
      externalIds.find(
        (e) => e.provider === ExternalProvider.TMDB && e.providerEntityKind === strayKind,
      );
    const ownExt =
      externalIds.find(
        (e) => e.provider === ExternalProvider.TMDB && e.providerEntityKind === ownKind,
      ) ??
      externalIds.find(
        (e) => e.provider === ExternalProvider.THE_TVDB && e.providerEntityKind === ownKind,
      );

    if (!strayExt) {
      // No identity to rebuild the cross-type entity from: remove the stray structural
      // row only when it carries NO episodes with user data.
      if (isMovieRow && (await this.strayShowHasUserData(mediaId))) return false;
      await this.deleteStrayStructure(mediaId, isMovieRow);
      this.logger.log(
        `type mismatch: removed stray structure on ${title} (${mediaId}) — no cross-type id`,
      );
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
      await this.prisma.mediaItem.update({
        where: { id: mediaId },
        data: { metadataRefreshedAt: null },
      });
      if (ownExt) {
        if (isMovieRow) {
          if (ownExt.provider === ExternalProvider.TMDB)
            await this.meta.ensureMovieFull(Number(ownExt.value));
          else await this.meta.ensureMovieFullTvdb(Number(ownExt.value));
        } else {
          if (ownExt.provider === ExternalProvider.TMDB)
            await this.meta.ensureShowFull(Number(ownExt.value));
          else await this.meta.ensureShowFullTvdb(Number(ownExt.value));
        }
      }
      this.logger.log(
        `type mismatch: split ${title} (${mediaId}) — cross-type entity is ${newEntityId}`,
      );
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
    this.trackRepair('character-ids', {
      running: true,
      processed: 0,
      total: 0,
      succeeded: 0,
      failed: 0,
      finishedAt: null,
    });
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
          externalIds: {
            where: { provider: ExternalProvider.THE_TVDB },
            take: 1,
            select: { value: true },
          },
        },
      });

      this.trackRepair('character-ids', { total: candidates.length });

      let succeeded = 0;
      let failed = 0;
      let rateLimited = 0;
      const sample: string[] = [];
      for (let i = 0; i < candidates.length; i++) {
        const m = candidates[i];
        this.trackRepair('character-ids', {
          processed: i + 1,
          succeeded,
          failed,
          current: m.title,
        });
        try {
          // Bypass the 24h isStale gate — the cast rewrite only happens on a full refresh.
          await this.prisma.mediaItem.update({
            where: { id: m.id },
            data: { metadataRefreshedAt: null },
          });
          // skipClassification: this is a cast-only refresh — re-enqueueing anime
          // classification for every backfilled show saturates Kitsu/Jikan for nothing.
          await this.meta.ensureShowFullTvdb(Number(m.externalIds[0].value), undefined, {
            skipClassification: true,
          });
          succeeded++;
          if (sample.length < 5) sample.push(m.title);
        } catch (e) {
          if (this.isRateLimitError(e)) {
            rateLimited++;
            this.logger.warn(
              `Character-id backfill rate-limited after ${i} shows — deferring the rest`,
            );
            break;
          }
          failed++;
          this.logger.debug(`character-id backfill failed for ${m.title}: ${(e as Error).message}`);
        }
        if ((i + 1) % 25 === 0) {
          this.logger.log(
            `Character-id backfill progress: ${i + 1}/${candidates.length} (${succeeded} ok, ${failed} fail)`,
          );
        }
      }
      this.trackRepair('character-ids', {
        running: false,
        processed: candidates.length,
        succeeded,
        failed,
        finishedAt: new Date(),
      });
      this.logger.log(
        `Character-id backfill: ${succeeded}/${candidates.length} rehydrated, ${failed} failed, ${rateLimited} rate-limited`,
      );
      return { processed: candidates.length, succeeded, failed, rateLimited, sample };
    } finally {
      this.charIdFixRunning = false;
    }
  }

  // ---- Rating backfill ----
  private ratingFixRunning = false;

  /**
   * Fill `media_items.rating` for rows that have none — mostly TVDB-hydrated shows
   * (anime/animation): TVDB exposes no public 0–10 rating (its `score` is a
   * popularity rank), so their rows are born unrated. Ratings come from TMDB:
   *  - row has a TMDB id → ONE light `/tv|movie/{id}` call (vote_average);
   *  - TVDB-only row → TMDB `/find?external_source=tvdb_id` (authoritative, same
   *    chain the import matcher trusts) → light base call; no match → IMDB id from
   *    the TVDB extended record → `/find?external_source=imdb_id` → light base call.
   * The cross-id is only READ (never attached). Rows the source genuinely has no
   * rating for are remembered in metadata_provenance.ratingCheckedAt and skipped
   * for 90 days so the nightly job drains instead of re-checking forever.
   * Most-popular first, rate-limit early stop. User data untouched.
   */
  async backfillRatings(limit?: number): Promise<{
    processed: number;
    succeeded: number;
    failed: number;
    rateLimited: number;
    noneAtSource: number;
    sample: string[];
  }> {
    const empty = {
      processed: 0,
      succeeded: 0,
      failed: 0,
      rateLimited: 0,
      noneAtSource: 0,
      sample: [] as string[],
    };
    if (this.ratingFixRunning) {
      this.logger.log('Rating backfill already running — skipping');
      return empty;
    }
    this.ratingFixRunning = true;
    this.trackRepair('ratings', {
      running: true,
      processed: 0,
      total: 0,
      succeeded: 0,
      failed: 0,
      finishedAt: null,
    });
    try {
      const take = Math.max(1, Math.min(limit ?? 500, 100000));
      const candidates = await this.prisma.$queryRaw<
        { id: string; title: string; type: MediaType; tmdb_id: string | null; tvdb_id: string | null }[]
      >`
        SELECT m.id, m.title, m.type,
          (SELECT e.value FROM external_ids e WHERE e.media_id = m.id AND e.provider = 'TMDB'
             AND e.provider_entity_kind = (CASE WHEN m.type = 'SHOW' THEN 'SERIES' ELSE 'MOVIE' END)::"ProviderEntityKind"
             LIMIT 1) AS tmdb_id,
          (SELECT e.value FROM external_ids e WHERE e.media_id = m.id AND e.provider = 'THE_TVDB'
             AND e.provider_entity_kind = (CASE WHEN m.type = 'SHOW' THEN 'SERIES' ELSE 'MOVIE' END)::"ProviderEntityKind"
             LIMIT 1) AS tvdb_id
        FROM media_items m
        WHERE m.rating IS NULL
          AND EXISTS (SELECT 1 FROM external_ids e WHERE e.media_id = m.id AND e.provider IN ('TMDB','THE_TVDB'))
          AND (m.metadata_provenance->>'ratingCheckedAt' IS NULL
               OR (m.metadata_provenance->>'ratingCheckedAt')::timestamptz < NOW() - INTERVAL '90 days')
        ORDER BY m.popularity DESC
        LIMIT ${take}
      `;

      this.trackRepair('ratings', { total: candidates.length });

      let succeeded = 0;
      let failed = 0;
      let rateLimited = 0;
      let noneAtSource = 0;
      const sample: string[] = [];
      for (let i = 0; i < candidates.length; i++) {
        const m = candidates[i];
        this.trackRepair('ratings', {
          processed: i + 1,
          succeeded,
          failed,
          current: m.title,
        });
        try {
          let rating: number | null = null;
          // Resolve the TMDB id: stored external id, else the authoritative
          // cross-id chain (tvdb_id find → imdb_id find via TVDB extended).
          let tmdbId = m.tmdb_id ? Number(m.tmdb_id) : null;
          if (this.tmdbProvider.enabled) {
            if (!tmdbId && m.tvdb_id) {
              const found = await this.tmdbProvider.findByExternalId(m.tvdb_id, 'tvdb_id');
              tmdbId = (m.type === MediaType.SHOW ? found?.show?.tmdbId : found?.movie?.tmdbId) ?? null;
              if (!tmdbId && this.tvdb.enabled) {
                const imdbId = await this.tvdb.fetchImdbId(
                  m.type === MediaType.SHOW ? 'show' : 'movie',
                  Number(m.tvdb_id),
                );
                if (imdbId) {
                  const foundImdb = await this.tmdbProvider.findByExternalId(imdbId, 'imdb_id');
                  tmdbId =
                    (m.type === MediaType.SHOW
                      ? foundImdb?.show?.tmdbId
                      : foundImdb?.movie?.tmdbId) ?? null;
                }
              }
            }
            if (tmdbId) {
              const base =
                m.type === MediaType.SHOW
                  ? await this.tmdbProvider.localizedShowBase(tmdbId, 'en-US')
                  : await this.tmdbProvider.localizedMovieBase(tmdbId, 'en-US');
              rating = base.rating ?? null;
            }
          }
          if (rating != null && rating > 0) {
            await this.prisma.mediaItem.update({ where: { id: m.id }, data: { rating } });
            succeeded++;
            if (sample.length < 5) sample.push(`${m.title} (${rating.toFixed(1)})`);
          } else {
            noneAtSource++;
            // Stamp ONLY definitive no-rating-at-source answers (a TMDB entity was
            // resolved and carried no vote average). findByExternalId swallows
            // errors into null, so an unresolved cross-id may just be a throttle
            // wave — stamping those would wrongly skip them for 90 days.
            if (tmdbId) {
              await this.prisma.$executeRaw`
                UPDATE media_items
                SET metadata_provenance = jsonb_set(
                      COALESCE(metadata_provenance, '{}'::jsonb),
                      '{ratingCheckedAt}', to_jsonb(NOW()::text))
                WHERE id = ${m.id}`;
            }
          }
        } catch (e) {
          if (this.isRateLimitError(e)) {
            rateLimited++;
            this.logger.warn(`Rating backfill rate-limited after ${i} rows — deferring the rest`);
            break;
          }
          failed++;
          if (failed <= 10)
            this.logger.warn(`rating backfill failed for ${m.title}: ${(e as Error).message}`);
        }
        if ((i + 1) % 50 === 0) {
          this.logger.log(
            `Rating backfill progress: ${i + 1}/${candidates.length} (${succeeded} ok, ${noneAtSource} none-at-source, ${failed} fail)`,
          );
        }
      }
      this.trackRepair('ratings', {
        running: false,
        processed: candidates.length,
        succeeded,
        failed,
        finishedAt: new Date(),
      });
      this.logger.log(
        `Rating backfill: ${succeeded}/${candidates.length} rated, ${noneAtSource} none-at-source, ${failed} failed, ${rateLimited} rate-limited`,
      );
      return { processed: candidates.length, succeeded, failed, rateLimited, noneAtSource, sample };
    } finally {
      this.ratingFixRunning = false;
    }
  }

  // ---- TVDB id conflicts (multi-id rows) ----
  private tvdbIdFixRunning = false;

  /**
   * Repair rows carrying MORE THAN ONE TVDB id (same entity kind). Two cases:
   *  - Merge leftovers: every id maps to the SAME TMDB entity → benign, kept as-is.
   *  - Id poisoning (the old title-attach bug): ids map to DIFFERENT TMDB entities →
   *    the id matching the row's own TMDB id stays, the others are DETACHED.
   * Rows where no decisive id can be picked are reported as ambiguous (never guessed).
   * NON-DESTRUCTIVE for user data: detaching an external id never deletes history —
   * it only stops future lookups from resolving to the wrong row.
   */
  async repairTvdbIdConflicts(limit?: number): Promise<{
    processed: number;
    mergedKept: number;
    conflictsFixed: number;
    idsDetached: number;
    ambiguous: {
      mediaId: string;
      title: string;
      ids: string[];
      mapped: Record<string, number | null>;
    }[];
  }> {
    const empty = {
      processed: 0,
      mergedKept: 0,
      conflictsFixed: 0,
      idsDetached: 0,
      ambiguous: [] as any[],
    };
    if (this.tvdbIdFixRunning) {
      this.logger.log('TVDB-id conflict repair already running — skipping');
      return empty;
    }
    if (!this.tmdbProvider.enabled) {
      this.logger.warn('TMDB not configured — skipping TVDB-id conflict repair');
      return empty;
    }
    this.tvdbIdFixRunning = true;
    this.trackRepair('tvdb-id-conflicts', {
      running: true,
      processed: 0,
      total: 0,
      succeeded: 0,
      failed: 0,
      finishedAt: null,
    });
    try {
      const rows = await this.prisma.$queryRaw<
        {
          mediaId: string;
          title: string;
          type: string;
          kind: string;
          ids: string[];
          tmdb: string | null;
        }[]
      >`
        SELECT e.media_id AS "mediaId", m.title, m.type, e.provider_entity_kind AS kind,
               array_agg(e.value) AS ids,
               (SELECT value FROM external_ids t
                WHERE t.media_id = e.media_id AND t.provider = 'TMDB' AND t.provider_entity_kind = e.provider_entity_kind
                LIMIT 1) AS tmdb
        FROM external_ids e
        JOIN media_items m ON m.id = e.media_id
        WHERE e.provider = 'THE_TVDB'
        GROUP BY e.media_id, m.title, m.type, e.provider_entity_kind
        HAVING count(*) > 1
        ORDER BY m.title
        LIMIT ${Math.max(1, Math.min(limit ?? 500, 100000))}
      `;
      this.trackRepair('tvdb-id-conflicts', { total: rows.length });

      let mergedKept = 0;
      let conflictsFixed = 0;
      let idsDetached = 0;
      const ambiguous: any[] = [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        this.trackRepair('tvdb-id-conflicts', {
          processed: i + 1,
          succeeded: conflictsFixed,
          failed: ambiguous.length,
          current: row.title,
        });
        try {
          const mapped: Record<string, number | null> = {};
          for (const id of row.ids) {
            const found = await this.tmdbProvider.findByExternalId(id, 'tvdb_id').catch(() => null);
            // Whatever the id maps to (a poisoned id may even map cross-type).
            mapped[id] = found?.show?.tmdbId ?? found?.movie?.tmdbId ?? null;
          }
          const distinct = [
            ...new Set(Object.values(mapped).filter((v): v is number => v != null)),
          ];
          if (distinct.length <= 1) {
            mergedKept++; // merge leftovers (or unverifiable-but-uniform) — benign
            continue;
          }
          // Poison: pick the id whose mapped TMDB entity equals the row's own TMDB id.
          const rowTmdb = row.tmdb ? Number(row.tmdb) : null;
          const keep = rowTmdb != null ? row.ids.find((id) => mapped[id] === rowTmdb) : undefined;
          if (!keep) {
            ambiguous.push({ mediaId: row.mediaId, title: row.title, ids: row.ids, mapped });
            continue;
          }
          const bad = row.ids.filter((id) => id !== keep);
          await this.prisma.externalId.deleteMany({
            where: {
              mediaId: row.mediaId,
              provider: 'THE_TVDB',
              providerEntityKind: row.kind as any,
              value: { in: bad },
            },
          });
          conflictsFixed++;
          idsDetached += bad.length;
          this.logger.log(
            `TVDB-id conflict repaired for "${row.title}" (${row.mediaId}): kept ${keep}, detached ${bad.join(', ')}`,
          );
        } catch (e) {
          this.logger.warn(
            `TVDB-id conflict check failed for "${row.title}": ${(e as Error).message}`,
          );
        }
      }
      this.trackRepair('tvdb-id-conflicts', {
        running: false,
        processed: rows.length,
        succeeded: conflictsFixed,
        failed: ambiguous.length,
        finishedAt: new Date(),
      });
      this.logger.log(
        `TVDB-id conflict repair: ${rows.length} rows checked — ${mergedKept} merge-leftover kept, ${conflictsFixed} conflicts fixed (${idsDetached} ids detached), ${ambiguous.length} ambiguous`,
      );
      return { processed: rows.length, mergedKept, conflictsFixed, idsDetached, ambiguous };
    } finally {
      this.tvdbIdFixRunning = false;
    }
  }

  // ---- Non-English base titles ----
  private enBaseFixRunning = false;

  /**
   * Restore a trusted ENGLISH base for rows whose base/override was written in the wrong
   * language (older contaminations: title_locale != 'en', or a missing/wrong 'en' slot).
   * Strategy: clear metadataRefreshedAt and run the standard hydration — persistShow/
   * persistMovie rewrite the English base and the 'en' override from the provider.
   * TMDB id wins when both exist (richer payloads); TVDB is the fallback for TVDB-only rows.
   */
  async repairNonEnglishBase(limit?: number): Promise<{
    processed: number;
    succeeded: number;
    failed: number;
    sample: string[];
  }> {
    const empty = { processed: 0, succeeded: 0, failed: 0, sample: [] as string[] };
    if (this.enBaseFixRunning) {
      this.logger.log('Non-English base repair already running — skipping');
      return empty;
    }
    this.enBaseFixRunning = true;
    this.trackRepair('english-base', {
      running: true,
      processed: 0,
      total: 0,
      succeeded: 0,
      failed: 0,
      finishedAt: null,
    });
    try {
      const candidates = await this.prisma.mediaItem.findMany({
        where: {
          AND: [{ titleLocale: { not: 'en' } }, { titleLocale: { not: null } }],
          externalIds: { some: {} },
        },
        orderBy: { id: 'asc' },
        take: Math.max(1, Math.min(limit ?? 200, 100000)),
        select: {
          id: true,
          title: true,
          type: true,
          contentClassification: true,
          show: { select: { keywords: true } },
          movie: { select: { keywords: true } },
          externalIds: { select: { provider: true, value: true, providerEntityKind: true } },
          genres: { select: { genre: { select: { slug: true, name: true } } } },
        },
      });

      this.trackRepair('english-base', { total: candidates.length });

      // Anime routing — the app's REAL signals (shared `isAnimeMedia`), not a genre guess.
      let succeeded = 0;
      let failed = 0;
      const sample: string[] = [];
      for (let i = 0; i < candidates.length; i++) {
        const m = candidates[i];
        this.trackRepair('english-base', {
          processed: i + 1,
          succeeded,
          failed,
          current: m.title,
        });
        try {
          await this.forceEnglishRehydrate(m);
          succeeded++;
          if (sample.length < 5) sample.push(m.title);
        } catch (e) {
          failed++;
          this.logger.debug(
            `non-English base repair failed for "${m.title}": ${(e as Error).message}`,
          );
        }
        if ((i + 1) % 25 === 0) {
          this.logger.log(
            `Non-English base repair progress: ${i + 1}/${candidates.length} (${succeeded} ok, ${failed} fail)`,
          );
        }
      }
      this.trackRepair('english-base', {
        running: false,
        processed: candidates.length,
        succeeded,
        failed,
        finishedAt: new Date(),
      });
      this.logger.log(
        `Non-English base repair: ${succeeded}/${candidates.length} re-hydrated with English base, ${failed} failed`,
      );
      return { processed: candidates.length, succeeded, failed, sample };
    } finally {
      this.enBaseFixRunning = false;
    }
  }

  /**
   * Force a full re-hydration that rewrites the English base (+ 'en' override slot).
   * Shared by the marker-driven and content-driven English-base repairs.
   * Source rules: ANIME (classifier verdict / anime keyword / Animation genre) is
   * TVDB-authoritative (TMDB anime structures are wrong; it never refreshes from TMDB).
   * Everything else is TMDB-first, TVDB fallback for TVDB-only rows.
   */
  private async forceEnglishRehydrate(m: {
    id: string;
    type: string;
    contentClassification?: string | null;
    show?: { keywords?: unknown } | null;
    movie?: { keywords?: unknown } | null;
    externalIds: { provider: string; value: string; providerEntityKind: string }[];
    genres?: { genre: { slug: string; name: string } }[];
  }): Promise<void> {
    // Clear the freshness stamp so the standard hydration path runs a full re-fetch.
    await this.prisma.mediaItem.update({
      where: { id: m.id },
      data: { metadataRefreshedAt: null },
    });
    const tmdbExt = m.externalIds.find(
      (e) => e.provider === 'TMDB' && e.providerEntityKind !== 'EPISODE',
    );
    const tvdbExt = m.externalIds.find((e) => e.provider === 'THE_TVDB');
    if (this.isAnimeMedia(m)) {
      if (tvdbExt) {
        await this.meta.ensureShowFullTvdb(Number(tvdbExt.value));
      } else {
        // No TVDB id yet: the anime repair resolves it (cross-id → strict title+year),
        // force-hydrates from TVDB and remaps the structure.
        await this.fixAnimeShowFromTvdb(m.id);
      }
    } else if (tmdbExt) {
      if (m.type === 'SHOW') await this.meta.ensureShowFull(Number(tmdbExt.value));
      else await this.meta.ensureMovieFull(Number(tmdbExt.value));
    } else if (tvdbExt) {
      if (m.type === 'SHOW') await this.meta.ensureShowFullTvdb(Number(tvdbExt.value));
      else await this.meta.ensureMovieFullTvdb(Number(tvdbExt.value));
    } else {
      throw new Error('no external ids to hydrate from');
    }
    // The title just changed language: every user with watch history on this row has a
    // stats snapshot (marathons/genres/networks) baked with the OLD title — mark those
    // snapshots stale so the next profile view recomputes them (SWR). Without this the
    // repair is invisible on profile pages until the user's next watch action.
    await this.prisma.$executeRaw`
      UPDATE user_stats_summary s
      SET stale = true
      WHERE EXISTS (
        SELECT 1 FROM watch_history h WHERE h.user_id = s.user_id AND h.media_id = ${m.id}
      )`;
  }

  // ---- Non-English CONTENT (wrong-language base with a lying or missing marker) ----
  private enContentFixRunning = false;

  /** The title an English user SEES: the 'en' override slot first, then the base column. */
  private englishVisibleTitle(m: { title: string; titles?: unknown }): string {
    const t = m.titles;
    const en = t && typeof t === 'object' ? (t as Record<string, unknown>).en : undefined;
    return typeof en === 'string' && en.trim() ? en.trim() : m.title;
  }

  /** Loose title comparison: case/space/quote-insensitive (punctuation variants are the
   *  same title — anything stricter would flag false mismatches). */
  private normTitleForCompare(s: string): string {
    return s.trim().toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ');
  }

  /** The provider's canonical English title in ONE light call (TMDB localized base /
   *  TVDB English payload). null = unverifiable right now (no ids, provider down). */
  private async resolveProviderEnglishTitle(m: {
    type: string;
    externalIds: { provider: string; value: string; providerEntityKind: string }[];
  }): Promise<string | null> {
    const tmdbExt = m.externalIds.find(
      (e) => e.provider === 'TMDB' && e.providerEntityKind !== 'EPISODE',
    );
    if (tmdbExt && this.tmdbProvider.enabled) {
      const base =
        m.type === 'SHOW'
          ? await this.tmdbProvider.localizedShowBase(Number(tmdbExt.value), 'en-US')
          : await this.tmdbProvider.localizedMovieBase(Number(tmdbExt.value), 'en-US');
      return base?.title?.trim() || null;
    }
    const tvdbExt = m.externalIds.find((e) => e.provider === 'THE_TVDB');
    if (tvdbExt && this.tvdb.enabled) {
      const d =
        m.type === 'SHOW'
          ? await this.tvdb.getShow(Number(tvdbExt.value), 'en')
          : await this.tvdb.getMovie(Number(tvdbExt.value), 'en');
      return d?.title?.trim() || null;
    }
    return null;
  }

  /**
   * Content-based English repair — the blind spot of the marker stat: rows whose base
   * title is the WRONG language even though title_locale says 'en' (or is unset). This
   * is what English users actually complain about.
   *
   * Normal mode scans SUSPECTS (the English-visible title contains non-ASCII),
   * most-popular first — what users actually see gets verified first. Deep mode verifies
   * EVERY row with external ids — the only way to catch wrong-language titles that are
   * pure ASCII (e.g. Italian) — paging the catalog with a wrapping Redis id-cursor.
   *
   * CONVERGENCE: a row verified as already-English is remembered
   * (metadata_provenance.enContentVerifiedTitle) and skipped until its English-visible
   * title changes — legit non-ASCII titles (Pokémon) are verified ONCE, not every run,
   * and new/changed contamination re-enters the pool automatically. Every candidate is
   * VERIFIED against the provider's canonical English title; only real mismatches are
   * re-hydrated. User data untouched.
   */
  async repairNonEnglishContent(
    limit?: number,
    deep?: boolean,
  ): Promise<{
    processed: number;
    verified: number;
    fixed: number;
    failed: number;
    sample: string[];
  }> {
    const empty = { processed: 0, verified: 0, fixed: 0, failed: 0, sample: [] as string[] };
    if (this.enContentFixRunning) {
      this.logger.log('English-content repair already running — skipping');
      return empty;
    }
    this.enContentFixRunning = true;
    this.trackRepair('english-content', {
      running: true,
      processed: 0,
      total: 0,
      succeeded: 0,
      failed: 0,
      finishedAt: null,
    });
    try {
      const take = Math.max(1, Math.min(limit ?? 200, 100000));
      let ids: { id: string }[];
      if (deep) {
        const cursorKey = 'EN_CONTENT_DEEP_CURSOR';
        const cursor = (await this.redis.get<string>(cursorKey)) ?? '';
        ids = await this.prisma.$queryRaw<{ id: string }[]>`
          SELECT m.id FROM media_items m
          WHERE m.id > ${cursor}
            AND EXISTS (SELECT 1 FROM external_ids e WHERE e.media_id = m.id)
            AND COALESCE(NULLIF(m.titles->>'en',''), m.title)
                  IS DISTINCT FROM m.metadata_provenance->>'enContentVerifiedTitle'
          ORDER BY m.id
          LIMIT ${take}`;
        // End of the catalog reached → next deep run wraps to the beginning.
        await this.redis.set(
          cursorKey,
          ids.length < take ? '' : (ids[ids.length - 1]?.id ?? cursor),
          86400 * 30,
        );
      } else {
        // Suspects, most-popular first. No cursor: verified (remembered) and fixed rows
        // leave the pool, so every run advances through NEW suspects only.
        ids = await this.prisma.$queryRaw<{ id: string }[]>`
          SELECT m.id FROM media_items m
          WHERE COALESCE(NULLIF(m.titles->>'en',''), m.title) ~ '[^ -~]'
            AND EXISTS (SELECT 1 FROM external_ids e WHERE e.media_id = m.id)
            AND COALESCE(NULLIF(m.titles->>'en',''), m.title)
                  IS DISTINCT FROM m.metadata_provenance->>'enContentVerifiedTitle'
          ORDER BY m.popularity DESC, m.id
          LIMIT ${take}`;
      }
      if (ids.length === 0) {
        this.trackRepair('english-content', {
          running: false,
          processed: 0,
          total: 0,
          succeeded: 0,
          failed: 0,
          finishedAt: new Date(),
        });
        return empty;
      }
      const candidates = await this.prisma.mediaItem.findMany({
        where: { id: { in: ids.map((r) => r.id) } },
        select: {
          id: true,
          title: true,
          titles: true,
          type: true,
          contentClassification: true,
          show: { select: { keywords: true } },
          movie: { select: { keywords: true } },
          externalIds: { select: { provider: true, value: true, providerEntityKind: true } },
          genres: { select: { genre: { select: { slug: true, name: true } } } },
        },
      });
      // Process in the SELECT's order (popularity for suspects, id for deep) —
      // findMany doesn't preserve the IN order.
      const order = new Map(ids.map((r, idx) => [r.id, idx]));
      candidates.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
      this.trackRepair('english-content', { total: candidates.length });

      let verified = 0;
      let fixed = 0;
      let failed = 0;
      const sample: string[] = [];
      for (let i = 0; i < candidates.length; i++) {
        const m = candidates[i];
        this.trackRepair('english-content', {
          processed: i + 1,
          succeeded: fixed,
          failed,
          current: m.title,
        });
        try {
          const providerTitle = await this.resolveProviderEnglishTitle(m);
          if (!providerTitle) {
            failed++; // unverifiable right now — never guess
            if (failed <= 10)
              this.logger.warn(
                `English-content verify: no provider English title for "${m.title}" (${m.id}) — providers: ${m.externalIds.map((e) => e.provider).join(',') || 'none'}`,
              );
            continue;
          }
          const visible = this.englishVisibleTitle(m);
          if (this.normTitleForCompare(providerTitle) === this.normTitleForCompare(visible)) {
            verified++;
            // Remember the verified title: the row leaves the suspect pool until its
            // English-visible title changes (new contamination re-arms it). This is what
            // makes repeated runs converge instead of re-verifying Pokémon forever.
            await this.prisma.$executeRaw`
              UPDATE media_items
              SET metadata_provenance = COALESCE(metadata_provenance, '{}'::jsonb)
                    || jsonb_build_object('enContentVerifiedTitle', ${visible}::text,
                                          'enContentVerifiedAt', ${new Date().toISOString()}::text)
              WHERE id = ${m.id}`;
            continue;
          }
          await this.forceEnglishRehydrate(m);
          fixed++;
          if (sample.length < 5) sample.push(`${m.title} → ${providerTitle}`);
        } catch (e) {
          failed++;
          // First failures are WARN-visible (prod runs at info level); the rest stay debug.
          if (failed <= 10)
            this.logger.warn(
              `English-content repair failed for "${m.title}" (${m.id}): ${(e as Error).message}`,
            );
          else
            this.logger.debug(
              `English-content repair failed for "${m.title}": ${(e as Error).message}`,
            );
        }
        if ((i + 1) % 25 === 0) {
          this.logger.log(
            `English-content repair progress: ${i + 1}/${candidates.length} (${verified} already ok, ${fixed} fixed, ${failed} failed)`,
          );
        }
      }
      this.trackRepair('english-content', {
        running: false,
        processed: candidates.length,
        succeeded: fixed,
        failed,
        finishedAt: new Date(),
      });
      this.logger.log(
        `English-content repair: ${candidates.length} checked — ${verified} already English, ${fixed} re-hydrated, ${failed} failed`,
      );
      return { processed: candidates.length, verified, fixed, failed, sample };
    } finally {
      this.enContentFixRunning = false;
    }
  }

  // ---- TVDB banner-as-poster rows (legacy of the swapped series artwork mapping) ----
  private bannerFixRunning = false;

  /**
   * Rehydrate rows whose POSTER is a TVDB banner (wide artwork in a poster slot) — the
   * old swapped series artwork mapping (type 1=banner taken as poster) wrote
   * `/banners/<file>` URLs into poster_url. The corrected TVDB mapper re-picks
   * poster=type 2 / backdrop=type 3, so a standard TVDB rehydration repairs the images.
   * Most-popular first; one TVDB call per row; stops early on TVDB rate limits.
   * User data untouched.
   */
  async repairBannerPosters(limit?: number): Promise<{
    processed: number;
    succeeded: number;
    failed: number;
    sample: string[];
  }> {
    const empty = { processed: 0, succeeded: 0, failed: 0, sample: [] as string[] };
    if (this.bannerFixRunning) {
      this.logger.log('Banner-poster repair already running — skipping');
      return empty;
    }
    this.bannerFixRunning = true;
    this.trackRepair('banner-posters', {
      running: true,
      processed: 0,
      total: 0,
      succeeded: 0,
      failed: 0,
      finishedAt: null,
    });
    try {
      const take = Math.max(1, Math.min(limit ?? 500, 100000));
      const candidates = await this.prisma.$queryRaw<
        { id: string; title: string; type: string; tvdb: string }[]
      >`
        SELECT m.id, m.title, m.type,
               (SELECT e.value FROM external_ids e
                 WHERE e.media_id = m.id AND e.provider = 'THE_TVDB'
                 ORDER BY e.value LIMIT 1) AS tvdb
        FROM media_items m
        WHERE m.poster_url ~ '/banners/[^/]+$'
          AND EXISTS (SELECT 1 FROM external_ids e WHERE e.media_id = m.id AND e.provider = 'THE_TVDB')
        ORDER BY m.popularity DESC, m.id
        LIMIT ${take}`;
      this.trackRepair('banner-posters', { total: candidates.length });

      let succeeded = 0;
      let failed = 0;
      const sample: string[] = [];
      for (let i = 0; i < candidates.length; i++) {
        const m = candidates[i];
        this.trackRepair('banner-posters', {
          processed: i + 1,
          succeeded,
          failed,
          current: m.title,
        });
        try {
          // Clear the freshness stamp so the TVDB rehydration actually re-fetches
          // (and re-picks artworks with the fixed mapper).
          await this.prisma.mediaItem.update({
            where: { id: m.id },
            data: { metadataRefreshedAt: null },
          });
          if (m.type === 'SHOW') await this.meta.ensureShowFullTvdb(Number(m.tvdb));
          else await this.meta.ensureMovieFullTvdb(Number(m.tvdb));
          succeeded++;
          if (sample.length < 5) sample.push(m.title);
        } catch (e) {
          if (this.isRateLimitError(e)) {
            this.logger.warn(
              `Banner-poster repair: TVDB rate limit at ${i + 1}/${candidates.length} — stopping early (${succeeded} fixed, ${failed} failed)`,
            );
            break;
          }
          failed++;
          if (failed <= 10)
            this.logger.warn(
              `Banner-poster repair failed for "${m.title}" (${m.id}): ${(e as Error).message}`,
            );
          else
            this.logger.debug(
              `Banner-poster repair failed for "${m.title}": ${(e as Error).message}`,
            );
        }
      }
      this.trackRepair('banner-posters', {
        running: false,
        processed: succeeded + failed,
        succeeded,
        failed,
        finishedAt: new Date(),
      });
      this.logger.log(
        `Banner-poster repair: ${succeeded}/${candidates.length} re-hydrated from TVDB with corrected artworks, ${failed} failed`,
      );
      return { processed: succeeded + failed, succeeded, failed, sample };
    } finally {
      this.bannerFixRunning = false;
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
    const startDate_ =
      startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate)
        ? new Date(`${startDate}T00:00:00Z`)
        : lastRunStr
          ? new Date(lastRunStr)
          : new Date(Date.now() - 1000 * 60 * 60 * 24 * 14);
    const endDate = new Date();
    const fmt = (d: Date) => d.toISOString().slice(0, 10);

    this.logger.log(
      `TMDB changes sync: ${fmt(startDate_)} → ${fmt(endDate)}${startDate ? ' (custom range)' : ''}`,
    );

    // Fetch ALL changed IDs from TMDB (fully paginated).
    const tvIds = await this.fetchChangedIds('tv', fmt(startDate_), fmt(endDate));
    const movieIds = await this.fetchChangedIds('movie', fmt(startDate_), fmt(endDate));
    const allIds = [...tvIds, ...movieIds];
    this.logger.log(
      `TMDB changes: ${tvIds.length} TV + ${movieIds.length} movie = ${allIds.length} total changed IDs`,
    );

    // Store the end date so the next run starts from here — EXCEPT for custom-range
    // one-offs, which must never disturb the daily progression.
    if (!startDate) {
      await this.redis.set('TMDB_CHANGES_LAST_RUN', endDate.toISOString(), 86400 * 30);
    }

    if (allIds.length === 0)
      return { tvChanged: 0, movieChanged: 0, matched: 0, hydrated: 0, failed: 0, skippedAnime: 0 };

    // Match against our DB in chunks (PostgreSQL has a 32767 bind-variable limit).
    const matched: {
      mediaId: string;
      value: string;
      media: { type: string; externalIds: any[] };
    }[] = [];
    const CHUNK = 5000;
    for (let i = 0; i < allIds.length; i += CHUNK) {
      const chunk = allIds.slice(i, i + CHUNK).map(String);
      const rows = await this.prisma.externalId.findMany({
        where: { provider: ExternalProvider.TMDB, value: { in: chunk } },
        select: {
          mediaId: true,
          value: true,
          media: { select: { type: true, externalIds: true } },
        },
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
          some: {
            genre: {
              OR: [{ slug: 'animation' }, { name: { equals: 'Animation', mode: 'insensitive' } }],
            },
          },
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
        this.logger.debug(
          `TMDB changes re-hydration failed for ${m.value}: ${(e as Error).message}`,
        );
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
  private async fetchChangedIds(
    type: 'tv' | 'movie',
    startDate: string,
    endDate: string,
  ): Promise<number[]> {
    const ids: number[] = [];
    let page = 1;
    let totalPages = 1;
    while (page <= totalPages) {
      try {
        const res = await this.tmdb.get<any>(`/${type}/changes`, {
          start_date: startDate,
          end_date: endDate,
          page,
        });
        const results = Array.isArray(res?.results) ? res.results : [];
        if (results.length === 0) break;
        ids.push(...results.map((r: any) => Number(r.id)).filter(Number.isFinite));
        totalPages = res?.total_pages ?? 1;
        page++;
      } catch (e) {
        this.logger.debug(
          `TMDB changes fetch failed (page ${page}, ${type}): ${(e as Error).message}`,
        );
        break;
      }
    }
    return ids;
  }
}
