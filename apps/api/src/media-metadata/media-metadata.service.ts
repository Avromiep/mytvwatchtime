import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExternalProvider, MediaType, ProviderEntityKind, RecommendationDto } from '@tvwatch/shared';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { currentLanguage } from '../common/language.context';
import { mergeLocalized } from '../common/utils/localization.util';
import { mapMovie, mapSeason, mapShow } from '../common/utils/mapper.util';
import {
  NormalizedMovie,
  NormalizedSeason,
  NormalizedShow,
  TmdbProvider,
} from './providers/tmdb.provider';
import { TvdbProvider } from './providers/tvdb.provider';
import { TvmazeProvider } from './providers/tvmaze.provider';
import { HydrationQueue } from './hydration/hydration.queue';
import { ExternalReviewsService } from './external-reviews.service';
import { slugify } from './util/slugify';
import { EN_CONTENT_VERIFIER_VERSION } from './util/en-content-verifier';

/** Metadata is considered stale (eligible for a full refresh) after 24h. */
const DAY_MS = 1000 * 60 * 60 * 24;

@Injectable()
export class MediaMetadataService {
  private readonly logger = new Logger(MediaMetadataService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tmdb: TmdbProvider,
    private readonly tvdb: TvdbProvider,
    private readonly tvmaze: TvmazeProvider,
    private readonly config: ConfigService,
    private readonly hydration: HydrationQueue,
    private readonly redis: RedisService,
    private readonly externalReviews?: ExternalReviewsService,
  ) {}

  /** Enqueue classification, versioned by metadataRefreshedAt so each re-hydration re-runs
   *  once (not deduped against the earlier search-stub classify). Called on detail view. */
  async scheduleClassification(mediaId: string): Promise<void> {
    const r = await this.prisma.mediaItem.findUnique({
      where: { id: mediaId },
      select: { metadataRefreshedAt: true },
    });
    await this.hydration
      .enqueueClassifyCandidate({ mediaId }, String(r?.metadataRefreshedAt?.getTime() ?? 0))
      .catch(() => undefined);
  }

  get tmdbEnabled() {
    return this.tmdb.enabled;
  }

  get tvdbEnabled() {
    return this.tvdb?.enabled ?? false;
  }

  // ---- External lookup ----
  async findMediaByExternal(provider: ExternalProvider, value: string, kind?: ProviderEntityKind) {
    // Kind-aware when requested: TMDB/TVDB use SEPARATE id namespaces per entity type
    // (the same number is a different series vs movie) — hydration must not cross kinds.
    const ext = await this.prisma.externalId.findFirst({
      where: kind ? { provider, providerEntityKind: kind, value } : { provider, value },
      include: { media: true },
    });
    return ext?.media ?? null;
  }

  /** Namespace kind for media-level externals, derived from the structural media type. */
  private static kindOf(type: MediaType): ProviderEntityKind {
    return type === MediaType.SHOW ? ProviderEntityKind.SERIES : ProviderEntityKind.MOVIE;
  }

  /** Fetch the English base (title/overview/images) for a new TMDB media row, so the
   *  shared row is never created stuck in a single user's language. Best-effort. */
  private async fetchEnBase(type: MediaType, tmdbId: number) {
    if (!this.tmdb.enabled) return undefined;
    try {
      const base =
        type === MediaType.SHOW
          ? await this.tmdb.localizedShowBase(tmdbId, 'en-US')
          : await this.tmdb.localizedMovieBase(tmdbId, 'en-US');
      return base?.title ? base : undefined;
    } catch {
      return undefined;
    }
  }

  /** English TEXT base from TVDB (one translations call) for a new TVDB-origin row —
   *  same "never born stuck in one user's language" contract as fetchEnBase. Returns
   *  undefined unless TVDB actually has an English title (a missing title must NOT
   *  stamp title_locale='en' on a localized base). Best-effort. */
  private async fetchEnBaseTvdb(type: MediaType, tvdbId: number) {
    if (!this.tvdb.enabled) return undefined;
    try {
      const base =
        type === MediaType.SHOW
          ? await this.tvdb.localizedShowBase(tvdbId, 'eng')
          : await this.tvdb.localizedMovieBase(tvdbId, 'eng');
      return base?.title ? base : undefined;
    } catch {
      return undefined;
    }
  }

  /** Localized create fields for a NEW media row: English base (when available) plus
   *  the request-locale override. The base columns hold English so every language
   *  reads correctly via `override[lang] ?? override['en'] ?? base`. */
  private newMediaLocaleFields(
    item: {
      title: string;
      overview?: string | null;
      posterUrl?: string | null;
      backdropUrl?: string | null;
    },
    enBase:
      | {
          title?: string;
          overview?: string | null;
          posterUrl?: string | null;
          backdropUrl?: string | null;
        }
      | undefined,
    lang: string,
    trustRequestLocale = true,
  ) {
    const titleBase = mergeLocalized(null, 'en', enBase?.title, undefined);
    const overviewBase = mergeLocalized(null, 'en', enBase?.overview, undefined);
    const posterBase = mergeLocalized(null, 'en', enBase?.posterUrl, undefined);
    const backdropBase = mergeLocalized(null, 'en', enBase?.backdropUrl, undefined);
    const shouldStoreRequestLocale = trustRequestLocale && (lang !== 'en' || !enBase);
    const title = enBase?.title ?? item.title;
    const overview = enBase?.overview ?? item.overview;
    const titles = shouldStoreRequestLocale
      ? mergeLocalized(titleBase, lang, item.title, undefined)
      : titleBase;
    const overviews = shouldStoreRequestLocale
      ? mergeLocalized(overviewBase, lang, item.overview, undefined)
      : overviewBase;
    return {
      title,
      overview,
      posterUrl: enBase?.posterUrl ?? item.posterUrl,
      backdropUrl: enBase?.backdropUrl ?? item.backdropUrl,
      titleLocale: enBase ? 'en' : trustRequestLocale ? lang : 'und',
      titles,
      overviews,
      posterUrls: shouldStoreRequestLocale
        ? mergeLocalized(posterBase, lang, item.posterUrl, undefined)
        : posterBase,
      backdropUrls: shouldStoreRequestLocale
        ? mergeLocalized(backdropBase, lang, item.backdropUrl, undefined)
        : backdropBase,
      // Birth-stamp for the english-content verifier: the base was JUST read from the
      // provider's English slot, so the verifier would reach the exact same conclusion
      // (provider title == visible title → park) — without this stamp every non-ASCII
      // foreign title (TMDB falls back to the original title when no en translation
      // exists) entered the suspect pool at birth and needed one provider call per row
      // from the nightly cron to leave it, and live search traffic outgrew the drain.
      // The stamp records the values AS STORED so the IS DISTINCT FROM checks match.
      ...(enBase?.title
        ? {
            metadataProvenance: {
              enContentVerifiedTitle: titles.en ?? title,
              enContentVerifiedOverview: overviews.en ?? overview ?? '',
              enContentVerifiedAt: new Date().toISOString(),
              enContentVerifiedVersion: EN_CONTENT_VERIFIER_VERSION,
            },
          }
        : {}),
    };
  }

  // ---- Light upsert for list endpoints ----
  /**
   * Build the locale-override update for an existing media row and report whether
   * anything would actually change. mergeLocalized only ever touches the 'en' and
   * `lang` keys, so comparing those two keys before/after is enough — list
   * refreshes (trending/search/discover) re-send identical values on every call,
   * and skipping the no-op UPDATE halves the write load on those endpoints.
   */
  private localeOverrideUpdate(
    existing: { titles: any; overviews: any; posterUrls: any; backdropUrls: any },
    item: {
      title?: string;
      overview?: string | null;
      posterUrl?: string | null;
      backdropUrl?: string | null;
    },
    lang: string,
    englishBase?: {
      title?: string;
      overview?: string | null;
      posterUrl?: string | null;
      backdropUrl?: string | null;
    },
    opts?: { skipUntrustedEnglish?: boolean },
  ) {
    if (lang === 'en' && !englishBase && opts?.skipUntrustedEnglish) {
      return { data: {}, changed: false };
    }
    const localeItem = lang === 'en' && englishBase ? englishBase : item;
    const data = {
      titles: mergeLocalized(existing.titles as any, lang, localeItem.title, englishBase?.title),
      overviews: mergeLocalized(
        existing.overviews as any,
        lang,
        localeItem.overview,
        englishBase?.overview,
      ),
      posterUrls: mergeLocalized(
        existing.posterUrls as any,
        lang,
        localeItem.posterUrl,
        englishBase?.posterUrl,
      ),
      backdropUrls: mergeLocalized(
        existing.backdropUrls as any,
        lang,
        localeItem.backdropUrl,
        englishBase?.backdropUrl,
      ),
    };
    const same = (before: any, after: any) =>
      (before?.en ?? undefined) === (after?.en ?? undefined) &&
      (before?.[lang] ?? undefined) === (after?.[lang] ?? undefined);
    const changed =
      !same(existing.titles, data.titles) ||
      !same(existing.overviews, data.overviews) ||
      !same(existing.posterUrls, data.posterUrls) ||
      !same(existing.backdropUrls, data.backdropUrls);
    return { data, changed };
  }

  private isProviderSourcedTmdbLightItem(item: {
    overview?: string | null;
    posterUrl?: string | null;
    backdropUrl?: string | null;
    rating?: number | null;
    popularity?: number | null;
  }): boolean {
    return ['overview', 'posterUrl', 'backdropUrl', 'rating', 'popularity'].some((key) =>
      Object.prototype.hasOwnProperty.call(item, key),
    );
  }

  async lightUpsertShow(item: {
    tmdbId: number;
    title: string;
    overview?: string | null;
    posterUrl?: string | null;
    backdropUrl?: string | null;
    rating?: number | null;
    popularity?: number | null;
    year?: number | null;
  }): Promise<string> {
    const tmdbVal = String(item.tmdbId);
    const lang = currentLanguage();
    const existing = await this.findMediaByExternal(
      ExternalProvider.TMDB,
      tmdbVal,
      ProviderEntityKind.SERIES,
    );
    if (existing) {
      // List data is single-language: store it as a locale override only, never
      // overwriting the (English) base so other users aren't contaminated.
      const trustRequestLocale = lang !== 'en' || this.isProviderSourcedTmdbLightItem(item);
      const enBase = trustRequestLocale
        ? undefined
        : await this.fetchEnBase(MediaType.SHOW, item.tmdbId);
      const { data, changed } = this.localeOverrideUpdate(existing, item, lang, enBase, {
        skipUntrustedEnglish: !trustRequestLocale,
      });
      if (changed) {
        await this.prisma.mediaItem.update({ where: { id: existing.id }, data });
      }
      // Backfill a missing year on stubs created before search mapped the year.
      if (item.year) {
        await this.prisma.show
          .updateMany({
            where: { mediaId: existing.id, yearStart: null },
            data: { yearStart: item.year },
          })
          .catch(() => undefined);
      }
      return existing.id;
    }
    try {
      const created = await this.prisma.mediaItem.create({
        data: {
          ...this.newMediaLocaleFields(
            item,
            await this.fetchEnBase(MediaType.SHOW, item.tmdbId),
            lang,
            lang !== 'en' || this.isProviderSourcedTmdbLightItem(item),
          ),
          type: MediaType.SHOW,
          rating: item.rating ?? undefined,
          popularity: item.popularity ?? 0,
          show: {
            create: { yearStart: item.year ?? null, inProduction: true },
          },
          externalIds: {
            create: [
              {
                provider: ExternalProvider.TMDB,
                providerEntityKind: ProviderEntityKind.SERIES,
                value: tmdbVal,
              },
            ],
          },
        },
      });
      return created.id;
    } catch (e: any) {
      // Race condition: another concurrent call (search/import) created this media first.
      if (e?.code === 'P2002') {
        const found = await this.findMediaByExternal(
          ExternalProvider.TMDB,
          tmdbVal,
          ProviderEntityKind.SERIES,
        );
        if (found) return found.id;
      }
      throw e;
    }
  }

  async lightUpsertMovie(item: {
    tmdbId: number;
    title: string;
    overview?: string | null;
    posterUrl?: string | null;
    backdropUrl?: string | null;
    rating?: number | null;
    popularity?: number | null;
    year?: number | null;
  }): Promise<string> {
    const tmdbVal = String(item.tmdbId);
    const lang = currentLanguage();
    const existing = await this.findMediaByExternal(
      ExternalProvider.TMDB,
      tmdbVal,
      ProviderEntityKind.MOVIE,
    );
    if (existing) {
      const trustRequestLocale = lang !== 'en' || this.isProviderSourcedTmdbLightItem(item);
      const enBase = trustRequestLocale
        ? undefined
        : await this.fetchEnBase(MediaType.MOVIE, item.tmdbId);
      const { data, changed } = this.localeOverrideUpdate(existing, item, lang, enBase, {
        skipUntrustedEnglish: !trustRequestLocale,
      });
      if (changed) {
        await this.prisma.mediaItem.update({ where: { id: existing.id }, data });
      }
      if (item.year) {
        await this.prisma.movie
          .updateMany({
            where: { mediaId: existing.id, releaseYear: null },
            data: { releaseYear: item.year },
          })
          .catch(() => undefined);
      }
      return existing.id;
    }
    try {
      const created = await this.prisma.mediaItem.create({
        data: {
          ...this.newMediaLocaleFields(
            item,
            await this.fetchEnBase(MediaType.MOVIE, item.tmdbId),
            lang,
            lang !== 'en' || this.isProviderSourcedTmdbLightItem(item),
          ),
          type: MediaType.MOVIE,
          rating: item.rating ?? undefined,
          popularity: item.popularity ?? 0,
          movie: { create: { releaseYear: item.year ?? null } },
          externalIds: {
            create: [
              {
                provider: ExternalProvider.TMDB,
                providerEntityKind: ProviderEntityKind.MOVIE,
                value: tmdbVal,
              },
            ],
          },
        },
      });
      return created.id;
    } catch (e: any) {
      if (e?.code === 'P2002') {
        const found = await this.findMediaByExternal(
          ExternalProvider.TMDB,
          tmdbVal,
          ProviderEntityKind.MOVIE,
        );
        if (found) return found.id;
      }
      throw e;
    }
  }

  async lightUpsertShowTvdb(item: {
    tvdbId: number;
    title: string;
    overview?: string | null;
    posterUrl?: string | null;
    backdropUrl?: string | null;
    popularity?: number | null;
    year?: number | null;
  }): Promise<string> {
    const tvdbVal = String(item.tvdbId);
    const lang = currentLanguage();
    const existing = await this.findMediaByExternal(
      ExternalProvider.THE_TVDB,
      tvdbVal,
      ProviderEntityKind.SERIES,
    );
    if (existing) {
      const enBase = await this.fetchEnBaseTvdb(MediaType.SHOW, item.tvdbId);
      const { data, changed } = this.localeOverrideUpdate(existing, item, lang, enBase, {
        skipUntrustedEnglish: true,
      });
      if (changed) {
        await this.prisma.mediaItem.update({ where: { id: existing.id }, data });
      }
      if (item.year) {
        await this.prisma.show
          .updateMany({
            where: { mediaId: existing.id, yearStart: null },
            data: { yearStart: item.year },
          })
          .catch(() => undefined);
      }
      return existing.id;
    }

    // NOTE: NO title-based attach here — a TVDB id is authoritative for identity, a title
    // is not (US vs AU "Married at First Sight" collide; attaching by title poisoned the AU
    // row with the US id and mis-routed every later lookup). Unknown id = a new row, always.
    // The base is English whenever TVDB has an English title (fetched once, light) — the
    // request language lives in the override slots, so the row isn't born contaminated.
    const created = await this.prisma.mediaItem.create({
      data: {
        ...this.newMediaLocaleFields(
          item,
          await this.fetchEnBaseTvdb(MediaType.SHOW, item.tvdbId),
          lang,
          lang !== 'en',
        ),
        type: MediaType.SHOW,
        popularity: item.popularity ?? 0,
        show: { create: { yearStart: item.year ?? null, inProduction: true } },
        externalIds: {
          create: [
            {
              provider: ExternalProvider.THE_TVDB,
              providerEntityKind: ProviderEntityKind.SERIES,
              value: tvdbVal,
            },
          ],
        },
      },
    });
    return created.id;
  }

  /** Light-upsert a movie resolved from TVDB (backup provider). */
  async lightUpsertMovieTvdb(item: {
    tvdbId: number;
    title: string;
    overview?: string | null;
    posterUrl?: string | null;
    backdropUrl?: string | null;
    popularity?: number | null;
    year?: number | null;
  }): Promise<string> {
    const tvdbVal = String(item.tvdbId);
    const lang = currentLanguage();
    const existing = await this.findMediaByExternal(
      ExternalProvider.THE_TVDB,
      tvdbVal,
      ProviderEntityKind.MOVIE,
    );
    if (existing) {
      const enBase = await this.fetchEnBaseTvdb(MediaType.MOVIE, item.tvdbId);
      const { data, changed } = this.localeOverrideUpdate(existing, item, lang, enBase, {
        skipUntrustedEnglish: true,
      });
      if (changed) {
        await this.prisma.mediaItem.update({ where: { id: existing.id }, data });
      }
      if (item.year) {
        await this.prisma.movie
          .updateMany({
            where: { mediaId: existing.id, releaseYear: null },
            data: { releaseYear: item.year },
          })
          .catch(() => undefined);
      }
      return existing.id;
    }

    // NOTE: NO title-based attach here — a TVDB id is authoritative for identity, a title
    // is not (US vs AU "Married at First Sight" collide; attaching by title poisoned the AU
    // row with the US id and mis-routed every later lookup). Unknown id = a new row, always.
    // English base when TVDB has one (see the show path above).
    const created = await this.prisma.mediaItem.create({
      data: {
        ...this.newMediaLocaleFields(
          item,
          await this.fetchEnBaseTvdb(MediaType.MOVIE, item.tvdbId),
          lang,
          lang !== 'en',
        ),
        type: MediaType.MOVIE,
        popularity: item.popularity ?? 0,
        movie: { create: { releaseYear: item.year ?? null } },
        externalIds: {
          create: [
            {
              provider: ExternalProvider.THE_TVDB,
              providerEntityKind: ProviderEntityKind.MOVIE,
              value: tvdbVal,
            },
          ],
        },
      },
    });
    return created.id;
  }

  /** Populate the request-locale override (media title/overview/images) for list
   *  items that are missing it, so user-specific lists (watchlist/favorites/library)
   *  display localized without each item having been opened in detail first.
   *  Best-effort, one lightweight TMDb call per missing item (cached afterwards).
   *  Capped per call to avoid hammering TMDb on large lists; remaining items are
   *  localized on subsequent calls (already-localized ones are skipped). */
  async ensureListLocaleOverrides(mediaIds: string[]) {
    const lang = currentLanguage();
    if (lang === 'en' || !this.tmdb.enabled || mediaIds.length === 0) return;
    const rows = await this.prisma.mediaItem.findMany({
      where: { id: { in: mediaIds } },
      select: {
        id: true,
        type: true,
        titles: true,
        overviews: true,
        posterUrls: true,
        backdropUrls: true,
        externalIds: { select: { provider: true, value: true } },
      },
    });
    const missing = rows.filter((m) => !(m.titles as any)?.[lang]);
    const toFetch = missing.slice(0, 100); // bound TMDb calls per request (TMDb paces starts at ~40rps)
    await Promise.all(
      toFetch.map(async (m) => {
        const titles = m.titles as any;
        const tmdb = m.externalIds.find((e) => e.provider === ExternalProvider.TMDB);
        if (!tmdb) return;
        try {
          const base =
            m.type === MediaType.SHOW
              ? await this.tmdb.localizedShowBase(Number(tmdb.value), lang)
              : await this.tmdb.localizedMovieBase(Number(tmdb.value), lang);
          await this.prisma.mediaItem.update({
            where: { id: m.id },
            data: {
              titles: mergeLocalized(titles, lang, base.title, undefined),
              overviews: mergeLocalized(m.overviews as any, lang, base.overview, undefined),
              posterUrls: mergeLocalized(m.posterUrls as any, lang, base.posterUrl, undefined),
              backdropUrls: mergeLocalized(
                m.backdropUrls as any,
                lang,
                base.backdropUrl,
                undefined,
              ),
            },
          });
        } catch {
          // best-effort: leave English fallback for this item
        }
      }),
    );
  }

  /** Populate the request-locale override for EPISODES (title/overview/still) that
   *  are missing it, so episode titles localize in watch-next rails and episode
   *  detail without the show having been opened in detail first. Best-effort.
   *  Capped per call to avoid hammering TMDb on large lists; remaining episodes are
   *  localized on subsequent calls (already-localized ones are skipped). */
  async ensureEpisodeLocaleOverrides(episodeIds: string[]) {
    const lang = currentLanguage();
    if (lang === 'en' || !this.tmdb.enabled || episodeIds.length === 0) return;
    const eps = await this.prisma.episode.findMany({
      where: { id: { in: episodeIds } },
      select: {
        id: true,
        number: true,
        titles: true,
        overviews: true,
        stillUrls: true,
        season: {
          select: {
            number: true,
            show: {
              select: {
                media: { select: { externalIds: { select: { provider: true, value: true } } } },
              },
            },
          },
        },
      },
    });
    const missing = eps.filter((ep) => !(ep.titles as any)?.[lang]);
    const toFetch = missing.slice(0, 100); // bound TMDb calls per request (TMDb paces starts at ~40rps)
    await Promise.all(
      toFetch.map(async (ep) => {
        const tmdb = ep.season.show.media.externalIds.find(
          (e) => e.provider === ExternalProvider.TMDB,
        );
        if (!tmdb) return;
        try {
          const base = await this.tmdb.localizedEpisodeBase(
            Number(tmdb.value),
            ep.season.number,
            ep.number,
            lang,
          );
          await this.prisma.episode.update({
            where: { id: ep.id },
            data: {
              titles: mergeLocalized(ep.titles as any, lang, base.title, undefined),
              overviews: mergeLocalized(ep.overviews as any, lang, base.overview, undefined),
              stillUrls: mergeLocalized(ep.stillUrls as any, lang, base.stillUrl, undefined),
            },
          });
        } catch {
          // best-effort: leave English fallback for this episode
        }
      }),
    );
  }

  // ---- Full show/movie hydration ----
  /** A media row needs a full refresh when missing or older than 24h. */
  private isStale(existing: { metadataRefreshedAt?: Date | null } | null): boolean {
    return (
      !existing ||
      !existing.metadataRefreshedAt ||
      Date.now() - existing.metadataRefreshedAt.getTime() > DAY_MS
    );
  }

  /** Locales the provider had NO translation for are parked this long — re-requesting
   *  them on every view just re-fetches the same English fallback. */
  private static readonly LOCALE_UNAVAILABLE_PARK_MS = 7 * DAY_MS;

  /** Parked = we recently confirmed the provider has no translation for `lang` on this row. */
  isLocaleFetchParked(provenance: unknown, lang: string): boolean {
    const at = (provenance as any)?.localeUnavailable?.[lang];
    if (typeof at !== 'string') return false;
    const t = new Date(at).getTime();
    return (
      Number.isFinite(t) && Date.now() - t < MediaMetadataService.LOCALE_UNAVAILABLE_PARK_MS
    );
  }

  /** Record that the provider has no translation for `lang` (atomic jsonb merge — no
   *  read-modify-write of the whole provenance column). */
  private async stampLocaleUnavailable(mediaId: string, lang: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE media_items
      SET metadata_provenance = COALESCE(metadata_provenance, '{}'::jsonb)
            || jsonb_build_object('localeUnavailable',
                 COALESCE(metadata_provenance->'localeUnavailable', '{}'::jsonb)
                 || jsonb_build_object(${lang}::text, ${new Date().toISOString()}::text))
      WHERE id = ${mediaId}`;
  }

  /** Does the provider's translations map cover `lang`? undefined = the provider gave no
   *  translations payload, so we can't tell (never park on silence). App locales match
   *  exactly, then by their 2-letter base (TMDB keys are ISO 639-1: pt-BR → pt). */
  private translationsCoverLang(
    translations: Record<string, unknown> | undefined,
    lang: string,
  ): boolean | undefined {
    if (!translations) return undefined;
    if (translations[lang]) return true;
    const base = lang.split('-')[0];
    return base !== lang ? !!translations[base] : false;
  }

  /**
   * Fetch + store the request-locale overrides — unless the locale is parked, or the
   * base payload's translations map proves the provider doesn't have it (then park it
   * and skip the call). When only the localized response itself can tell (fresh base),
   * a missing translation is parked WITHOUT storing the provider's English fallback
   * under the locale key.
   */
  private async maybeApplyLocaleOverrides(
    mediaId: string,
    type: MediaType,
    fetchLocalized: () => Promise<NormalizedShow | NormalizedMovie>,
    baseTranslations: Record<string, { title?: string; overview?: string }> | undefined,
    existingProvenance: unknown,
    lang: string,
  ): Promise<void> {
    if (lang === 'en') return;
    if (this.isLocaleFetchParked(existingProvenance, lang)) return;
    const covered = this.translationsCoverLang(baseTranslations, lang);
    if (covered === false) {
      await this.stampLocaleUnavailable(mediaId, lang).catch(() => undefined);
      return;
    }
    const data = await fetchLocalized();
    if (covered === undefined && this.translationsCoverLang(data.translations, lang) === false) {
      await this.stampLocaleUnavailable(mediaId, lang).catch(() => undefined);
      return;
    }
    await this.applyLocaleOverrides(mediaId, type, data, lang);
  }

  /**
   * Predicate for `TmdbProvider.getShow`: skip the individual season-detail fetch for
   * seasons we already store COMPLETE and fully aired (re-hydrations only — first
   * hydrations fetch everything). A season is skippable when ALL hold:
   *   - not season 0 (specials churn too much),
   *   - stored episodeCount > 0 and equal to the provider's summary episode_count
   *     (any structural change → refetch),
   *   - every stored episode has an airDate and the latest aired > 7 days ago
   *     (post-air correction buffer).
   * Skipped seasons are filtered out of the normalized payload before persistShow, so
   * syncSeasons leaves their rows (airedCount, texts, locale overrides) untouched.
   */
  private async airedSeasonSkipper(
    mediaId: string,
  ): Promise<(seasonNumber: number, providerEpisodeCount: number) => boolean> {
    const seasons = await this.prisma.season.findMany({
      where: { show: { mediaId } },
      select: { number: true, episodeCount: true, episodes: { select: { airDate: true } } },
    });
    const byNumber = new Map(seasons.map((s) => [s.number, s]));
    const cutoff = Date.now() - 7 * DAY_MS;
    return (seasonNumber, providerEpisodeCount) => {
      if (seasonNumber === 0) return false;
      const stored = byNumber.get(seasonNumber);
      if (!stored || (stored.episodeCount ?? 0) === 0) return false;
      if (stored.episodeCount !== providerEpisodeCount) return false;
      if (stored.episodes.length === 0) return false;
      let maxAir = 0;
      for (const e of stored.episodes) {
        if (!e.airDate) return false;
        const t = e.airDate.getTime();
        if (t > maxAir) maxAir = t;
      }
      return maxAir < cutoff;
    };
  }

  /** Drop seasons whose detail fetch was skipped (no episodes loaded AND the skipper
   *  covers them) so syncSeasons never upserts a shell over their stored data. */
  private filterSkippedSeasons(
    data: NormalizedShow,
    skip: (seasonNumber: number, providerEpisodeCount: number) => boolean,
  ): void {
    data.seasons = data.seasons.filter(
      (se) => se.episodes.length > 0 || !skip(se.number, se.episodeCount ?? 0),
    );
  }

  async ensureShowFull(
    tmdbId: number,
    userId?: string,
    opts?: { skipAiredSeasons?: boolean },
  ): Promise<string> {
    const lang = currentLanguage();
    const tmdbVal = String(tmdbId);
    const existing = await this.findMediaByExternal(
      ExternalProvider.TMDB,
      tmdbVal,
      ProviderEntityKind.SERIES,
    );
    let mediaId: string;
    let externals: { provider: ExternalProvider; value: string }[] = [];
    if (this.isStale(existing)) {
      // Interactive detail views skip refetching complete+fully-aired old seasons
      // (latency). Background paths (backfill, repairs, TMDB changes sync) must NOT:
      // their goal is full-structure correctness — e.g. the english-content repair
      // rewrites episode text and the changes sync exists to catch old-season edits.
      const skipSeasonDetail =
        existing && opts?.skipAiredSeasons ? await this.airedSeasonSkipper(existing.id) : undefined;
      const getOpts = skipSeasonDetail ? { skipSeasonDetail } : undefined;
      // ONE English call (appended seasons/keywords/translations): base + episodes stay
      // English; show-level locales come from the translations payload — no second fetch.
      const enData = await this.tmdb.getShow(tmdbId, 'en-US', getOpts);
      if (skipSeasonDetail) this.filterSkippedSeasons(enData, skipSeasonDetail);
      externals = enData.externals;
      mediaId = await this.persistShow(
        enData,
        existing?.id,
        'en',
        undefined,
        ExternalProvider.TMDB,
      );
      await this.maybeApplyLocaleOverrides(
        mediaId,
        MediaType.SHOW,
        async () => {
          const data = await this.tmdb.getShow(tmdbId, lang, getOpts);
          externals = data.externals;
          return data;
        },
        enData.translations,
        existing?.metadataProvenance,
        lang,
      );
    } else if (lang !== 'en' && existing) {
      // Fresh trusted base: store ONLY the request-locale override — no base change,
      // no English re-fetch — so different users' languages never contaminate each other.
      mediaId = existing.id;
      await this.maybeApplyLocaleOverrides(
        mediaId,
        MediaType.SHOW,
        async () => {
          const data = await this.tmdb.getShow(tmdbId, lang);
          externals = data.externals;
          return data;
        },
        undefined,
        existing.metadataProvenance,
        lang,
      );
    } else {
      mediaId = existing!.id;
    }
    if (userId) {
      await this.ensureUserShowTotals(userId, mediaId);
    }
    // Fill precise air times/dates from TVmaze (best-effort, outside the tx).
    await this.enrichAirtimes(mediaId, externals).catch((e) =>
      this.logger.debug(`TVmaze enrich skipped: ${(e as Error).message}`),
    );
    // Genres are now persisted → run anime candidate detection (idempotent, deduped).
    await this.scheduleClassification(mediaId);
    return mediaId;
  }

  /**
   * TVDB exposes no public 0–10 rating, so TVDB-hydrated rows are born unrated.
   * When the row ALSO carries a TMDB id, fill the rating with ONE light TMDB base
   * call (vote_average). Best-effort and self-limiting: only runs while the row
   * has no rating. This makes every TVDB-hydration-driven repair (anime rehydrate,
   * character-ids, banner posters, type-mismatch recreation) also heal ratings.
   */
  private async fillRatingFromTmdbIfMissing(mediaId: string, type: MediaType) {
    try {
      const kind = type === MediaType.SHOW ? ProviderEntityKind.SERIES : ProviderEntityKind.MOVIE;
      const media = await this.prisma.mediaItem.findUnique({
        where: { id: mediaId },
        select: {
          rating: true,
          externalIds: {
            where: { provider: ExternalProvider.TMDB, providerEntityKind: kind },
            select: { value: true },
            take: 1,
          },
        },
      });
      if (!media || media.rating != null || !this.tmdb.enabled) return;
      const tmdbIdRaw = media.externalIds[0]?.value;
      if (!tmdbIdRaw) return;
      const base =
        type === MediaType.SHOW
          ? await this.tmdb.localizedShowBase(Number(tmdbIdRaw), 'en-US')
          : await this.tmdb.localizedMovieBase(Number(tmdbIdRaw), 'en-US');
      if (base.rating != null && base.rating > 0) {
        await this.prisma.mediaItem.update({
          where: { id: mediaId },
          data: { rating: base.rating },
        });
      }
    } catch (e) {
      this.logger.debug(`rating fill skipped for ${mediaId}: ${(e as Error).message}`);
    }
  }

  async ensureShowFullTvdb(
    tvdbId: number,
    userId?: string,
    opts?: { skipClassification?: boolean },
  ): Promise<string> {
    const lang = currentLanguage();
    const tvdbVal = String(tvdbId);
    const existing = await this.findMediaByExternal(
      ExternalProvider.THE_TVDB,
      tvdbVal,
      ProviderEntityKind.SERIES,
    );
    let mediaId: string;
    let externals: { provider: ExternalProvider; value: string }[] = [];
    if (this.isStale(existing)) {
      const data = await this.tvdb.getShow(tvdbId, lang); // pass locale → episodes get correct language
      externals = data.externals;
      const enData = lang !== 'en' ? await this.tvdb.getShow(tvdbId, 'en') : undefined;
      mediaId = await this.persistShow(data, existing?.id, lang, enData, ExternalProvider.THE_TVDB);
      // TVDB lacks this locale entirely → park it so fresh views skip the re-fetch.
      if (lang !== 'en' && this.translationsCoverLang(data.translations, lang) === false) {
        await this.stampLocaleUnavailable(mediaId, lang).catch(() => undefined);
      }
    } else if (lang !== 'en' && existing) {
      mediaId = existing.id;
      await this.maybeApplyLocaleOverrides(
        mediaId,
        MediaType.SHOW,
        async () => {
          const data = await this.tvdb.getShow(tvdbId, lang);
          externals = data.externals;
          return data;
        },
        undefined,
        existing.metadataProvenance,
        lang,
      );
    } else {
      mediaId = existing!.id;
    }
    if (userId) {
      await this.ensureUserShowTotals(userId, mediaId);
    }
    await this.enrichAirtimes(mediaId, externals).catch((e) =>
      this.logger.debug(`TVmaze enrich skipped: ${(e as Error).message}`),
    );
    // Cast-only rehydrations (character-id backfill, import tvdb-rehydrate) skip the
    // classification enqueue — the anime evidence (genres/origin/keywords) does not
    // change from a same-provider cast refresh, and the enqueue storm saturates Jikan.
    if (!opts?.skipClassification) await this.scheduleClassification(mediaId);
    await this.fillRatingFromTmdbIfMissing(mediaId, MediaType.SHOW);
    return mediaId;
  }

  /** Fully hydrate a movie resolved from TVDB. ONE call — meta=translations returns ALL locales. */
  async ensureMovieFullTvdb(tvdbId: number): Promise<string> {
    const lang = currentLanguage();
    const tvdbVal = String(tvdbId);
    const existing = await this.findMediaByExternal(
      ExternalProvider.THE_TVDB,
      tvdbVal,
      ProviderEntityKind.MOVIE,
    );
    let mediaId: string;
    if (this.isStale(existing)) {
      const data = await this.tvdb.getMovie(tvdbId, lang);
      // No second call needed: data.translations already has ALL locales (including English).
      // persistMovie bulk-stores them all via mergeLocalized.
      mediaId = await this.persistMovie(data, existing?.id, lang, undefined, ExternalProvider.THE_TVDB);
      // TVDB lacks this locale entirely → park it so fresh views skip the re-fetch.
      if (lang !== 'en' && this.translationsCoverLang(data.translations, lang) === false) {
        await this.stampLocaleUnavailable(mediaId, lang).catch(() => undefined);
      }
    } else if (lang !== 'en' && existing) {
      mediaId = existing.id;
      await this.maybeApplyLocaleOverrides(
        mediaId,
        MediaType.MOVIE,
        () => this.tvdb.getMovie(tvdbId, lang),
        undefined,
        existing.metadataProvenance,
        lang,
      );
    } else {
      mediaId = existing!.id;
    }
    await this.scheduleClassification(mediaId);
    await this.fillRatingFromTmdbIfMissing(mediaId, MediaType.MOVIE);
    return mediaId;
  }

  /**
   * Store ONLY the request-locale overrides (titles/overviews/images, plus season
   * & episode text for shows) for a media whose English base is already fresh and
   * trusted. Base columns are never touched, so one user's language can't overwrite
   * another's. Cast character names and genre names are not localized here (they
   * refresh with the periodic full hydrate); this keeps the path cheap (one fetch).
   */
  private async applyLocaleOverrides(
    mediaId: string,
    type: MediaType,
    data: NormalizedShow | NormalizedMovie,
    lang: string,
  ) {
    await this.prisma.$transaction(
      async (tx) => {
        const media = await tx.mediaItem.findUnique({
          where: { id: mediaId },
          select: { titles: true, overviews: true, posterUrls: true, backdropUrls: true },
        });
        if (media) {
          await tx.mediaItem.update({
            where: { id: mediaId },
            data: {
              titles: mergeLocalized(media.titles as any, lang, data.title, undefined),
              overviews: mergeLocalized(media.overviews as any, lang, data.overview, undefined),
              posterUrls: mergeLocalized(media.posterUrls as any, lang, data.posterUrl, undefined),
              backdropUrls: mergeLocalized(
                media.backdropUrls as any,
                lang,
                data.backdropUrl,
                undefined,
              ),
            },
          });
        }
        if (type !== MediaType.SHOW) return;
        const show = await tx.show.findUnique({ where: { mediaId }, select: { id: true } });
        if (!show) return;
        const seasons = (data as NormalizedShow).seasons ?? [];
        const existingSeasons = await tx.season.findMany({
          where: { showId: show.id },
          select: {
            id: true,
            number: true,
            titles: true,
            overviews: true,
            posterUrls: true,
            episodes: {
              select: { id: true, number: true, titles: true, overviews: true, stillUrls: true },
            },
          },
        });
        const seasonMap = new Map(existingSeasons.map((s) => [s.number, s]));
        for (const s of seasons) {
          const prev = seasonMap.get(s.number);
          if (!prev) continue;
          await tx.season.update({
            where: { id: prev.id },
            data: {
              titles: mergeLocalized(prev.titles as any, lang, s.title, undefined),
              overviews: mergeLocalized(prev.overviews as any, lang, s.overview, undefined),
              posterUrls: mergeLocalized(prev.posterUrls as any, lang, s.posterUrl, undefined),
            },
          });
          const epMap = new Map(prev.episodes.map((e) => [e.number, e]));
          for (const e of s.episodes) {
            const prevEp = epMap.get(e.number);
            if (!prevEp) continue;
            await tx.episode.update({
              where: { id: prevEp.id },
              data: {
                titles: mergeLocalized(prevEp.titles as any, lang, e.title, undefined),
                overviews: mergeLocalized(prevEp.overviews as any, lang, e.overview, undefined),
                stillUrls: mergeLocalized(prevEp.stillUrls as any, lang, e.stillUrl, undefined),
              },
            });
          }
        }
      },
      { timeout: 60_000 },
    );
  }

  private async enrichAirtimes(
    mediaId: string,
    externals: { provider: ExternalProvider; value: string }[],
  ) {
    if (!this.tvmaze.enabled) return;
    const tvdb = externals.find((e) => e.provider === ExternalProvider.THE_TVDB)?.value;
    const imdb = externals.find((e) => e.provider === ExternalProvider.IMDB)?.value;
    if (!tvdb && !imdb) return;
    // Shared by scheduled refresh, show-detail reads, and full show hydrations/repairs.
    // TVmaze doesn't cover every show and rate-limits aggressively, so every path gets
    // the same per-show cooldown instead of hydration jobs bypassing it.
    const marker = `airtimes:tried:${mediaId}`;
    if (await this.redis.get(marker)) return;
    await this.redis.set(marker, 1, 6 * 3600);
    const map = await this.tvmaze.getEpisodeAirTimes(tvdb, imdb);
    if (map.size === 0) return;
    const eps = await this.prisma.episode.findMany({
      where: { season: { show: { mediaId } } },
      select: { id: true, number: true, season: { select: { number: true } } },
    });
    // One UPDATE ... FROM (VALUES ...) for the whole show — the old loop issued one
    // serial UPDATE per episode (500+ round trips on long-running shows).
    const updates: { id: string; airTime: string | null; airDate: Date | null }[] = [];
    for (const e of eps) {
      const air = map.get(`${e.season.number}-${e.number}`);
      if (!air) continue;
      updates.push({
        id: e.id,
        airTime: air.airtime ?? null,
        airDate: air.airstamp ? new Date(air.airstamp) : null,
      });
    }
    if (!updates.length) return;
    const values = updates.map((u) => Prisma.sql`(${u.id}, ${u.airTime}, ${u.airDate})`);
    await this.prisma.$executeRaw`
      UPDATE episodes e
      SET air_time = v.air_time,
          air_date = COALESCE(v.air_date::timestamptz, e.air_date)
      FROM (VALUES ${Prisma.join(values)}) AS v(id, air_time, air_date)
      WHERE e.id = v.id
    `;
  }

  /** Populate per-episode air times from TVmaze if any are missing (idempotent / cached). */
  async ensureAirtimes(mediaId: string) {
    if (!this.tvmaze.enabled) return;
    const missing = await this.prisma.episode.count({
      where: { season: { show: { mediaId } }, airTime: null },
    });
    if (missing === 0) return;
    const exts = await this.prisma.externalId.findMany({
      where: { mediaId },
      select: { provider: true, value: true },
    });
    await this.enrichAirtimes(mediaId, exts as any);
  }

  async ensureMovieFull(tmdbId: number): Promise<string> {
    const lang = currentLanguage();
    const tmdbVal = String(tmdbId);
    const existing = await this.findMediaByExternal(
      ExternalProvider.TMDB,
      tmdbVal,
      ProviderEntityKind.MOVIE,
    );
    let mediaId: string;
    if (this.isStale(existing)) {
      // ONE English call — base + all show-level locales via the translations payload.
      const data = await this.tmdb.getMovie(tmdbId, 'en-US');
      mediaId = await this.persistMovie(data, existing?.id, 'en', undefined);
      await this.maybeApplyLocaleOverrides(
        mediaId,
        MediaType.MOVIE,
        () => this.tmdb.getMovie(tmdbId, lang),
        data.translations,
        existing?.metadataProvenance,
        lang,
      );
    } else if (lang !== 'en' && existing) {
      mediaId = existing.id;
      await this.maybeApplyLocaleOverrides(
        mediaId,
        MediaType.MOVIE,
        () => this.tmdb.getMovie(tmdbId, lang),
        undefined,
        existing.metadataProvenance,
        lang,
      );
    } else {
      mediaId = existing!.id;
    }
    await this.scheduleClassification(mediaId);
    return mediaId;
  }

  private async persistShow(
    data: NormalizedShow,
    existingId?: string,
    lang: string = currentLanguage(),
    enData?: NormalizedShow,
    // Provider of the episode ids carried in `data.seasons[].episodes[].tmdbId`
    // (TMDB id for TMDB hydration; TVDB id smuggled into the same field for TVDB hydration).
    episodeExternalProvider: ExternalProvider = ExternalProvider.TMDB,
  ): Promise<string> {
    // 60s timeout (default 5s): thousand-episode shows (Come Home Love, Super Sentai,
    // The Price is Right) upsert thousands of rows in this tx — the 5s default killed
    // the transaction mid-sync ("Transaction already closed / not found").
    const mediaId = await this.prisma.$transaction(
      async (tx) => {
        // Existing JSON (to merge locale overrides without clobbering other locales).
        let prev = existingId
          ? await tx.mediaItem.findUnique({
              where: { id: existingId },
              select: {
                titles: true,
                overviews: true,
                posterUrls: true,
                backdropUrls: true,
                type: true,
              },
            })
          : null;
        // Cross-type guard: series data must NEVER merge into a MOVIE row (TMDB/TVDB use
        // separate movie/series id namespaces — a shared number is a different entity).
        if (prev && prev.type !== MediaType.SHOW) {
          this.logger.warn(
            `persistShow: refusing to merge series into ${prev.type} row ${existingId} — creating a new show row`,
          );
          existingId = undefined;
          prev = null;
        }
        const base = enData ?? data; // English base when available, else the fetched locale
        const genres = await this.upsertGenres(tx, data.genres, lang, enData?.genres);
        const providers = await this.upsertProviders(tx, data.providers);
        const castMembers = await this.upsertCast(tx, data.cast);

        let titles = mergeLocalized(prev?.titles as any, lang, data.title, enData?.title);
        let overviews = mergeLocalized(
          prev?.overviews as any,
          lang,
          data.overview,
          enData?.overview,
        );
        // Bulk-store every locale from the appended translations payload as overrides, so a
        // later view in another language never forces a full re-hydration.
        if (data.translations) {
          for (const [loc, tr] of Object.entries(data.translations)) {
            titles = mergeLocalized(titles as any, loc, tr.title ?? undefined, undefined);
            overviews = mergeLocalized(overviews as any, loc, tr.overview ?? undefined, undefined);
          }
        }
        const mediaData = {
          title: base.title,
          overview: base.overview,
          posterUrl: base.posterUrl,
          backdropUrl: base.backdropUrl,
          rating: data.rating,
          status: data.status,
          popularity: data.popularity ?? 0,
          trailerUrl: data.trailerUrl,
          metadataRefreshedAt: new Date(),
          // The marker describes the base JUST WRITTEN (base = enData ?? data in `lang`).
          // Never inherit prev.titleLocale — a stale non-en marker would survive an
          // English re-hydration and the row would stay "non-English base" forever.
          titleLocale: enData ? 'en' : lang,
          titles,
          overviews,
          posterUrls: mergeLocalized(
            prev?.posterUrls as any,
            lang,
            data.posterUrl,
            enData?.posterUrl,
          ),
          backdropUrls: mergeLocalized(
            prev?.backdropUrls as any,
            lang,
            data.backdropUrl,
            enData?.backdropUrl,
          ),
          // TVDB supplies no recommendations — never clobber the TMDB snapshot.
          ...(data.recommendations
            ? { recommendations: data.recommendations as any, recommendationsSyncedAt: new Date() }
            : {}),
          // TVDB supplies no watch offers — never clobber the TMDB per-country blob.
          ...(data.providersByCountry ? { watchProviders: data.providersByCountry as any } : {}),
        };

        let mediaId = existingId;
        if (existingId) {
          await tx.mediaItem.update({ where: { id: existingId }, data: mediaData });
        } else {
          const created = await tx.mediaItem.create({
            data: {
              ...mediaData,
              type: MediaType.SHOW,
              // Externals attach via the conflict-safe upsert loop below — a parked id on
              // another row must never abort the whole hydration with a P2002.
            },
          });
          mediaId = created.id;
        }

        // upsert externals (in case new ones appeared)
        for (const e of data.externals) {
          await tx.externalId.upsert({
            where: {
              provider_providerEntityKind_value: {
                provider: e.provider,
                providerEntityKind: ProviderEntityKind.SERIES,
                value: e.value,
              },
            },
            create: {
              mediaId: mediaId!,
              provider: e.provider,
              providerEntityKind: ProviderEntityKind.SERIES,
              value: e.value,
            },
            update: {},
          });
        }

        await tx.show.upsert({
          where: { mediaId: mediaId! },
          create: {
            mediaId: mediaId!,
            yearStart: data.yearStart,
            yearEnd: data.yearEnd,
            network: data.network,
            runtimeMinutes: data.runtimeMinutes,
            nextAirDate: data.nextAirDate ? new Date(data.nextAirDate) : null,
            seasonsCount: data.seasonsCount,
            episodesCount: data.episodesCount,
            inProduction: data.inProduction,
            originalLanguage: data.originalLanguage ?? null,
            originalTitle: data.originalTitle ?? null,
            originCountries: data.originCountries ?? [],
            keywords: (data.keywords as any) ?? undefined,
          },
          update: {
            yearStart: data.yearStart,
            yearEnd: data.yearEnd,
            network: data.network,
            runtimeMinutes: data.runtimeMinutes,
            nextAirDate: data.nextAirDate ? new Date(data.nextAirDate) : null,
            seasonsCount: data.seasonsCount,
            episodesCount: data.episodesCount,
            inProduction: data.inProduction,
            // Only TMDB supplies origin evidence — preserve existing values on TVDB refreshes.
            ...(data.originalLanguage !== undefined
              ? { originalLanguage: data.originalLanguage }
              : {}),
            ...(data.originalTitle !== undefined ? { originalTitle: data.originalTitle } : {}),
            ...(data.originCountries !== undefined
              ? { originCountries: data.originCountries }
              : {}),
            // TVDB supplies no keywords — never clobber TMDB-persisted ones.
            ...(data.keywords ? { keywords: data.keywords as any } : {}),
          },
        });

        await this.syncGenres(tx, mediaId!, genres);
        // TVDB supplies no watch offers (empty array) — syncing from it would WIPE the
        // TMDB-persisted provider links. Only TMDB hydration is authoritative for offers.
        if (episodeExternalProvider === ExternalProvider.TMDB) {
          await this.syncProviders(tx, mediaId!, providers);
        }
        await this.syncCast(tx, mediaId!, castMembers, data.cast, lang, enData?.cast);
        await this.syncSeasons(
          tx,
          mediaId!,
          data.seasons,
          lang,
          enData?.seasons,
          episodeExternalProvider,
        );

        return mediaId!;
      },
      { timeout: 60_000 },
    );
    // TMDB reviews ride the one-call hydration (append=reviews); TVDB carries none.
    if (data.reviews && this.externalReviews) {
      await this.externalReviews
        .syncMediaReviews(mediaId!, data.reviews)
        .catch((e) =>
          this.logger.debug(`Review sync skipped for ${mediaId}: ${(e as Error).message}`),
        );
    }
    return mediaId!;
  }

  private async persistMovie(
    data: NormalizedMovie,
    existingId?: string,
    lang: string = currentLanguage(),
    enData?: NormalizedMovie,
    // Source of `data` — only TMDB hydration is authoritative for watch offers
    // (TVDB supplies none; syncing from it would wipe TMDB-persisted links).
    source: ExternalProvider = ExternalProvider.TMDB,
  ): Promise<string> {
    const mediaId = await this.prisma.$transaction(
      async (tx) => {
        let prev = existingId
          ? await tx.mediaItem.findUnique({
              where: { id: existingId },
              select: {
                titles: true,
                overviews: true,
                posterUrls: true,
                backdropUrls: true,
                type: true,
              },
            })
          : null;
        // Cross-type guard (mirror of persistShow): movie data must NEVER merge into a SHOW row.
        if (prev && prev.type !== MediaType.MOVIE) {
          this.logger.warn(
            `persistMovie: refusing to merge movie into ${prev.type} row ${existingId} — creating a new movie row`,
          );
          existingId = undefined;
          prev = null;
        }
        const genres = await this.upsertGenres(tx, data.genres, lang, enData?.genres);
        const providers = await this.upsertProviders(tx, data.providers);
        const castMembers = await this.upsertCast(tx, data.cast);

        const englishTranslation = data.translations?.en;
        const englishBase =
          enData ??
          (englishTranslation?.title?.trim()
            ? {
                ...data,
                title: englishTranslation.title.trim(),
                overview: englishTranslation.overview ?? data.overview,
              }
            : undefined);

        let titles = mergeLocalized(prev?.titles as any, lang, data.title, englishBase?.title);
        let overviews = mergeLocalized(
          prev?.overviews as any,
          lang,
          data.overview,
          englishBase?.overview,
        );
        // Bulk-store ALL translations from the provider (e.g. TVDB movie meta=translations).
        if (data.translations) {
          for (const [loc, tr] of Object.entries(data.translations)) {
            titles = mergeLocalized(titles as any, loc, tr.title ?? undefined, undefined);
            overviews = mergeLocalized(overviews as any, loc, tr.overview ?? undefined, undefined);
          }
        }

        const base = englishBase ?? data;
        const mediaData = {
          title: base.title,
          overview: base.overview,
          posterUrl: base.posterUrl,
          backdropUrl: base.backdropUrl,
          rating: data.rating,
          popularity: data.popularity ?? 0,
          trailerUrl: data.trailerUrl,
          metadataRefreshedAt: new Date(),
          // The marker describes the base JUST WRITTEN (base = enData ?? data in `lang`).
          // Never inherit prev.titleLocale — a stale non-en marker would survive an
          // English re-hydration and the row would stay "non-English base" forever.
          titleLocale: englishBase ? 'en' : lang,
          titles,
          overviews,
          posterUrls: mergeLocalized(
            prev?.posterUrls as any,
            lang,
            data.posterUrl,
            englishBase?.posterUrl,
          ),
          backdropUrls: mergeLocalized(
            prev?.backdropUrls as any,
            lang,
            data.backdropUrl,
            englishBase?.backdropUrl,
          ),
          // TVDB supplies no recommendations — never clobber the TMDB snapshot.
          ...(data.recommendations
            ? { recommendations: data.recommendations as any, recommendationsSyncedAt: new Date() }
            : {}),
          // TVDB supplies no watch offers — never clobber the TMDB per-country blob.
          ...(data.providersByCountry ? { watchProviders: data.providersByCountry as any } : {}),
        };

        let mediaId = existingId;
        if (existingId) {
          await tx.mediaItem.update({ where: { id: existingId }, data: mediaData });
        } else {
          const created = await tx.mediaItem.create({
            data: {
              ...mediaData,
              type: MediaType.MOVIE,
              // Externals attach via the conflict-safe upsert loop below (same as persistShow).
            },
          });
          mediaId = created.id;
        }

        // Upsert externals (conflict-safe: a parked id on another row is left in place).
        for (const e of data.externals) {
          await tx.externalId.upsert({
            where: {
              provider_providerEntityKind_value: {
                provider: e.provider,
                providerEntityKind: ProviderEntityKind.MOVIE,
                value: e.value,
              },
            },
            create: {
              mediaId: mediaId!,
              provider: e.provider,
              providerEntityKind: ProviderEntityKind.MOVIE,
              value: e.value,
            },
            update: {},
          });
        }

        await tx.movie.upsert({
          where: { mediaId: mediaId! },
          create: {
            mediaId: mediaId!,
            releaseDate: data.releaseDate ? new Date(data.releaseDate) : null,
            releaseYear: data.releaseYear,
            runtimeMinutes: data.runtimeMinutes,
            country: data.country,
            language: data.language,
            ...(data.keywords ? { keywords: data.keywords as any } : {}),
          },
          update: {
            releaseDate: data.releaseDate ? new Date(data.releaseDate) : null,
            releaseYear: data.releaseYear,
            runtimeMinutes: data.runtimeMinutes,
            country: data.country,
            language: data.language,
            ...(data.keywords ? { keywords: data.keywords as any } : {}),
          },
        });

        await this.syncGenres(tx, mediaId!, genres);
        // Only TMDB hydration is authoritative for watch offers (see persistShow).
        if (source === ExternalProvider.TMDB) {
          await this.syncProviders(tx, mediaId!, providers);
        }
        await this.syncCast(tx, mediaId!, castMembers, data.cast, lang, englishBase?.cast);

        return mediaId!;
      },
      { timeout: 60_000 },
    );
    // TMDB reviews ride the one-call hydration (append=reviews); TVDB carries none.
    if (data.reviews && this.externalReviews) {
      await this.externalReviews
        .syncMediaReviews(mediaId!, data.reviews)
        .catch((e) =>
          this.logger.debug(`Review sync skipped for ${mediaId}: ${(e as Error).message}`),
        );
    }
    return mediaId!;
  }

  // ---- Read helpers ----
  private fullShowInclude(userId?: string) {
    return {
      show: { include: { seasons: { include: { episodes: true } } } },
      genres: { include: { genre: true } },
      providers: { include: { provider: true } },
      cast: { include: { castMember: true } },
      externalIds: true,
      ...(userId
        ? {
            watchlist: { where: { userId }, select: { id: true } },
            favorites: { where: { userId }, select: { id: true } },
            showStatuses: {
              where: { userId },
              select: { id: true, watchedCount: true, totalCount: true, pausedAt: true },
            },
          }
        : {}),
    } as const;
  }

  async getShowDetail(mediaId: string, userId?: string) {
    const media = await this.prisma.mediaItem.findUnique({
      where: { id: mediaId },
      include: this.fullShowInclude(userId),
    });
    if (!media || !media.show) throw new NotFoundException('Show not found');
    const dto = mapShow(media as any, userId);
    // "Original title" is a details-page-only extra, and only for ANIME whose original
    // language isn't the user's (e.g. a Japanese title for an English user). Anything
    // else keeps the field empty so non-anime originals never clutter the page.
    const isAnime = (media.genres ?? []).some(
      (g: any) => g.genre?.slug === 'animation' || g.genre?.name?.toLowerCase?.() === 'animation',
    );
    const originalLanguage = media.show.originalLanguage;
    const userBaseLang = currentLanguage().split('-')[0];
    if (
      !isAnime ||
      !originalLanguage ||
      originalLanguage === userBaseLang ||
      !dto.originalTitle ||
      dto.originalTitle === dto.title
    ) {
      dto.originalTitle = null;
    }
    const seasons = (media.show.seasons || [])
      .filter((s) => !s.isSpecial)
      .map((s) => mapSeason(s as any, userId));
    const specials = (media.show.seasons || [])
      .filter((s) => s.isSpecial)
      .map((s) => mapSeason(s as any, userId));

    // Community ratings per episode, grouped by season (for the ratings chart).
    const seasonRatings = await this.computeSeasonRatings(mediaId);

    // Accurate progress from actual watched episodes, excluding specials (season 0) and UNAIRED episodes.
    let userProgress = dto.userProgress ?? 0;
    if (userId) {
      const now = new Date();
      const [watchedEp, totalEp] = await Promise.all([
        this.prisma.userEpisodeStatus.count({
          where: {
            userId,
            watched: true,
            episode: { season: { show: { mediaId }, isSpecial: false } },
          },
        }),
        this.prisma.episode.count({
          where: {
            season: { show: { mediaId }, isSpecial: false },
            airDate: { not: null, lte: now },
          },
        }),
      ]);
      userProgress = totalEp > 0 ? watchedEp / totalEp : 0;
    }

    return {
      ...dto,
      seasons,
      seasonsWithSpecials: specials,
      seasonRatings,
      userProgress,
      recommendations: recommendationsDto(media.recommendations),
    };
  }

  private async computeSeasonRatings(mediaId: string) {
    // Source of truth for the chart = YOUR app users' ratings.
    // Unrated episodes count as 0 unless USE_API_FOR_EPISODES_CHART=true (then TMDb fills gaps).
    const useApi = this.config.get<boolean>('metadata.useApiRatingsForChart') === true;
    // One aggregate query — the old findMany loaded every episode of the show plus
    // every user rating row ever cast on it (thousands of rows) to average in JS,
    // on every show-detail view.
    const eps = await this.prisma.$queryRaw<
      {
        number: number;
        seasonNumber: number;
        tmdbRating: number | null;
        votes: number;
        avg: number | null;
      }[]
    >`
      SELECT e.number, s.number AS "seasonNumber", e.rating AS "tmdbRating",
             COUNT(r.id)::int AS votes, AVG(r.rating)::float AS avg
      FROM episodes e
      JOIN seasons s ON e.season_id = s.id
      JOIN shows sh ON s.show_id = sh.id
      LEFT JOIN ratings r ON r.episode_id = e.id
      WHERE sh.media_id = ${mediaId}
      GROUP BY e.id, e.number, s.number, e.rating
    `;
    const bySeason = new Map<number, { number: number; rating: number; votes: number }[]>();
    for (const e of eps) {
      const votes = e.votes;
      const userAvg = votes ? e.avg : null;
      let value: number;
      if (userAvg != null) {
        value = userAvg; // 1–5 from your users
      } else if (useApi && e.tmdbRating) {
        value = e.tmdbRating / 2; // TMDb 0–10 scaled to 0–5
      } else {
        value = 0; // no user ratings yet
      }
      const sn = e.seasonNumber;
      if (!bySeason.has(sn)) bySeason.set(sn, []);
      bySeason.get(sn)!.push({ number: e.number, rating: Math.round(value * 10) / 10, votes });
    }
    return [...bySeason.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([seasonNumber, episodes]) => ({
        seasonNumber,
        episodes: episodes.sort((a, b) => a.number - b.number),
      }));
  }

  async getShowSeasons(mediaId: string, userId?: string) {
    const media = await this.prisma.mediaItem.findUnique({
      where: { id: mediaId },
      include: {
        show: {
          include: {
            seasons: {
              orderBy: { number: 'asc' },
              include: {
                episodes: {
                  orderBy: { number: 'asc' },
                  ...(userId
                    ? {
                        include: {
                          userStatuses: {
                            where: { userId },
                            select: {
                              watched: true,
                              watchedAt: true,
                              device: true,
                              watchCount: true,
                            },
                          },
                        },
                      }
                    : {}),
                },
              },
            },
          },
        },
      },
    });
    if (!media?.show) throw new NotFoundException('Show not found');
    return media.show.seasons;
  }

  async getMovieDetail(mediaId: string, userId?: string) {
    const media = await this.prisma.mediaItem.findUnique({
      where: { id: mediaId },
      include: {
        movie: true,
        genres: { include: { genre: true } },
        providers: { include: { provider: true } },
        cast: { include: { castMember: true } },
        externalIds: true,
        ...(userId
          ? {
              watchlist: { where: { userId }, select: { id: true } },
              favorites: { where: { userId }, select: { id: true } },
              movieStatuses: {
                where: { userId },
                select: { id: true, watched: true, watchedAt: true, watchCount: true },
              },
            }
          : {}),
      },
    });
    if (!media || !media.movie) throw new NotFoundException('Movie not found');
    return {
      ...mapMovie(media as any, userId),
      recommendations: recommendationsDto(media.recommendations),
    };
  }

  // ---- Mapping normalized seasons/episodes ----
  private async syncSeasons(
    tx: PrismaTransaction,
    mediaId: string,
    seasons: NormalizedSeason[],
    lang: string = currentLanguage(),
    enSeasons?: NormalizedSeason[],
    episodeExternalProvider: ExternalProvider = ExternalProvider.TMDB,
  ) {
    const show = await tx.show.findUnique({ where: { mediaId } });
    if (!show) return;
    // Batch-read existing season/episode JSON to merge locale overrides (preserve
    // other locales) in a single query instead of one per season/episode.
    const existingSeasons = await tx.season.findMany({
      where: { showId: show.id },
      select: {
        number: true,
        titles: true,
        overviews: true,
        posterUrls: true,
        episodes: { select: { number: true, titles: true, overviews: true, stillUrls: true } },
      },
    });
    const seasonMap = new Map(existingSeasons.map((s) => [s.number, s]));
    const airedCount = (eps: NormalizedSeason['episodes']) =>
      eps.filter((e) => e.airDate && new Date(e.airDate) <= new Date()).length;
    // Upsert by (showId, number) / (seasonId, number) to PRESERVE user progress across refreshes.
    for (const s of seasons) {
      // Skip empty season shells: no episodes from the provider AND no existing episodes.
      // Prevents broken "0/0 watched" rows when a provider (e.g. TVDB) is rate-limited/empty.
      if ((!s.episodes || s.episodes.length === 0) && (s.episodeCount ?? 0) === 0) {
        const prevSeason = seasonMap.get(s.number);
        if (!prevSeason || (prevSeason.episodes?.length ?? 0) === 0) continue;
      }
      const enS = enSeasons?.find((e) => e.number === s.number);
      const prev = seasonMap.get(s.number);
      const titles = mergeLocalized(prev?.titles as any, lang, s.title, enS?.title);
      const overviews = mergeLocalized(prev?.overviews as any, lang, s.overview, enS?.overview);
      const posterUrls = mergeLocalized(prev?.posterUrls as any, lang, s.posterUrl, enS?.posterUrl);
      const season = await tx.season.upsert({
        where: { showId_number: { showId: show.id, number: s.number } },
        create: {
          showId: show.id,
          number: s.number,
          title: enS?.title ?? s.title,
          overview: enS?.overview ?? s.overview,
          posterUrl: enS?.posterUrl ?? s.posterUrl,
          episodeCount: s.episodeCount,
          isSpecial: s.isSpecial,
          airedCount: airedCount(s.episodes),
          titles,
          overviews,
          posterUrls,
        },
        update: {
          title: enS?.title ?? s.title,
          overview: enS?.overview ?? s.overview,
          posterUrl: enS?.posterUrl ?? s.posterUrl,
          episodeCount: s.episodeCount,
          isSpecial: s.isSpecial,
          airedCount: airedCount(s.episodes),
          titles,
          overviews,
          posterUrls,
        },
      });
      const epMap = new Map((prev?.episodes ?? []).map((e) => [e.number, e]));
      for (const e of s.episodes) {
        const enE = enS?.episodes.find((ee) => ee.number === e.number);
        const prevEp = epMap.get(e.number);
        const epTitles = mergeLocalized(prevEp?.titles as any, lang, e.title, enE?.title);
        const epOverviews = mergeLocalized(
          prevEp?.overviews as any,
          lang,
          e.overview,
          enE?.overview,
        );
        const epStillUrls = mergeLocalized(
          prevEp?.stillUrls as any,
          lang,
          e.stillUrl,
          enE?.stillUrl,
        );
        const ep = await tx.episode.upsert({
          where: { seasonId_number: { seasonId: season.id, number: e.number } },
          create: {
            seasonId: season.id,
            number: e.number,
            title: enE?.title ?? e.title,
            overview: enE?.overview ?? e.overview,
            stillUrl: enE?.stillUrl ?? e.stillUrl,
            runtimeMinutes: e.runtimeMinutes,
            airDate: e.airDate ? new Date(e.airDate) : null,
            rating: e.rating,
            isFinale: e.isFinale,
            titles: epTitles,
            overviews: epOverviews,
            stillUrls: epStillUrls,
          },
          update: {
            title: enE?.title ?? e.title,
            overview: enE?.overview ?? e.overview,
            stillUrl: enE?.stillUrl ?? e.stillUrl,
            runtimeMinutes: e.runtimeMinutes,
            airDate: e.airDate ? new Date(e.airDate) : null,
            rating: e.rating,
            isFinale: e.isFinale,
            titles: epTitles,
            overviews: epOverviews,
            stillUrls: epStillUrls,
          },
        });
        // Persist the provider's episode id so import matching can resolve episodes by
        // external id (EpisodeExternalId fast path + /find recovery). `e.tmdbId` carries
        // the TMDB episode id for TMDB hydration, the TVDB episode id for TVDB hydration.
        if (e.tmdbId) {
          await this.syncEpisodeExternalId(tx, ep.id, episodeExternalProvider, String(e.tmdbId));
        }
      }
    }
  }

  /** Persist one episode-level external id (best-effort; repoints on provider+value conflicts). */
  private async syncEpisodeExternalId(
    tx: PrismaTransaction,
    episodeId: string,
    provider: ExternalProvider,
    value: string,
  ) {
    try {
      await tx.episodeExternalId.upsert({
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
    } catch (e) {
      this.logger.debug(
        `episodeExternalId upsert failed for ${provider}:${value}: ${(e as Error).message}`,
      );
    }
  }

  async ensureUserShowTotals(userId: string, mediaId: string) {
    const total = await this.prisma.episode.count({
      where: { season: { show: { mediaId }, isSpecial: false } },
    });
    await this.prisma.userShowStatus.upsert({
      where: { userId_mediaId: { userId, mediaId } },
      create: { userId, mediaId, totalCount: total },
      update: { totalCount: total },
    });
  }

  // ---- Genre / provider / cast dedupe ----
  private async upsertGenres(
    tx: PrismaTransaction,
    genres: { tmdbId?: number; name: string }[],
    lang: string = currentLanguage(),
    enGenres?: { tmdbId?: number; name: string }[],
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const [index, g] of genres.entries()) {
      // Match the English name (stable identity) so different request languages
      // collapse onto the same Genre row instead of creating per-language dupes.
      const enName =
        enGenres?.find((e) => e.tmdbId != null && e.tmdbId === g.tmdbId)?.name ??
        // TVDB genres carry no tmdbId — but the provider returns the same genre set in
        // the same order for every locale, so the English name lines up by index.
        (enGenres && enGenres.length === genres.length ? enGenres[index]?.name : undefined);
      const slug = slugify(enName ?? g.name);
      const existing = await tx.genre
        .findUnique({ where: { slug }, select: { names: true } })
        .catch(() => null);
      const names = mergeLocalized((existing?.names as any) ?? null, lang, g.name, enName);
      const genre = await tx.genre.upsert({
        where: { slug },
        create: { name: enName ?? g.name, slug, names },
        update: { name: enName ?? g.name, names },
      });
      ids.push(genre.id);
    }
    return ids;
  }

  private async upsertProviders(
    tx: PrismaTransaction,
    providers: { name: string; logoUrl?: string | null }[],
  ) {
    const ids: string[] = [];
    for (const p of providers) {
      const provider = await tx.watchProvider.upsert({
        where: { slug: slugify(p.name) },
        create: { name: p.name, slug: slugify(p.name), logoUrl: p.logoUrl },
        update: { logoUrl: p.logoUrl ?? undefined },
      });
      ids.push(provider.id);
    }
    return ids;
  }

  private async upsertCast(
    tx: PrismaTransaction,
    cast: { tmdbPersonId: number; name: string; profileUrl?: string | null }[],
  ) {
    const map = new Map<string, { name: string; profileUrl?: string | null }>();
    for (const c of cast) {
      map.set(`TMDB_${c.tmdbPersonId}`, { name: c.name, profileUrl: c.profileUrl });
    }
    const ids: string[] = [];
    for (const [externalId, info] of map) {
      const member = await tx.castMember.upsert({
        where: { externalId },
        create: { externalId, name: info.name, profileUrl: info.profileUrl },
        update: { name: info.name, profileUrl: info.profileUrl ?? undefined },
      });
      ids.push(member.id);
    }
    return ids;
  }

  private async syncGenres(tx: PrismaTransaction, mediaId: string, genreIds: string[]) {
    await tx.mediaGenre.deleteMany({ where: { mediaId } });
    if (genreIds.length > 0) {
      await tx.mediaGenre.createMany({
        data: genreIds.map((genreId) => ({ mediaId, genreId })),
        skipDuplicates: true,
      });
    }
  }

  private async syncProviders(tx: PrismaTransaction, mediaId: string, providerIds: string[]) {
    await tx.mediaWatchProvider.deleteMany({ where: { mediaId } });
    if (providerIds.length > 0) {
      await tx.mediaWatchProvider.createMany({
        data: providerIds.map((providerId) => ({ mediaId, providerId })),
        skipDuplicates: true,
      });
    }
  }

  private async syncCast(
    tx: PrismaTransaction,
    mediaId: string,
    castMemberIds: string[],
    cast: {
      tmdbPersonId?: number;
      character?: string | null;
      characterExternalId?: number | null;
      order: number;
    }[],
    lang: string = currentLanguage(),
    enCast?: {
      tmdbPersonId?: number;
      character?: string | null;
      characterExternalId?: number | null;
      order: number;
    }[],
  ) {
    // Preserve other locales' characters: read existing JSON before recreating rows.
    const existing = await tx.mediaCast.findMany({
      where: { mediaId },
      select: { id: true, castMemberId: true, characters: true, characterExternalId: true },
    });
    const existingMap = new Map(existing.map((c) => [c.castMemberId, c]));
    const retainedIds: string[] = [];
    for (let i = 0; i < castMemberIds.length; i++) {
      const id = castMemberIds[i];
      const c = cast[i];
      const prev = existingMap.get(id);
      const enChar = enCast?.find(
        (e) => e.tmdbPersonId != null && e.tmdbPersonId === c?.tmdbPersonId,
      )?.character;
      const prevCharacters =
        prev?.characters && typeof prev.characters === 'object' && !Array.isArray(prev.characters)
          ? (prev.characters as Record<string, string>)
          : null;
      const characters = mergeLocalized(prevCharacters, lang, c?.character, enChar);
      const data = {
        character: enChar ?? c?.character ?? null,
        characters,
        sortOrder: c?.order ?? i,
        // Keep TVDB role ids when a later TMDB refresh lacks them; imported TV Time
        // character votes depend on this local key.
        characterExternalId: c?.characterExternalId ?? prev?.characterExternalId ?? null,
      };
      if (prev) {
        await tx.mediaCast.update({
          where: { id: prev.id },
          data,
        });
        retainedIds.push(prev.id);
      } else {
        const created = await tx.mediaCast.create({
          data: {
            mediaId,
            castMemberId: id,
            ...data,
          },
          select: { id: true },
        });
        retainedIds.push(created.id);
      }
    }
    // Delete stale cast rows only when no character votes point at them. Votes use
    // media_cast.id as the stable option key, so deleting voted rows would cascade-delete
    // imported/manual character votes.
    await tx.mediaCast.deleteMany({
      where: {
        mediaId,
        ...(retainedIds.length ? { id: { notIn: retainedIds } } : {}),
        characterVotes: { none: {} },
      },
    });
  }
}

/** Defensive parse of the media_items.recommendations JSON snapshot → DTO.
 *  Unknown/garbled shapes (legacy rows, partial writes) become an empty array. */
function recommendationsDto(raw: unknown): RecommendationDto[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is Record<string, any> => !!r && typeof r === 'object')
    .filter((r) => typeof r.tmdbId === 'number')
    .map((r) => ({
      tmdbId: r.tmdbId,
      type: r.type === 'MOVIE' ? ('MOVIE' as const) : ('SHOW' as const),
      title: typeof r.title === 'string' && r.title ? r.title : 'Untitled',
      posterUrl: typeof r.posterUrl === 'string' ? r.posterUrl : null,
      year: typeof r.year === 'number' ? r.year : null,
      rating: typeof r.rating === 'number' ? r.rating : null,
    }));
}

type PrismaTransaction = Omit<
  PrismaService,
  | '$connect'
  | '$disconnect'
  | '$on'
  | '$transaction'
  | '$use'
  | '$extends'
  | 'onModuleInit'
  | 'onModuleDestroy'
>;
