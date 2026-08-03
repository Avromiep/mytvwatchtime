import { Injectable, Logger } from '@nestjs/common';
import {
  ExternalProvider,
  MediaType,
  ProviderEntityKind,
  type SupportedLocale,
} from '@tvwatch/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { runInLanguage, currentLanguage } from '../../common/language.context';
import { MediaMetadataService } from '../../media-metadata/media-metadata.service';
import { TmdbProvider } from '../../media-metadata/providers/tmdb.provider';
import { TvdbProvider } from '../../media-metadata/providers/tvdb.provider';
import { normTitle, normalizeNumericExternalId } from './inference';
import { isAnimeSignal } from '../../media-metadata/classification/anime-signal';
import { isProviderError } from '../../media-metadata/providers/shared/provider-errors';
import type { TraktIds } from './trakt/types';

/** Shared return shape of all media-matching entry points. */
type MediaMatch = {
  mediaId: string | null;
  confidence: number;
  matchedTitle: string | null;
  /** Set on unresolved TVDB-id matches: the id is provably dead (404) vs inconclusive. */
  dead?: boolean;
};

export interface MatchResult {
  mediaId: string | null;
  episodeId: string | null;
  confidence: number;
  status: 'matched' | 'needs_review' | 'unmatched';
  matchedTitle: string | null;
}

/**
 * Pick among EXACT-title matches. When the import carries a year, only candidates within
 * ±1y are eligible (remakes share titles — the year is the real disambiguator); otherwise
 * the MOST RECENT candidate wins, because TMDB ranks by historical popularity, which
 * favors the classic over the remake the user usually means. Popularity breaks ties.
 */
function pickBestTitleMatch<
  T extends { title: string; year?: number | null; popularity?: number | null },
>(exactMatches: T[], importYear?: number | null): T | undefined {
  if (exactMatches.length === 0) return undefined;
  let pool = exactMatches;
  if (importYear != null) {
    const near = exactMatches.filter((c) => c.year != null && Math.abs(c.year - importYear) <= 1);
    if (near.length > 0) pool = near;
  }
  return [...pool].sort(
    (a, b) => (b.year ?? 0) - (a.year ?? 0) || (b.popularity ?? 0) - (a.popularity ?? 0),
  )[0];
}

@Injectable()
export class ImportMatcher {
  private readonly logger = new Logger(ImportMatcher.name);
  private readonly mediaCache = new Map<
    string,
    { mediaId: string | null; confidence: number; title: string | null }
  >();
  private readonly episodeCache = new Map<string, string | null>();
  /**
   * Per-media provider preference for hydration: set to 'tvdb' when a match identified the
   * show as anime (TMDB anime season/episode structures are unreliable — TVDB is
   * authoritative). Consulted by ensureShowHydrated.
   */
  private readonly providerPref = new Map<string, 'tmdb' | 'tvdb'>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly meta: MediaMetadataService,
    private readonly tmdb: TmdbProvider,
    private readonly tvdb: TvdbProvider,
  ) {}

  /** Match a show or movie by title (+year). DB first, then TMDb (search + light-upsert). */
  /**
   * Resolve a title to a media id. Optional `hint` carries the import's observed seasons for a
   * show (highest season + highest episode number per season), used to disambiguate duplicate
   * titles (e.g. two shows "Silo"): among exact-title candidates the one that can actually
   * contain the import's seasons/episodes is preferred.
   */
  async matchMedia(
    norm: string,
    title: string,
    type: 'SHOW' | 'MOVIE',
    year?: number | null,
    hint?: {
      maxSeason?: number | null;
      seasonEpisodes?: { season: number; maxEpisode: number }[] | null;
    } | null,
    archiveLanguage?: SupportedLocale | null,
    /**
     * Raw TVDB series id from a TV Time export (s_id/series_id/tv_show_id). When present,
     * this is the AUTHORITATIVE identity signal: only TVDB-ID-based resolution is used,
     * NEVER title fallback. If the ID can't be resolved (locally or via TVDB API), the
     * item goes to NEEDS_REVIEW instead of being matched to a different show by title.
     */
    rawTvdbSeriesId?: string | null,
    /**
     * ALL distinct TVDB series ids collected across duplicate rows of the same title
     * (TV Time sometimes carries two ids for one show after a TVDB merge — one dead, one
     * live). When present, each id is tried in order through the authority gate; title
     * fallback is refused only when EVERY id fails.
     */
    rawTvdbSeriesIds?: string[],
    /**
     * Set false by callers that have NO trustworthy title (e.g. list items whose only
     * identity is a TVDB id): when every id is dead, return null instead of title-matching
     * a placeholder string to an arbitrary show.
     */
    allowTitleFallback = true,
  ): Promise<{ mediaId: string | null; confidence: number; matchedTitle: string | null }> {
    const rawIds = rawTvdbSeriesIds?.length
      ? rawTvdbSeriesIds
      : rawTvdbSeriesId
        ? [rawTvdbSeriesId]
        : [];
    const ids = [
      ...new Set(
        rawIds.map((id) => normalizeNumericExternalId(id)).filter((id): id is string => id != null),
      ),
    ];
    const key = `${type}:${norm}:${ids.join(',')}`;
    const cached = this.mediaCache.get(key);
    if (cached)
      return { mediaId: cached.mediaId, confidence: cached.confidence, matchedTitle: cached.title };

    const mediaType = type === 'SHOW' ? MediaType.SHOW : MediaType.MOVIE;

    // ═══════════════════════════════════════════════════════════════════════════════
    // TVDB ID AUTHORITY GATE: when raw TVDB series IDs are present, they MUST be respected.
    // But TMDB is preferred for data quality — so we try TMDB first (exact /find) and only
    // fall back to TVDB. Title matching to a DIFFERENT show is FORBIDDEN.
    // ═══════════════════════════════════════════════════════════════════════════════

    if (ids.length) {
      const r = await this.matchByTvdbIds(ids, title, type, year ?? null);
      // Only all-ids-dead (404) falls through to title matching: stale export ids from a
      // TVDB merge carry no identity signal, while an inconclusive failure keeps the
      // refusal (we can't tell whether the id is live).
      if (r.mediaId || !r.allDead) {
        const result: MediaMatch = {
          mediaId: r.mediaId,
          confidence: r.confidence,
          matchedTitle: r.matchedTitle,
        };
        this.mediaCache.set(key, {
          mediaId: result.mediaId,
          confidence: result.confidence,
          title: result.matchedTitle,
        });
        return result;
      }
      if (!allowTitleFallback) {
        this.mediaCache.set(key, { mediaId: null, confidence: 0, title: null });
        return { mediaId: null, confidence: 0, matchedTitle: null };
      }
      this.logger.log(
        `All ${ids.length} TVDB id(s) for "${title}" are dead or incompatible — falling back to compatible title/year search`,
      );
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // TITLE-ONLY MATCHING (no external ID available)
    // ═══════════════════════════════════════════════════════════════════════════════

    // 1) DB exact normalized match
    const exact = await this.prisma.mediaItem.findFirst({
      where: { type: mediaType, title: { equals: title, mode: 'insensitive' } },
    });
    if (exact && normTitle(exact.title) === norm) {
      const confidence = 0.9;
      this.mediaCache.set(key, { mediaId: exact.id, confidence, title: exact.title });
      return { mediaId: exact.id, confidence, matchedTitle: exact.title };
    }

    // 2) DB contains match (normalized compare)
    const like = await this.prisma.mediaItem.findMany({
      where: { type: mediaType, title: { contains: title, mode: 'insensitive' } },
      take: 10,
    });
    const normLike = like.find((m) => normTitle(m.title) === norm);
    if (normLike) {
      this.mediaCache.set(key, { mediaId: normLike.id, confidence: 0.8, title: normLike.title });
      return { mediaId: normLike.id, confidence: 0.8, matchedTitle: normLike.title };
    }

    // 2b) DB exact match on the "core" title (all parentheticals stripped).
    //     Catches variants like "The Office (US)" vs "The Office" without calling TMDb.
    const core = title
      .replace(/\s*\([^)]*\)\s*/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (core && core.toLowerCase() !== title.toLowerCase()) {
      const coreMatch = await this.prisma.mediaItem.findFirst({
        where: { type: mediaType, title: { equals: core, mode: 'insensitive' } },
      });
      if (coreMatch) {
        const confidence = 0.85;
        this.mediaCache.set(key, { mediaId: coreMatch.id, confidence, title: coreMatch.title });
        return { mediaId: coreMatch.id, confidence, matchedTitle: coreMatch.title };
      }
    }

    // 2c) DB match on localized titles JSON — matches already-localized rows
    //     (English base + a non-English override) without calling TMDb.
    //     Useful for re-imports and shared catalogs.
    const jsonCandidates = await this.prisma.$queryRaw<
      Array<{ id: string; title: string; titles: any }>
    >`
      SELECT id, title, titles FROM media_items
      WHERE type::text = ${mediaType} AND titles IS NOT NULL
        AND EXISTS (SELECT 1 FROM jsonb_each_text(titles) kv WHERE kv.value ILIKE ${title})
      LIMIT 10
    `;
    const jsonMatch = jsonCandidates.find((c) => {
      if (!c.titles || typeof c.titles !== 'object') return false;
      return Object.values(c.titles).some((v) => normTitle(String(v)) === norm);
    });
    if (jsonMatch) {
      const confidence = 0.85;
      this.mediaCache.set(key, { mediaId: jsonMatch.id, confidence, title: jsonMatch.title });
      return { mediaId: jsonMatch.id, confidence, matchedTitle: jsonMatch.title };
    }

    // 3) TMDb search fallback
    if (this.tmdb.enabled) {
      try {
        const res =
          type === 'SHOW'
            ? await this.tmdb.searchShows(title, 1)
            : await this.tmdb.searchMovies(title, 1);
        const exactMatches = res.items.filter((i) => normTitle(i.title) === norm);
        let best = pickBestTitleMatch(exactMatches, year) ?? res.items[0];
        // Disambiguate duplicate titles using the import's season/episode footprint: prefer the
        // candidate that has enough seasons AND enough episodes in each referenced season.
        const hasHint =
          !!hint && (!!hint.maxSeason || !!(hint.seasonEpisodes && hint.seasonEpisodes.length));
        if (type === 'SHOW' && exactMatches.length > 1 && hasHint) {
          best = (await this.disambiguateShow(exactMatches, hint!)) ?? best;
        }
        if (best) {
          const sameTitle = normTitle(best.title) === norm;
          const mediaId =
            type === 'SHOW'
              ? await this.meta.lightUpsertShow(best)
              : await this.meta.lightUpsertMovie(best);
          const confidence = sameTitle ? 0.75 : 0.5;
          this.mediaCache.set(key, { mediaId, confidence, title: best.title });
          return { mediaId, confidence, matchedTitle: best.title };
        }
      } catch (e) {
        this.logger.warn(`TMDb match failed for "${title}": ${(e as Error).message}`);
      }
    }

    // 3b) TMDb archive-language fallback — retry in the archive (user.csv) language
    //     when the import-language search found nothing. The search + lightUpsert run
    //     inside the archive-language context so the override is stored under the right locale.
    if (archiveLanguage && archiveLanguage !== currentLanguage() && this.tmdb.enabled) {
      try {
        const found = await runInLanguage(archiveLanguage, async () => {
          const r =
            type === 'SHOW'
              ? await this.tmdb.searchShows(title, 1)
              : await this.tmdb.searchMovies(title, 1);
          const exactMatches = r.items.filter((i) => normTitle(i.title) === norm);
          const b = pickBestTitleMatch(exactMatches, year) ?? r.items[0];
          if (!b) return null;
          const mid =
            type === 'SHOW'
              ? await this.meta.lightUpsertShow(b)
              : await this.meta.lightUpsertMovie(b);
          return { mid, title: b.title, sameTitle: normTitle(b.title) === norm };
        });
        if (found) {
          const confidence = found.sameTitle ? 0.72 : 0.5;
          this.mediaCache.set(key, { mediaId: found.mid, confidence, title: found.title });
          return { mediaId: found.mid, confidence, matchedTitle: found.title };
        }
      } catch (e) {
        this.logger.warn(
          `TMDb archive-lang (${archiveLanguage}) match failed for "${title}": ${(e as Error).message}`,
        );
      }
    }

    // 4) TVDB fallback (backup provider) — used when TMDb has no/weak result.
    if (this.tvdb.enabled) {
      try {
        const res =
          type === 'SHOW'
            ? await this.tvdb.searchShows(title, 1)
            : await this.tvdb.searchMovies(title, 1);
        const best =
          pickBestTitleMatch(
            res.items.filter((i) => normTitle(i.title) === norm),
            year,
          ) ?? res.items[0];
        if (best && best.tvdbId) {
          const sameTitle = normTitle(best.title) === norm;
          const tvdbArgs = {
            tvdbId: best.tvdbId,
            title: best.title,
            overview: best.overview ?? null,
            posterUrl: best.posterUrl ?? null,
            backdropUrl: best.backdropUrl ?? null,
            popularity: best.popularity ?? 0,
            year: best.year ?? null,
          };
          const mediaId =
            type === 'SHOW'
              ? await this.meta.lightUpsertShowTvdb(tvdbArgs)
              : await this.meta.lightUpsertMovieTvdb(tvdbArgs);
          // Slightly more conservative than TMDb (it's a backup), but exact title → matched.
          const confidence = sameTitle ? 0.72 : 0.5;
          this.mediaCache.set(key, { mediaId, confidence, title: best.title });
          return { mediaId, confidence, matchedTitle: best.title };
        }
      } catch (e) {
        this.logger.warn(`TVDB match failed for "${title}": ${(e as Error).message}`);
      }
    }

    // NOTE: Old Step 5 (TVDB exact-id recovery) was moved to Step 0b above.
    // When rawTvdbSeriesId is present, the TVDB authority gate (Step 0/0b/0c) handles
    // everything BEFORE any title matching. Title matching only runs when there's NO
    // external ID at all.

    return { mediaId: null, confidence: 0, matchedTitle: null };
  }

  /**
   * Resolve-by-name matching (bulk manual resolve from the review UI). Like the title flow
   * of matchMedia but STRICT about the name: a candidate is accepted only when the source
   * title normalizes to its title, its original-language title, or one of its stored
   * localized titles (language aware — e.g. "7. Koğuştaki Mucize" matches the row whose
   * English title is "Miracle in Cell No. 7"). Show candidates are disambiguated by the
   * import's season/episode footprint (same approximation as the review UI's smart sort).
   * No id authority, no first-hit gambles — a non-matching name NEVER resolves.
   */
  async matchByTitleVerified(
    norm: string,
    title: string,
    type: 'SHOW' | 'MOVIE',
    hint?: {
      maxSeason?: number | null;
      seasonEpisodes?: { season: number; maxEpisode: number }[] | null;
    } | null,
  ): Promise<{ mediaId: string | null; confidence: number; matchedTitle: string | null }> {
    const mediaType = type === 'SHOW' ? MediaType.SHOW : MediaType.MOVIE;
    const nameMatches = (cand: {
      title?: string | null;
      originalTitle?: string | null;
      titles?: unknown;
    }): boolean => {
      if (cand.title && normTitle(cand.title) === norm) return true;
      if (cand.originalTitle && normTitle(cand.originalTitle) === norm) return true;
      if (cand.titles && typeof cand.titles === 'object') {
        return Object.values(cand.titles as Record<string, unknown>).some(
          (v) => normTitle(String(v)) === norm,
        );
      }
      return false;
    };

    // 1) Local catalog: base title OR original title OR localized titles JSON.
    const like = await this.prisma.mediaItem.findMany({
      where: {
        type: mediaType,
        OR: [
          { title: { contains: title, mode: 'insensitive' } },
          { show: { originalTitle: { contains: title, mode: 'insensitive' } } },
        ],
      },
      take: 10,
      include: { show: { select: { originalTitle: true } } },
    });
    const dbHit = like.find((m) =>
      nameMatches({ title: m.title, originalTitle: m.show?.originalTitle ?? null }),
    );
    if (dbHit) return { mediaId: dbHit.id, confidence: 0.85, matchedTitle: dbHit.title };

    // 1b) Localized titles JSON (covers hydrated rows whose base title is another language).
    const jsonCandidates = await this.prisma.$queryRaw<
      Array<{ id: string; title: string; titles: any }>
    >`
      SELECT id, title, titles FROM media_items
      WHERE type::text = ${mediaType} AND titles IS NOT NULL
        AND EXISTS (SELECT 1 FROM jsonb_each_text(titles) kv WHERE kv.value ILIKE ${title})
      LIMIT 10
    `;
    const jsonHit = jsonCandidates.find((c) => nameMatches(c));
    if (jsonHit) return { mediaId: jsonHit.id, confidence: 0.85, matchedTitle: jsonHit.title };

    // 2) TMDB search — verified by title OR original-language title.
    if (this.tmdb.enabled) {
      try {
        const res =
          type === 'SHOW'
            ? await this.tmdb.searchShows(title, 1)
            : await this.tmdb.searchMovies(title, 1);
        const verified = res.items.filter((i) => nameMatches(i));
        if (verified.length) {
          let best = pickBestTitleMatch(verified)!;
          const hasHint =
            !!hint && (!!hint.maxSeason || !!(hint.seasonEpisodes && hint.seasonEpisodes.length));
          if (type === 'SHOW' && verified.length > 1 && hasHint) {
            best = (await this.disambiguateShow(verified, hint!)) ?? best;
          }
          const mediaId =
            type === 'SHOW'
              ? await this.meta.lightUpsertShow(best)
              : await this.meta.lightUpsertMovie(best);
          return { mediaId, confidence: 0.85, matchedTitle: best.title };
        }
      } catch (e) {
        this.logger.warn(
          `Resolve-by-name TMDb search failed for "${title}": ${(e as Error).message}`,
        );
      }
    }

    // 3) TVDB search (backup provider) — title-only check (TVDB has no separate original title).
    if (this.tvdb.enabled) {
      try {
        const res =
          type === 'SHOW'
            ? await this.tvdb.searchShows(title, 1)
            : await this.tvdb.searchMovies(title, 1);
        const best = pickBestTitleMatch(res.items.filter((i) => normTitle(i.title) === norm));
        if (best && best.tvdbId) {
          const tvdbArgs = {
            tvdbId: best.tvdbId,
            title: best.title,
            overview: best.overview ?? null,
            posterUrl: best.posterUrl ?? null,
            backdropUrl: best.backdropUrl ?? null,
            popularity: best.popularity ?? 0,
            year: best.year ?? null,
          };
          const mediaId =
            type === 'SHOW'
              ? await this.meta.lightUpsertShowTvdb(tvdbArgs)
              : await this.meta.lightUpsertMovieTvdb(tvdbArgs);
          return { mediaId, confidence: 0.8, matchedTitle: best.title };
        }
      } catch (e) {
        this.logger.warn(
          `Resolve-by-name TVDB search failed for "${title}": ${(e as Error).message}`,
        );
      }
    }

    return { mediaId: null, confidence: 0, matchedTitle: null };
  }

  /**
   * TVDB-authority resolution (shared by the CSV rawTvdbSeriesId gate and the Trakt
   * external-id path): local TVDB mapping → exact TMDB /find translation → direct TVDB fetch.
   * NEVER falls back to title matching — an unresolvable id returns null/confidence 0.
   * Anime shows (TMDB Animation genre + `anime` keyword) are TVDB-authoritative: TMDB anime
   * season/episode structures are unreliable, so they get a TVDB-backed record + TVDB-first
   * hydration (providerPref), with the TMDB id still attached for cross-lookups.
   * The CALLER is responsible for caching the result.
   */
  private async matchByTvdbId(
    rawTvdbId: string,
    title: string,
    type: 'SHOW' | 'MOVIE',
    year: number | null = null,
  ): Promise<MediaMatch> {
    const providerKind = type === 'SHOW' ? ProviderEntityKind.SERIES : ProviderEntityKind.MOVIE;
    // 0) Reuse a VERIFIED LOCAL TVDB mapping — no external call.
    const ext = await this.prisma.externalId.findFirst({
      where: {
        provider: ExternalProvider.THE_TVDB,
        providerEntityKind: providerKind,
        value: rawTvdbId,
      },
      include: { media: true },
    });
    if (ext?.media) {
      const expected = type === 'SHOW' ? MediaType.SHOW : MediaType.MOVIE;
      if (ext.media.type !== expected) {
        this.logger.warn(
          `TVDB id ${rawTvdbId} ("${title}") resolves to ${ext.media.type}, expected ${type} — rejecting incompatible identity`,
        );
        return { mediaId: null, confidence: 0, matchedTitle: null, dead: true };
      }
      if (type === 'MOVIE' && this.tvdb.enabled) {
        // Re-verify historical local aliases through TVDB remote ids. The centralized
        // upsert repoints an alias that the removed title matcher parked on the wrong movie.
        const mediaId = await this.meta.lightUpsertMovieTvdb({
          tvdbId: Number(rawTvdbId),
          title: ext.media.title,
          year,
        });
        return { mediaId, confidence: 0.95, matchedTitle: ext.media.title };
      }
      if (type === 'SHOW' && this.tmdb.enabled) {
        try {
          const found = await this.tmdb.findByExternalId(rawTvdbId, 'tvdb_id');
          if (found?.show) {
            const ownTmdb = await this.prisma.externalId.findFirst({
              where: {
                mediaId: ext.media.id,
                provider: ExternalProvider.TMDB,
                providerEntityKind: ProviderEntityKind.SERIES,
              },
              select: { value: true },
            });
            const tmdbOwner = await this.prisma.externalId.findFirst({
              where: {
                provider: ExternalProvider.TMDB,
                providerEntityKind: ProviderEntityKind.SERIES,
                value: String(found.show.tmdbId),
              },
              select: { mediaId: true },
            });
            if (ownTmdb?.value === String(found.show.tmdbId)) {
              return { mediaId: ext.media.id, confidence: 0.95, matchedTitle: ext.media.title };
            }
            if (!ownTmdb && !tmdbOwner) {
              await this.attachExternalId(
                ext.media.id,
                ExternalProvider.TMDB,
                ProviderEntityKind.SERIES,
                String(found.show.tmdbId),
              );
              return { mediaId: ext.media.id, confidence: 0.95, matchedTitle: ext.media.title };
            }
            // A different TMDB owner (or a conflicting TMDB id on this row) proves the
            // local TVDB alias is suspect. Fall through to the normal routing branch,
            // which reassigns the verified alias and applies the anime authority rule.
          } else if (found?.movie) {
            return { mediaId: null, confidence: 0, matchedTitle: null, dead: true };
          } else {
            return { mediaId: ext.media.id, confidence: 0.95, matchedTitle: ext.media.title };
          }
        } catch (e) {
          this.logger.debug(
            `Local TVDB series alias ${rawTvdbId} could not be re-verified: ${(e as Error).message}`,
          );
          return { mediaId: ext.media.id, confidence: 0.95, matchedTitle: ext.media.title };
        }
      } else {
        return { mediaId: ext.media.id, confidence: 0.95, matchedTitle: ext.media.title };
      }
    }

    // 0a) Exact TMDB /find translation (one call, no title search). Anime shows take the
    //     TVDB-authoritative branch instead of the TMDB record. A sibling-kind result is
    //     retained only in import diagnostics; it is never attached to incompatible media.
    // TMDB's tvdb_id /find namespace resolves TVDB series/episodes, not TVDB movies.
    // Movie ids go through TVDB's verified TMDB/IMDb remote ids in step 0b.
    if (type === 'SHOW' && this.tmdb.enabled) {
      try {
        const found = await this.tmdb.findByExternalId(rawTvdbId, 'tvdb_id');
        const preferred = (type === 'SHOW' ? found?.show : found?.movie) ?? null;
        const sibling = (type === 'SHOW' ? found?.movie : found?.show) ?? null;
        if (!preferred && sibling) {
          this.logger.warn(
            `TVDB id ${rawTvdbId} ("${title}") is ${type === 'SHOW' ? 'MOVIE' : 'SHOW'} per TMDB /find, expected ${type} — rejecting incompatible identity`,
          );
          return { mediaId: null, confidence: 0, matchedTitle: null, dead: true };
        }
        if (preferred) {
          const hit = preferred;
          const kind = type;
          let routingProfile: Awaited<ReturnType<TmdbProvider['getShowRoutingProfile']>> | null =
            null;
          if (kind === 'SHOW') {
            try {
              routingProfile = await this.tmdb.getShowRoutingProfile(hit.tmdbId);
            } catch (e) {
              this.logger.debug(
                `TMDB routing profile ${hit.tmdbId} unavailable; keeping TMDB identity match: ${(e as Error).message}`,
              );
            }
          }
          if (
            kind === 'SHOW' &&
            routingProfile &&
            isAnimeSignal(routingProfile.genreIds, routingProfile.keywords)
          ) {
            const pendingAnime = async () => {
              const mediaId = await this.meta.lightUpsertShow({
                tmdbId: hit.tmdbId,
                title,
                year,
              });
              this.providerPref.set(mediaId, 'tvdb');
              if (routingProfile!.tvdbId) {
                await this.attachExternalId(
                  mediaId,
                  ExternalProvider.THE_TVDB,
                  ProviderEntityKind.SERIES,
                  String(routingProfile!.tvdbId),
                );
              }
              return { mediaId, confidence: 0.9, matchedTitle: title };
            };
            // The import's raw TVDB id is not enough to own anime structure. TMDB must
            // verify the canonical TVDB series cross-id; otherwise retain an identity-only
            // pending stub and let review/retry resolve episodes later.
            if (!routingProfile.tvdbId || !this.tvdb.enabled) return pendingAnime();
            try {
              const canonicalTvdbId = routingProfile.tvdbId;
              const s = await this.tvdb.getShow(canonicalTvdbId);
              const mediaId = await this.meta.lightUpsertShowTvdb({
                tvdbId: canonicalTvdbId,
                title: s.title,
                overview: s.overview ?? null,
                posterUrl: s.posterUrl ?? null,
                backdropUrl: s.backdropUrl ?? null,
                popularity: s.popularity ?? 0,
                year: s.yearStart ?? null,
              });
              this.providerPref.set(mediaId, 'tvdb');
              await this.attachExternalId(
                mediaId,
                ExternalProvider.TMDB,
                ProviderEntityKind.SERIES,
                String(hit.tmdbId),
              );
              return { mediaId, confidence: 0.9, matchedTitle: s.title };
            } catch (e) {
              this.logger.warn(
                `Anime TVDB-authoritative hydration failed for ${rawTvdbId} ("${title}") — retaining an identity-only pending stub: ${(e as Error).message}`,
              );
              return pendingAnime();
            }
          }
          const mediaId =
            kind === 'SHOW'
              ? await this.meta.lightUpsertShow({ tmdbId: hit.tmdbId, title, year })
              : await this.meta.lightUpsertMovie({ tmdbId: hit.tmdbId, title, year });
          await this.attachExternalId(mediaId, ExternalProvider.THE_TVDB, providerKind, rawTvdbId);
          return { mediaId, confidence: 0.95, matchedTitle: title };
        }
      } catch (e) {
        this.logger.debug(
          `TMDB /find for TVDB id ${rawTvdbId} ("${title}") failed: ${(e as Error).message}`,
        );
      }
    }

    // 0b) TMDB didn't resolve the TVDB ID → fetch from TVDB directly. A 404 on the expected
    //     entity kind triggers one sibling-kind probe to distinguish an incompatible live
    //     id from a dead id. The sibling result is never persisted or attached.
    let dead = false;
    if (this.tvdb.enabled) {
      const numId = Number(rawTvdbId);
      const upsertShow = async () => {
        const s = await this.tvdb.getShow(numId);
        const mediaId = await this.meta.lightUpsertShowTvdb({
          tvdbId: numId,
          title: s.title,
          overview: s.overview ?? null,
          posterUrl: s.posterUrl ?? null,
          backdropUrl: s.backdropUrl ?? null,
          popularity: s.popularity ?? 0,
          year: s.yearStart ?? null,
        });
        return { mediaId, title: s.title };
      };
      const upsertMovie = async () => {
        const mv = await this.tvdb.getMovie(numId);
        const tmdbValue = mv.externals.find((e) => e.provider === ExternalProvider.TMDB)?.value;
        const imdbId = mv.externals.find((e) => e.provider === ExternalProvider.IMDB)?.value;
        const parsedTmdb = tmdbValue ? Number(tmdbValue) : NaN;
        const mediaId = await this.meta.lightUpsertMovieTvdb({
          tvdbId: numId,
          tmdbId: Number.isSafeInteger(parsedTmdb) && parsedTmdb > 0 ? parsedTmdb : null,
          imdbId: imdbId ?? null,
          title: mv.title,
          overview: mv.overview ?? null,
          posterUrl: mv.posterUrl ?? null,
          backdropUrl: mv.backdropUrl ?? null,
          popularity: mv.popularity ?? 0,
          year: mv.releaseYear ?? null,
        });
        return { mediaId, title: mv.title };
      };
      try {
        const r = type === 'SHOW' ? await upsertShow() : await upsertMovie();
        return { mediaId: r.mediaId, confidence: 0.85, matchedTitle: r.title };
      } catch (e) {
        if (isProviderError(e) && e.category === 'not_found') {
          try {
            if (type === 'SHOW') await this.tvdb.getMovie(numId);
            else await this.tvdb.getShow(numId);
            this.logger.warn(
              `TVDB id ${rawTvdbId} ("${title}") exists as ${type === 'SHOW' ? 'MOVIE' : 'SHOW'}, expected ${type} — rejecting incompatible identity`,
            );
            return { mediaId: null, confidence: 0, matchedTitle: null, dead: true };
          } catch (e2) {
            // A 404 on BOTH kinds means the id is DEAD — it carries no identity signal,
            // so a title fallback is legitimate. Any other failure (throttle, timeout,
            // upstream) is inconclusive: keep refusing, we can't tell if it's live.
            dead = isProviderError(e2) && e2.category === 'not_found';
            if (!dead) {
              this.logger.warn(
                `TVDB exact-id recovery failed for ${rawTvdbId}: ${(e2 as Error).message}`,
              );
            }
          }
        } else {
          this.logger.warn(
            `TVDB exact-id recovery failed for ${rawTvdbId}: ${(e as Error).message}`,
          );
        }
      }
    }

    // 0c) TVDB ID present but UNRESOLVABLE — do NOT fall back to title matching
    //     (unless the id is provably dead — see matchByTvdbIds).
    this.logger.warn(
      `TVDB ${type === 'SHOW' ? 'series' : 'movie'} ID ${rawTvdbId} for "${title}" could not be resolved via TMDB or TVDB — refusing title fallback`,
    );
    return { mediaId: null, confidence: 0, matchedTitle: null, dead };
  }

  /**
   * Multi-id authority gate: TV Time rows for one show can carry several TVDB series ids
   * (TVDB merges leave dead ids in old exports — one id may be gone while a sibling works).
   * Each id is tried through the full gate in order; the first hit wins. Title fallback is
   * refused only when EVERY id fails — an id set that cannot resolve at all returns null.
   */
  private async matchByTvdbIds(
    ids: string[],
    title: string,
    type: 'SHOW' | 'MOVIE',
    year: number | null,
  ): Promise<MediaMatch & { allDead?: boolean }> {
    let sawInconclusive = false;
    for (const id of ids) {
      const r = await this.matchByTvdbId(id, title, type, year);
      if (r.mediaId) return r;
      if (!r.dead) sawInconclusive = true;
    }
    if (ids.length > 1) {
      this.logger.warn(
        `None of the ${ids.length} TVDB ids for "${title}" resolved (${ids.join(', ')}) — refusing title fallback`,
      );
    }
    // Every id is provably dead or incompatible with the imported type → it cannot identify
    // a valid target. A validated title/year search is the only remaining compatible signal.
    // Any inconclusive failure keeps the refusal (we can't tell whether the id is live).
    return { mediaId: null, confidence: 0, matchedTitle: null, allDead: !sawInconclusive };
  }

  /**
   * Show-level recovery via a TVDB EPISODE id (last resort): TV Time episode rows often carry
   * no series id, and translated titles (e.g. "The Mantis" → "La Mante") defeat title search.
   * Chain: local episode external ids (free) → TMDB /find (returns the parent show id) →
   * TVDB episode → parent series id → the TVDB authority gate (covers TVDB-only shows whose
   * export series id is dead/merged and TMDB has no mapping, e.g. some J-drama).
   * Only runs when normal show matching already failed (bounded call volume).
   */
  async recoverShowByEpisodeId(
    title: string,
    year: number | null,
    rawTvdbEpisodeId: string | number | null | undefined,
  ): Promise<MediaMatch> {
    const raw = normalizeNumericExternalId(rawTvdbEpisodeId) ?? '';
    if (!raw) return { mediaId: null, confidence: 0, matchedTitle: null };
    // 1) Local mapping: the episode is already hydrated somewhere — free, no provider call.
    const local = await this.prisma.episodeExternalId.findFirst({
      where: {
        provider: ExternalProvider.THE_TVDB,
        value: raw,
        episode: { structureState: 'ACTIVE' },
      },
      include: {
        episode: { include: { season: { include: { show: { include: { media: true } } } } } },
      },
    });
    const localMedia = (local as any)?.episode?.season?.show?.media;
    if (localMedia) {
      return { mediaId: localMedia.id, confidence: 0.95, matchedTitle: localMedia.title };
    }
    // 2) TMDB /find on the episode id returns the parent TMDB show id.
    if (this.tmdb.enabled) {
      try {
        const found = await this.tmdb.findByExternalId(raw, 'tvdb_id');
        const showId = found?.episode?.showId;
        if (showId) {
          const mediaId = await this.meta.lightUpsertShow({ tmdbId: showId, title, year });
          return { mediaId, confidence: 0.9, matchedTitle: title };
        }
      } catch (e) {
        this.logger.debug(
          `Show recovery via episode id ${raw} ("${title}") failed: ${(e as Error).message}`,
        );
      }
    }
    // 3) TVDB episode → parent series id → full authority gate (TVDB-only shows).
    if (this.tvdb.enabled) {
      try {
        const ep = await this.tvdb.getEpisode(Number(raw));
        if (ep.seriesId) {
          const r = await this.matchByTvdbIds(
            [String(ep.seriesId)],
            title || `TVDB ${ep.seriesId}`,
            'SHOW',
            year ?? null,
          );
          if (r.mediaId) return r;
        }
      } catch (e) {
        this.logger.debug(
          `Show recovery via TVDB episode ${raw} ("${title}") failed: ${(e as Error).message}`,
        );
      }
    }
    return { mediaId: null, confidence: 0, matchedTitle: null };
  }

  /**
   * The locally hydrated structure of a show: highest non-special season and, per season,
   * the highest stored episode number. Used by the structural guard to detect shows whose
   * stored structure cannot contain the import's footprint (wrong provider structure or a
   * poisoned partial hydration from a rate-limited fetch).
   */
  async hydratedFootprint(
    mediaId: string,
  ): Promise<{ maxSeason: number; maxEpisodeBySeason: Map<number, number> }> {
    const seasons = await this.prisma.season.findMany({
      where: { show: { mediaId }, episodes: { some: { structureState: 'ACTIVE' } } },
      select: {
        number: true,
        episodes: {
          where: { structureState: 'ACTIVE' },
          select: { number: true },
          orderBy: { number: 'desc' },
          take: 1,
        },
      },
    });
    const maxEpisodeBySeason = new Map<number, number>();
    let maxSeason = 0;
    for (const s of seasons) {
      if (s.number > maxSeason) maxSeason = s.number;
      maxEpisodeBySeason.set(s.number, s.episodes[0]?.number ?? 0);
    }
    return { maxSeason, maxEpisodeBySeason };
  }

  /**
   * External-ID-first matching for id-carrying exports. Order: TMDB id (local mapping, else
   * light fetch + upsert) → IMDB id (local mapping, else exact TMDB /find) → TVDB id
   * (authority gate above) → title fallback. IMDB precedes TVDB because some TV Time movie
   * rows contain a valid movie IMDB id alongside an unrelated TVDB SERIES id; the entity-kind
   * scoped IMDB lookup is the safe discriminator in that conflict.
   */
  async matchByExternalIds(
    ids: TraktIds,
    type: 'SHOW' | 'MOVIE',
    title: string,
    norm: string,
    year?: number | null,
    archiveLanguage?: SupportedLocale | null,
  ): Promise<MediaMatch> {
    const tvdbId = normalizeNumericExternalId(ids.tvdb);
    const key = `ext:${type}:${ids.tmdb ?? ''}:${tvdbId ?? ''}:${ids.imdb ?? ''}:${norm}`;
    const cached = this.mediaCache.get(key);
    if (cached)
      return { mediaId: cached.mediaId, confidence: cached.confidence, matchedTitle: cached.title };
    const done = (r: MediaMatch): MediaMatch => {
      this.mediaCache.set(key, {
        mediaId: r.mediaId,
        confidence: r.confidence,
        title: r.matchedTitle,
      });
      return r;
    };
    const kind = type === 'SHOW' ? ProviderEntityKind.SERIES : ProviderEntityKind.MOVIE;

    // 1) TMDB id — preferred provider. Local mapping first; on a miss validate the
    //    provider entity through the lightweight routing endpoint before attaching it.
    if (ids.tmdb) {
      const ext = await this.prisma.externalId.findFirst({
        where: {
          provider: ExternalProvider.TMDB,
          providerEntityKind: kind,
          value: String(ids.tmdb),
        },
        include: { media: true },
      });
      if (ext?.media && ext.media.type === type) {
        return done({ mediaId: ext.media.id, confidence: 0.95, matchedTitle: ext.media.title });
      }
      if (ext?.media) {
        this.logger.warn(
          `TMDB id ${ids.tmdb} is attached to ${ext.media.type}, expected ${type} — rejecting incompatible identity`,
        );
      }
      if (this.tmdb.enabled) {
        try {
          if (type === 'SHOW') {
            const profile = await this.tmdb.getShowRoutingProfile(ids.tmdb);
            const mediaId = await this.meta.lightUpsertShow({
              tmdbId: profile.tmdbId,
              title: profile.title,
              year: profile.yearStart,
            });
            if (profile.imdbId) {
              await this.attachExternalId(
                mediaId,
                ExternalProvider.IMDB,
                ProviderEntityKind.SERIES,
                profile.imdbId,
              );
            }
            if (profile.tvdbId) {
              await this.attachExternalId(
                mediaId,
                ExternalProvider.THE_TVDB,
                ProviderEntityKind.SERIES,
                String(profile.tvdbId),
              );
            }
            return done({ mediaId, confidence: 0.95, matchedTitle: profile.title });
          }
          const profile = await this.tmdb.getMovieRoutingProfile(ids.tmdb);
          const mediaId = await this.meta.lightUpsertMovie({
            tmdbId: profile.tmdbId,
            title: profile.title,
            year: profile.releaseYear,
          });
          if (profile.imdbId) {
            await this.attachExternalId(
              mediaId,
              ExternalProvider.IMDB,
              ProviderEntityKind.MOVIE,
              profile.imdbId,
            );
          }
          return done({ mediaId, confidence: 0.95, matchedTitle: profile.title });
        } catch (e) {
          this.logger.debug(
            `TMDB id ${ids.tmdb} upsert failed for "${title}" — falling through: ${(e as Error).message}`,
          );
        }
      }
    }

    // 2) IMDB id — local mapping first, then an exact, entity-kind-scoped /find recovery.
    if (ids.imdb) {
      const ext = await this.prisma.externalId.findFirst({
        where: { provider: ExternalProvider.IMDB, providerEntityKind: kind, value: ids.imdb },
        include: { media: true },
      });
      const compatibleLocal = ext?.media && ext.media.type === type ? ext.media : null;
      if (compatibleLocal && !this.tmdb.enabled) {
        return done({
          mediaId: compatibleLocal.id,
          confidence: 0.9,
          matchedTitle: compatibleLocal.title,
        });
      }
      if (ext?.media && !compatibleLocal) {
        this.logger.warn(
          `IMDB id ${ids.imdb} is attached to ${ext.media.type}, expected ${type} — rejecting incompatible identity`,
        );
      }
      if (this.tmdb.enabled) {
        try {
          const found = await this.tmdb.findByExternalId(ids.imdb, 'imdb_id');
          const hit = type === 'SHOW' ? found?.show : found?.movie;
          const sibling = type === 'SHOW' ? found?.movie : found?.show;
          if (hit) {
            if (type === 'MOVIE' && compatibleLocal) {
              const tmdbOwner = await this.prisma.externalId.findFirst({
                where: {
                  provider: ExternalProvider.TMDB,
                  providerEntityKind: ProviderEntityKind.MOVIE,
                  value: String(hit.tmdbId),
                },
                select: { mediaId: true },
              });
              if (!tmdbOwner) {
                // The IMDb-only local row is the canonical movie, merely missing its
                // TMDB cross-link. Attach before light-upsert so we enrich this row
                // instead of manufacturing a duplicate that needs a later merge.
                await this.attachExternalId(
                  compatibleLocal.id,
                  ExternalProvider.TMDB,
                  ProviderEntityKind.MOVIE,
                  String(hit.tmdbId),
                );
              }
            }
            const mediaId =
              type === 'SHOW'
                ? await this.meta.lightUpsertShow({ tmdbId: hit.tmdbId, title, year: year ?? null })
                : await this.meta.lightUpsertMovie({
                    tmdbId: hit.tmdbId,
                    title,
                    year: year ?? null,
                  });
            await this.attachExternalId(mediaId, ExternalProvider.IMDB, kind, ids.imdb);
            return done({ mediaId, confidence: 0.9, matchedTitle: title });
          }
          if (sibling) {
            this.logger.warn(
              `IMDB id ${ids.imdb} resolves to ${type === 'SHOW' ? 'MOVIE' : 'SHOW'}, expected ${type} — rejecting stale local identity`,
            );
          } else if (compatibleLocal) {
            return done({
              mediaId: compatibleLocal.id,
              confidence: 0.9,
              matchedTitle: compatibleLocal.title,
            });
          }
        } catch (e) {
          this.logger.debug(
            `IMDB /find for ${ids.imdb} ("${title}") failed: ${(e as Error).message}`,
          );
          if (compatibleLocal) {
            return done({
              mediaId: compatibleLocal.id,
              confidence: 0.9,
              matchedTitle: compatibleLocal.title,
            });
          }
        }
      }
    }

    // 3) TVDB id — authority gate (no title fallback inside). This intentionally runs after
    //    IMDB so a malformed movie row's TVDB SERIES id cannot preempt its valid IMDB id.
    if (tvdbId) {
      const r = await this.matchByTvdbId(tvdbId, title, type, year ?? null);
      if (r.mediaId) return done(r);
    }

    // 4) No id resolved → regular title matching (matchMedia without a raw TVDB id).
    const r = await this.matchMedia(norm, title, type, year, undefined, archiveLanguage);
    return done(r);
  }

  /**
   * Episode fast path for id-carrying imports (Trakt episode ids, TV Time rawTvdbEpisodeId):
   * resolve an episode of an already-matched show by its external episode id (TMDB first, then
   * TVDB) via EpisodeExternalId. Scoped to the matched mediaId so an id belonging to a
   * different show never leaks in. Returns null on a miss — the caller silently falls back to
   * season/episode resolution.
   */
  async resolveEpisodeByExternalIds(mediaId: string, ids: TraktIds): Promise<string | null> {
    const candidates: { provider: ExternalProvider; value: string }[] = [];
    if (ids.tmdb) candidates.push({ provider: ExternalProvider.TMDB, value: String(ids.tmdb) });
    const tvdbId = normalizeNumericExternalId(ids.tvdb);
    if (tvdbId) candidates.push({ provider: ExternalProvider.THE_TVDB, value: tvdbId });
    for (const c of candidates) {
      const cacheKey = `ext-ep:${mediaId}:${c.provider}:${c.value}`;
      if (this.episodeCache.has(cacheKey)) return this.episodeCache.get(cacheKey)!;
      const ext = await this.prisma.episodeExternalId.findFirst({
        where: {
          provider: c.provider,
          providerEntityKind: ProviderEntityKind.EPISODE,
          value: c.value,
          episode: { structureState: 'ACTIVE', season: { show: { mediaId } } },
        },
        select: { episodeId: true },
      });
      if (ext?.episodeId) {
        this.episodeCache.set(cacheKey, ext.episodeId);
        return ext.episodeId;
      }
    }
    return null;
  }

  /**
   * Episode /find recovery for TV Time rows: translate the TVDB episode id via TMDB /find —
   * the response carries TMDB's OWN season/episode numbers (and the parent show), so the
   * final S/E lookup is consistent with the TMDB-hydrated structure even when TVDB numbering
   * differs. Runs ONLY when local resolution (external id + S/E) already failed, so call
   * volume stays bounded to problem episodes. The found TMDB episode id is attached to the
   * resolved episode (best-effort) so later imports hit the local fast path.
   */
  async recoverEpisodeByTvdbId(
    mediaId: string,
    rawTvdbEpisodeId: string | number | null | undefined,
  ): Promise<string | null> {
    const raw = normalizeNumericExternalId(rawTvdbEpisodeId) ?? '';
    if (!raw || !this.tmdb.enabled) return null;
    const found = await this.tmdb.findByExternalId(raw, 'tvdb_id');
    const ep = found?.episode;
    if (!ep) return null;
    // Safety: when the matched media has a TMDB id, the episode must belong to that show.
    const tmdbExt = await this.prisma.externalId.findFirst({
      where: { mediaId, provider: ExternalProvider.TMDB },
    });
    if (tmdbExt && String(ep.showId) !== tmdbExt.value) return null;
    const episodeId = await this.resolveEpisode(mediaId, ep.season, ep.episode);
    if (episodeId) {
      await this.attachEpisodeExternalId(
        episodeId,
        ExternalProvider.TMDB,
        String(ep.tmdbEpisodeId),
      );
      // Preserve the imported alias as well: future imports resolve locally without
      // another /find call, while the TMDB episode remains the active structural row.
      await this.attachEpisodeExternalId(episodeId, ExternalProvider.THE_TVDB, raw);
    }
    return episodeId;
  }

  /** Attach an id already verified by its provider; repair a stale alias owner if needed. */
  private async attachExternalId(
    mediaId: string,
    provider: ExternalProvider,
    kind: ProviderEntityKind,
    value: string,
  ) {
    const existing = await this.prisma.externalId.findFirst({
      where: { provider, providerEntityKind: kind, value },
      select: { id: true, mediaId: true },
    });
    if (existing) {
      const anchoredOwner =
        existing.mediaId !== mediaId && provider !== ExternalProvider.TMDB
          ? await this.prisma.externalId.findFirst({
              where: {
                mediaId: existing.mediaId,
                provider: ExternalProvider.TMDB,
                providerEntityKind: kind,
              },
              select: { value: true },
            })
          : null;
      if (existing.mediaId !== mediaId && anchoredOwner) {
        await this.prisma.externalId.update({
          where: { id: existing.id },
          data: { mediaId },
        });
        this.logger.warn(
          `Repointed verified ${provider}/${kind} id ${value} from ${existing.mediaId} to ${mediaId}`,
        );
      } else if (existing.mediaId !== mediaId) {
        this.logger.warn(
          `Verified ${provider}/${kind} id ${value} is held by unanchored row ${existing.mediaId}; preserving it for the audited duplicate/remap repair`,
        );
      }
      return;
    }
    try {
      await this.prisma.externalId.create({
        data: { mediaId, provider, providerEntityKind: kind, value },
      });
    } catch (e: any) {
      if (e?.code !== 'P2002') throw e;
      const raced = await this.prisma.externalId.findFirst({
        where: { provider, providerEntityKind: kind, value },
        select: { id: true, mediaId: true },
      });
      const anchoredOwner =
        raced && raced.mediaId !== mediaId && provider !== ExternalProvider.TMDB
          ? await this.prisma.externalId.findFirst({
              where: {
                mediaId: raced.mediaId,
                provider: ExternalProvider.TMDB,
                providerEntityKind: kind,
              },
              select: { value: true },
            })
          : null;
      if (raced && raced.mediaId !== mediaId && anchoredOwner) {
        await this.prisma.externalId.update({
          where: { id: raced.id },
          data: { mediaId },
        });
      }
    }
  }

  /** Best-effort attach of an external id to an episode (repoints on unique conflict). */
  private async attachEpisodeExternalId(
    episodeId: string,
    provider: ExternalProvider,
    value: string,
  ) {
    try {
      await this.prisma.episodeExternalId.upsert({
        where: {
          provider_providerEntityKind_value: {
            provider,
            providerEntityKind: ProviderEntityKind.EPISODE,
            value,
          },
        },
        create: { episodeId, provider, providerEntityKind: ProviderEntityKind.EPISODE, value },
        update: { episodeId },
      });
    } catch {
      // best-effort only
    }
  }

  /**
   * Among several exact-title show candidates, pick the one that best fits the import's
   * season/episode footprint. Fetches details for up to 5 candidates (only on genuine title
   * ambiguity). A candidate is "qualified" if it has at least the import's highest season AND
   * every referenced season has at least as many episodes as the import's highest episode there
   * (e.g. import watched S1 up to E10 → a candidate whose S1 has only 5 episodes is out).
   * Among qualified candidates, the closest fit wins (fewest extra seasons, then smallest
   * deficit). Returns null if there's no meaningful decision (caller keeps the default pick).
   */
  private async disambiguateShow<T extends { tmdbId: number; title: string }>(
    candidates: T[],
    hint: {
      maxSeason?: number | null;
      seasonEpisodes?: { season: number; maxEpisode: number }[] | null;
    },
  ): Promise<T | null> {
    const maxSeason = hint.maxSeason ?? 0;
    const epBySeason = new Map<number, number>();
    for (const se of hint.seasonEpisodes ?? []) {
      epBySeason.set(se.season, Math.max(epBySeason.get(se.season) ?? 0, se.maxEpisode));
    }

    const scored = await Promise.all(
      candidates.slice(0, 5).map(async (c) => {
        try {
          const s = await this.tmdb.getShow(c.tmdbId);
          const seasonEpCounts = new Map<number, number>();
          for (const se of s.seasons ?? []) {
            if (se.isSpecial || se.number === 0) continue; // ignore specials
            seasonEpCounts.set(se.number, se.episodeCount);
          }
          const totalSeasons = s.seasonsCount ?? 0;

          let qualified = totalSeasons >= maxSeason;
          let deficit = 0; // total episodes short across referenced seasons
          for (const [season, maxEp] of epBySeason) {
            const cand = seasonEpCounts.get(season) ?? 0;
            if (cand < maxEp) {
              qualified = false;
              deficit += maxEp - cand;
            }
          }
          const extraSeasons = Math.max(0, totalSeasons - maxSeason);
          return { item: c, totalSeasons, qualified, extraSeasons, deficit };
        } catch {
          return null;
        }
      }),
    );

    type Score = {
      item: T;
      totalSeasons: number;
      qualified: boolean;
      extraSeasons: number;
      deficit: number;
    };
    const valid = scored.filter(Boolean) as Score[];

    const qualified = valid
      .filter((d) => d.qualified)
      .sort((a, b) => a.extraSeasons - b.extraSeasons || a.deficit - b.deficit);
    if (qualified.length) return qualified[0].item;

    // None fully fit the footprint — best effort: pick the closest (smallest episode deficit,
    // then the one with the most seasons). Only when there's real ambiguity.
    if (valid.length > 1) {
      return [...valid].sort((a, b) => a.deficit - b.deficit || b.totalSeasons - a.totalSeasons)[0]
        .item;
    }
    return null;
  }

  /** Ensure a show has seasons/episodes in DB (needed to resolve episode by S/E). Skips if already hydrated. */
  async ensureShowHydrated(mediaId: string) {
    // Already hydrated? Then there's nothing to fetch — this is what makes re-imports fast.
    const epCount = await this.prisma.episode.count({
      where: { structureState: 'ACTIVE', season: { show: { mediaId } } },
    });
    if (epCount > 0) return;

    const [tmdbExt, tvdbExt] = await Promise.all([
      this.prisma.externalId.findFirst({ where: { mediaId, provider: ExternalProvider.TMDB } }),
      this.prisma.externalId.findFirst({ where: { mediaId, provider: ExternalProvider.THE_TVDB } }),
    ]);

    // Anime shows matched via the TVDB-authoritative branch hydrate from TVDB first:
    // TMDB anime season/episode structures are unreliable.
    if (this.providerPref.get(mediaId) === 'tvdb' && tvdbExt && this.tvdb?.enabled) {
      try {
        await this.meta.ensureShowFullTvdb(Number(tvdbExt.value));
      } catch {
        // Confirmed anime never writes a temporary TMDB graph. A later retry/review can
        // resolve it once TVDB is available.
      }
      return;
    }

    // Try TMDB first (preferred provider).
    if (tmdbExt && this.tmdb.enabled) {
      try {
        await this.meta.ensureShowFull(Number(tmdbExt.value));
        return; // Success — episodes are now available.
      } catch {
        // Fall through to TVDB.
      }
    }

    // Try TVDB (for TVDB-only shows matched via Step 5 recovery — they have no TMDB ID).
    if (tvdbExt && this.tvdb?.enabled) {
      try {
        // Best-effort: create seasons + episodes from TVDB so episode resolution works.
        // Never throws — degrades gracefully to NEEDS_REVIEW if TVDB fails.
        await this.meta.ensureShowFullTvdb(Number(tvdbExt.value)).catch(() => undefined);
      } catch {
        // ignore — episode resolve will just fail to needs_review
      }
    }
  }

  /**
   * Resolve an episode by season+number for a matched show. With `lenient` (used only for
   * manual "apply to all" resolution), falls back to the same episode number in any non-special
   * season when the exact season isn't found — this handles anthology imports where one source
   * show's seasons are distinct real shows with their own season 1 (e.g. "The Haunting" S2 →
   * Bly Manor, whose episodes are Bly Manor S1E1…E9, not S2). The main auto-import keeps strict
   * matching so S2 episodes aren't silently mapped to the wrong show's S1.
   */
  async resolveEpisode(
    mediaId: string,
    season: number,
    episode: number,
    lenient = false,
  ): Promise<string | null> {
    const key = `${mediaId}:${season}:${episode}:${lenient ? 'l' : 's'}`;
    if (this.episodeCache.has(key)) return this.episodeCache.get(key)!;
    let matches = await this.prisma.episode.findMany({
      where: {
        structureState: 'ACTIVE',
        season: { show: { mediaId }, number: season },
        number: episode,
      },
      take: 2,
    });
    if (matches.length !== 1 && lenient && season !== 0) {
      // Fallback: same episode number in the lowest non-special season of the show.
      matches = await this.prisma.episode.findMany({
        where: {
          structureState: 'ACTIVE',
          season: { show: { mediaId }, number: { not: 0 } },
          number: episode,
        },
        orderBy: { season: { number: 'asc' } },
        take: 2,
      });
    }
    const id = matches.length === 1 ? matches[0].id : null;
    // Only cache POSITIVE results — never cache null (the show may get hydrated later).
    if (id) this.episodeCache.set(key, id);
    return id;
  }

  classify(confidence: number): 'matched' | 'needs_review' | 'unmatched' {
    if (confidence >= 0.7) return 'matched';
    if (confidence >= 0.45) return 'needs_review';
    return 'unmatched';
  }
}

/**
 * Structural guard (pure): does the import's season/episode footprint exceed the show's
 * locally hydrated structure? True when the hydrated show cannot contain referenced
 * episodes — e.g. matched the TMDB structure of a show whose TVDB structure differs
 * (anthologies, reboot continuations, split/merged hour-longs), or a poisoned partial
 * hydration (rate-limited fetch stored 1 episode). The processor records this as a
 * diagnostic only; it never hydrates a second provider graph into the show.
 */
export function needsTvdbRehydration(
  footprint: {
    maxSeason?: number | null;
    seasonEpisodes?: { season: number; maxEpisode: number }[] | null;
  },
  hydrated: { maxSeason: number; maxEpisodeBySeason: Map<number, number> },
): boolean {
  if (
    footprint.maxSeason != null &&
    footprint.maxSeason > 0 &&
    hydrated.maxSeason < footprint.maxSeason
  ) {
    return true;
  }
  for (const se of footprint.seasonEpisodes ?? []) {
    if (se.season === 0) continue; // specials are optional everywhere
    if ((hydrated.maxEpisodeBySeason.get(se.season) ?? 0) < se.maxEpisode) return true;
  }
  return false;
}
