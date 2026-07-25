import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ExternalProvider, MediaStatus, MediaType } from '@tvwatch/shared';
import { tvdbCode, formatNetworks, type SupportedLocale } from '@tvwatch/shared';

/** Map our app locales → TVDB 3-letter language codes for the episodes path param. */
const TVDB_3LETTER: Record<string, string> = {
  en: 'eng',
  fr: 'fra',
  es: 'spa',
  'pt-BR': 'por',
  de: 'deu',
  it: 'ita',
  ar: 'ara',
  tr: 'tur',
  hi: 'hin',
  id: 'ind',
  ja: 'jpn',
  ko: 'kor',
  'zh-CN': 'zho',
};
function tvdbLang3(locale?: string): string {
  if (!locale) return 'eng';
  return TVDB_3LETTER[locale] ?? TVDB_3LETTER[locale.split('-')[0]] ?? 'eng';
}
import {
  NormalizedCast,
  NormalizedEpisode,
  NormalizedGenre,
  NormalizedMovie,
  NormalizedProvider,
  NormalizedSeason,
  NormalizedSearchItem,
  NormalizedShow,
} from './tmdb.provider';
import { TvdbClient } from './tvdb.client';

interface TvdbSearchHit {
  tvdb_id: number;
  name?: string;
  overview?: string;
  image_url?: string;
  type?: string;
  first_air_time?: string;
  year?: string | number;
}

interface TvdbEpisode {
  id: number;
  name?: string;
  aired?: string;
  runtime?: number;
  seasonNumber?: number;
  number?: number;
  overview?: string;
  finaleType?: string | null;
  image?: string;
  absoluteNumber?: number;
}

/** TVDB `/episodes/{id}/extended` shape (includes parent-series linkage + absolute numbering). */
interface TvdbEpisodeExtended extends TvdbEpisode {
  absoluteNumber?: number;
  seriesId?: number;
  seasons?: { id?: number; number?: number; type?: { type?: string } }[];
}

/** TVDB translations response (`/series|movies/{id}/translations/{lang}`). */
interface TvdbTranslation {
  name?: string;
  overview?: string;
  language?: string;
}

interface TvdbSeason {
  id: number;
  number?: number;
  type?: { id?: number; type?: string; name?: string };
  episodes?: TvdbEpisode[];
}

interface TvdbArtwork {
  type: number;
  image: string;
}

interface TvdbCharacter {
  /** TVDB character id (role-level) — used to resolve TVTime character votes locally. */
  id?: number;
  name?: string;
  personName?: string;
  personImgURL?: string;
  image?: string;
  sort?: number;
  isFeatured?: boolean;
  peopleId?: number;
  peopleType?: string;
}

interface TvdbCompany {
  id?: number;
  name?: string;
  companyType?: { companyTypeId?: number; companyTypeName?: string };
}

/** TVDB companyTypeId 1 = "Network" (2 = Studio, 3 = Production Company). */
const TVDB_NETWORK_COMPANY_TYPE_ID = 1;

interface TvdbSeriesExtended {
  id: number;
  name?: string;
  overview?: string;
  status?: { id?: number; name?: string };
  firstAired?: string;
  lastAired?: string;
  nextAired?: string;
  runtime?: number;
  originalNetwork?: { name?: string };
  companies?: TvdbCompany[];
  imdbId?: string;
  seasons?: TvdbSeason[];
  artworks?: TvdbArtwork[];
  characters?: TvdbCharacter[];
  genres?: TvdbGenre[];
  /** Present when fetched with meta=translations. */
  translations?: TvdbTranslationBlock;
}

interface TvdbGenre {
  id?: number;
  name?: string;
}

interface TvdbRemoteId {
  id: string;
  type: number;
  sourceName: string;
}

interface TvdbRelease {
  country: string;
  date: string;
  detail: string | null;
}

/** TVDB translations response (embedded in extended when meta=translations). */
interface TvdbTranslationBlock {
  nameTranslations?: { name: string; language: string; isPrimary?: boolean }[];
  overviewTranslations?: { overview: string; language: string; isPrimary?: boolean }[];
}

/** Reverse-map TVDB language codes → supported app locale codes. Unsupported TVDB
 *  languages must NOT fall into `en` or they overwrite the English override. */
const TVDB_TO_APP: Partial<Record<string, SupportedLocale>> = {
  eng: 'en',
  fra: 'fr',
  spa: 'es',
  por: 'pt-BR',
  deu: 'de',
  ita: 'it',
  ara: 'ar',
  tur: 'tr',
  hin: 'hi',
  ind: 'id',
  jpn: 'ja',
  kor: 'ko',
  zho: 'zh-CN',
  zhtw: 'zh-CN',
  pt: 'pt-BR',
};

function tvdbToAppLocale(code?: string | null): SupportedLocale | undefined {
  return TVDB_TO_APP[String(code ?? '').toLowerCase()];
}

interface TvdbMovieExtended {
  id: number;
  name?: string;
  overview?: string;
  runtime?: number;
  year?: string;
  releases?: TvdbRelease[];
  first_release?: TvdbRelease;
  remoteIds?: TvdbRemoteId[];
  artworks?: TvdbArtwork[];
  characters?: TvdbCharacter[];
  genres?: TvdbGenre[];
  studios?: { name: string }[];
  spoken_languages?: string[];
  production_countries?: { country: string; name: string }[];
}

const tvdbStatusMap = (s?: string): MediaStatus => {
  switch ((s || '').toLowerCase()) {
    case 'ended':
      return MediaStatus.ENDED;
    case 'upcoming':
      return MediaStatus.UPCOMING;
    default:
      return MediaStatus.RETURNING;
  }
};

/** Cast rows persisted per entity — deliberately generous (was 20): imported TV Time
 *  character votes resolve locally via media_cast.characterExternalId, and a vote for
 *  a character beyond the slice can NEVER resolve. Detail pages slice for display. */
const TVDB_CAST_LIMIT = 40;

@Injectable()
export class TvdbProvider {
  private readonly logger = new Logger(TvdbProvider.name);

  constructor(private readonly client: TvdbClient) {}

  get enabled(): boolean {
    return this.client.enabled;
  }

  /** IMDB id from the extended record — one light call, no hydration. Used by the
   *  rating backfill as the fallback cross-id when TMDB /find has no tvdb_id entry. */
  async fetchImdbId(kind: 'show' | 'movie', tvdbId: number): Promise<string | null> {
    if (!this.client.enabled) return null;
    if (kind === 'show') {
      const res = await this.client.get<{ data: { imdbId?: string } }>(
        `/series/${tvdbId}/extended`,
      );
      return res.data?.imdbId || null;
    }
    const res = await this.client.get<{ data: { remoteIds?: TvdbRemoteId[] } }>(
      `/movies/${tvdbId}/extended`,
    );
    const hit = (res.data?.remoteIds ?? []).find(
      (r) => (r.sourceName || '').toUpperCase() === 'IMDB',
    );
    return hit?.id || null;
  }

  async searchShows(
    query: string,
    page = 1,
  ): Promise<{ items: NormalizedSearchItem[]; total: number }> {
    const limit = 50;
    const res = await this.client.get<{ data: TvdbSearchHit[] }>('/search', {
      query,
      type: 'series',
      limit,
    });
    const hits = (res.data || []).filter((h) => h.type === 'series' || !h.type);
    return {
      total: hits.length,
      items: hits.map((h) => ({
        tmdbId: 0,
        tvdbId: h.tvdb_id,
        type: MediaType.SHOW,
        title: h.name || 'Untitled',
        posterUrl: this.client.artwork(h.image_url),
        backdropUrl: null,
        overview: h.overview || null,
        year: this.yearOf(h),
        rating: null,
        popularity: 0,
      })),
    };
  }

  /** Search TVDB for movies (backup provider when TMDB has no/weak results). */
  async searchMovies(
    query: string,
    page = 1,
  ): Promise<{ items: NormalizedSearchItem[]; total: number }> {
    const limit = 50;
    const res = await this.client.get<{ data: TvdbSearchHit[] }>('/search', {
      query,
      type: 'movie',
      limit,
    });
    const hits = (res.data || []).filter((h) => h.type === 'movie' || !h.type);
    return {
      total: hits.length,
      items: hits.map((h) => ({
        tmdbId: 0,
        tvdbId: h.tvdb_id,
        type: MediaType.MOVIE,
        title: h.name || 'Untitled',
        posterUrl: this.client.artwork(h.image_url),
        backdropUrl: null,
        overview: h.overview || null,
        year: this.yearOf(h),
        rating: null,
        popularity: 0,
      })),
    };
  }

  private yearOf(h: TvdbSearchHit): number | null {
    const raw = h.first_air_time ?? h.year;
    if (raw == null || raw === '') return null;
    const y = Number(String(raw).slice(0, 4));
    return Number.isFinite(y) ? y : null;
  }

  async getShow(tvdbId: number, language?: string): Promise<NormalizedShow> {
    // meta=translations: without it the only title available is `s.name`, which is
    // ALWAYS the original-language name on TVDB (e.g. Japanese for anime) regardless
    // of the requested language — that leaked into the base title of anime shows.
    const res = await this.client.get<{ data: TvdbSeriesExtended }>(
      `/series/${tvdbId}/extended`,
      { meta: 'translations' },
      tvdbLang3(language),
    );
    const s = res.data;

    // TVDB v4 SERIES artwork types: 1=banner (WIDE), 2=poster, 3=background/fanart.
    // (The old swap — poster=1, backdrop=2 — put wide banners into poster slots.)
    // A banner only ever fills the BACKDROP as a last resort, never the poster.
    const poster = s.artworks?.find((a) => a.type === 2);
    const backdrop = s.artworks?.find((a) => a.type === 3) ?? s.artworks?.find((a) => a.type === 1);

    // Pick the title/overview for the request locale from the translations block,
    // falling back to English, then to the original-language name (same logic as
    // the movie path). `s.name` (original title) is kept separately.
    const tr = s.translations;
    const allTitles: Record<string, string> = {};
    const allOverviews: Record<string, string> = {};
    if (tr?.nameTranslations) {
      for (const nt of tr.nameTranslations) {
        const appLocale = tvdbToAppLocale(nt.language);
        if (!appLocale) continue;
        if (!allTitles[appLocale]) allTitles[appLocale] = nt.name;
      }
    }
    if (tr?.overviewTranslations) {
      for (const ot of tr.overviewTranslations) {
        const appLocale = tvdbToAppLocale(ot.language);
        if (!appLocale) continue;
        if (!allOverviews[appLocale]) allOverviews[appLocale] = ot.overview;
      }
    }
    const requestLocale = tvdbToAppLocale(tvdbLang3(language)) ?? 'en';
    const localizedTitle = allTitles[requestLocale] ?? allTitles['en'] ?? null;
    const localizedOverview = allOverviews[requestLocale] ?? allOverviews['en'] ?? null;
    // Expose the full locale map (same shape as the TMDB translations payload) so callers
    // can bulk-store locale overrides and detect which locales the provider actually HAS —
    // re-requesting a locale TVDB lacks on every view just re-fetches the English fallback.
    const translations: Record<string, { title?: string; overview?: string }> = {};
    for (const loc of new Set([...Object.keys(allTitles), ...Object.keys(allOverviews)])) {
      translations[loc] = { title: allTitles[loc], overview: allOverviews[loc] };
    }
    // The primary translation marks the series' original language (e.g. jpn → ja) —
    // needed for the anime "Original title" display rule on TVDB-hydrated shows.
    const primaryTvdbLang = tr?.nameTranslations?.find((nt) => nt.isPrimary)?.language;

    // TVDB `/series/{id}/extended` does NOT embed episodes per season. Fetch the series'
    // full episode list (aired/default order) and group by seasonNumber. This is best-effort
    // + rate-limit-resilient: a TVDB failure/rate-limit returns whatever we have so far
    // rather than throwing (so a TVDB hiccup never breaks a show's detail page or an import).
    const episodesBySeason = await this.fetchSeriesEpisodes(tvdbId, language);
    // Season numbers: union of the extended seasons list and any season that has episodes.
    const seasonNums = new Set<number>();
    for (const se of s.seasons || []) if (se.number != null) seasonNums.add(se.number);
    for (const sn of episodesBySeason.keys()) seasonNums.add(sn);

    const seasons: NormalizedSeason[] = [...seasonNums]
      .sort((a, b) => a - b)
      .map((num) => {
        const eps = episodesBySeason.get(num) ?? [];
        const se = (s.seasons || []).find((x) => x.number === num);
        return {
          tmdbId: se?.id ?? 0,
          number: num,
          title: `Season ${num}`,
          overview: null,
          posterUrl: null,
          episodeCount: eps.length,
          isSpecial: num === 0,
          episodes: eps.map((e) => this.normalizeEpisode(e)),
        };
      });

    const cast: NormalizedCast[] = (s.characters || [])
      .filter((c) => c.personName && c.peopleType === 'Actor')
      .slice(0, TVDB_CAST_LIMIT)
      .map((c, i) => ({
        tmdbPersonId: c.peopleId ?? 900000000 + i, // unique per person (avoids all-0 collision)
        name: c.personName ?? 'Unknown',
        character: c.name ?? null,
        profileUrl: c.personImgURL ?? c.image ?? null,
        order: c.sort ?? i,
        characterExternalId: c.id ?? null,
      }));

    return {
      type: MediaType.SHOW,
      tmdbId: 0,
      tvdbId,
      title: localizedTitle ?? (s.name || 'Untitled'),
      // Original-language series name (TVDB's `name` is always original-language).
      originalTitle: s.name ?? null,
      originalLanguage: primaryTvdbLang ? (tvdbToAppLocale(primaryTvdbLang) ?? null) : undefined,
      overview: localizedOverview ?? (s.overview || null),
      posterUrl: this.client.artwork(poster?.image),
      backdropUrl: this.client.artwork(backdrop?.image),
      status: tvdbStatusMap(s.status?.name),
      yearStart: s.firstAired ? Number(s.firstAired.slice(0, 4)) : null,
      yearEnd: s.lastAired ? Number(s.lastAired.slice(0, 4)) : null,
      // Networks come from the companies list (Network-type only, up to 2 joined); fall
      // back to originalNetwork when the series carries no company data.
      network:
        formatNetworks(
          (s.companies ?? [])
            .filter((c) => c.companyType?.companyTypeId === TVDB_NETWORK_COMPANY_TYPE_ID)
            .map((c) => c.name),
        ) ??
        s.originalNetwork?.name ??
        null,
      runtimeMinutes: s.runtime ?? null,
      // TVDB exposes NO public 0–10 rating (its `score` is a popularity rank,
      // e.g. 1413329) — ratings for TVDB-hydrated rows come from TMDB via the
      // rating backfill (tvdb_id → TMDB /find → vote_average).
      rating: null,
      popularity: 0,
      trailerUrl: null,
      seasonsCount: seasons.length,
      episodesCount: seasons.reduce((a, b) => a + b.episodes.length, 0),
      inProduction: (s.status?.name || '').toLowerCase() === 'continuing',
      // TVDB extended genres — needed for anime candidate detection on TVDB-hydrated shows
      // (and to stop syncGenres from wiping previously attached genres on re-hydration).
      genres: (s.genres || []).map((g) => ({ tmdbId: g.id ?? 0, name: g.name || '' })),
      externals: [
        { provider: ExternalProvider.THE_TVDB, value: String(tvdbId) },
        ...(s.imdbId ? [{ provider: ExternalProvider.IMDB, value: s.imdbId }] : []),
      ],
      cast,
      providers: [] as NormalizedProvider[],
      seasons,
      nextAirDate: s.nextAired ?? null,
      translations: Object.keys(translations).length > 0 ? translations : undefined,
    };
  }

  /**
   * Fetch ALL episodes for a series, grouped by seasonNumber. Paginates TVDB's
   * `/series/{id}/episodes/{page}` (aired/default order). Best-effort: on a rate-limit or
   * failure it returns what it has gathered so far instead of throwing, so a TVDB hiccup
   * never breaks hydration of a show or an import. Capped at 12 pages (~1200 episodes).
   */
  private async fetchSeriesEpisodes(
    tvdbId: number,
    language?: string,
  ): Promise<Map<number, TvdbEpisode[]>> {
    const bySeason = new Map<number, TvdbEpisode[]>();
    // TVDB v4: /series/{id}/episodes/{seasonType}/{lang}?page={page}
    // lang must be a 3-letter code (eng, fra, spa, deu, etc.) — NOT 2-letter.
    const lang = tvdbLang3(language);
    for (let page = 0; page < 12; page++) {
      try {
        const res = await this.client.get<{
          data: { episodes?: TvdbEpisode[] } | TvdbEpisode[];
          links?: { next?: string | null };
        }>(`/series/${tvdbId}/episodes/default/${lang}`, { page }, lang);
        const raw = res.data as any;
        const eps: TvdbEpisode[] = Array.isArray(raw)
          ? raw
          : Array.isArray(raw?.episodes)
            ? raw.episodes
            : [];
        if (eps.length === 0) break;
        for (const e of eps) {
          const sn = e.seasonNumber ?? 0;
          if (!bySeason.has(sn)) bySeason.set(sn, []);
          bySeason.get(sn)!.push(e);
        }
        if (!res.links?.next) break;
      } catch {
        break;
      }
    }
    return bySeason;
  }

  // ---- Episode-by-ID + parent-series + translations (Phase 2) ----

  /**
   * Resolve a single TVDB episode by its episode ID, including parent-series linkage
   * and absolute numbering. Used by conditional TVDB recovery in imports and by
   * reconciliation. TVDB episode identity is stored under providerEntityKind EPISODE.
   */
  async getEpisode(
    tvdbEpisodeId: number,
    language?: string,
  ): Promise<{
    episode: NormalizedEpisode;
    tvdbEpisodeId: number;
    seriesId: number | null;
    seasonNumber: number | null;
    absoluteNumber: number | null;
  }> {
    const res = await this.client.get<{ data: TvdbEpisodeExtended }>(
      `/episodes/${tvdbEpisodeId}/extended`,
      {},
      tvdbLang3(language),
    );
    const e = res.data;
    return {
      tvdbEpisodeId,
      episode: this.normalizeEpisode(e),
      seriesId: e.seriesId ?? null,
      seasonNumber: e.seasonNumber ?? null,
      absoluteNumber: e.absoluteNumber ?? null,
    };
  }

  /** Localized title + overview for a series in the requested language. */
  async getSeriesTranslations(
    tvdbId: number,
    lang: string,
  ): Promise<{ title: string | null; overview: string | null; locale: string }> {
    const res = await this.client.get<{ data: TvdbTranslation }>(
      `/series/${tvdbId}/translations/${lang}`,
    );
    const t = res.data;
    return { title: t?.name ?? null, overview: t?.overview ?? null, locale: lang };
  }

  /** Localized title + overview for a movie in the requested language. */
  async getMovieTranslations(
    tvdbId: number,
    lang: string,
  ): Promise<{ title: string | null; overview: string | null; locale: string }> {
    const res = await this.client.get<{ data: TvdbTranslation }>(
      `/movies/${tvdbId}/translations/${lang}`,
    );
    const t = res.data;
    return { title: t?.name ?? null, overview: t?.overview ?? null, locale: lang };
  }

  /** Lightweight localized TEXT base (title/overview) — ONE translations call, no
   *  episodes, no artworks. Light upserts use it to write a proper English base
   *  without paying for a full hydration. */
  async localizedShowBase(tvdbId: number, lang3 = 'eng') {
    const t = await this.getSeriesTranslations(tvdbId, lang3);
    return { title: t.title?.trim() || undefined, overview: t.overview ?? null };
  }

  /** Movie counterpart of {@link localizedShowBase}. */
  async localizedMovieBase(tvdbId: number, lang3 = 'eng') {
    const t = await this.getMovieTranslations(tvdbId, lang3);
    return { title: t.title?.trim() || undefined, overview: t.overview ?? null };
  }

  private normalizeEpisode(e: TvdbEpisode): NormalizedEpisode {
    return {
      tmdbId: e.id,
      number: e.number ?? 0,
      title: e.name || `Episode ${e.number}`,
      overview: e.overview || null,
      stillUrl: this.client.artwork(e.image),
      runtimeMinutes: e.runtime ?? null,
      airDate: e.aired || null,
      rating: null,
      isFinale: e.finaleType === 'season' || e.finaleType === 'series',
    };
  }

  /** Fully hydrate a movie from TVDB (backup provider): artworks, cast, genres, runtime.
   *  Pass meta=translations to get ALL locale translations in one call. */
  async getMovie(tvdbId: number, language?: string): Promise<NormalizedMovie> {
    const res = await this.client.get<{ data: TvdbMovieExtended }>(
      `/movies/${tvdbId}/extended`,
      { meta: 'translations' },
      tvdbLang3(language),
    );
    const m = res.data;

    // TVDB v4 MOVIE artwork types: 14=poster, 15=background. Types 1/2/3 are SERIES
    // semantics (1=banner, 2=poster, 3=background) — a type-1 on a movie is a wide
    // banner, never a poster; banners only fill the backdrop as a last resort.
    const poster = m.artworks?.find((a) => a.type === 14) ?? m.artworks?.find((a) => a.type === 2);
    const backdrop =
      m.artworks?.find((a) => a.type === 15) ??
      m.artworks?.find((a) => a.type === 3) ??
      m.artworks?.find((a) => a.type === 1);

    const cast: NormalizedCast[] = (m.characters || [])
      .filter((c) => c.personName && c.peopleType === 'Actor')
      .slice(0, TVDB_CAST_LIMIT)
      .map((c, i) => ({
        tmdbPersonId: c.peopleId ?? 900000000 + i,
        name: c.personName ?? 'Unknown',
        character: c.name ?? null,
        profileUrl: c.personImgURL ?? c.image ?? null,
        order: c.sort ?? i,
      }));

    const genres: NormalizedGenre[] = (m.genres || [])
      .map((g) => ({ tmdbId: g.id ?? 0, name: g.name || '' }))
      .filter((g) => g.name);

    // Extract IMDB and TMDB IDs from remoteIds array.
    const imdbId = m.remoteIds?.find((r) => r.sourceName === 'IMDB')?.id;
    const tmdbRemoteId = m.remoteIds?.find((r) => r.sourceName === 'TheMovieDB.com')?.id;
    // Release date: prefer first_release, then first entry in releases.
    const releaseDate = m.first_release?.date ?? m.releases?.[0]?.date ?? null;
    const releaseYear = m.year
      ? Number(m.year)
      : releaseDate
        ? Number(releaseDate.slice(0, 4))
        : null;
    const studio = m.studios?.[0]?.name ?? null;

    // Extract ALL translations from the translations block (one call, all locales).
    const tr = (m as any).translations as TvdbTranslationBlock | undefined;
    const allTranslations: Record<string, { title?: string; overview?: string }> = {};
    if (tr?.nameTranslations) {
      for (const nt of tr.nameTranslations) {
        const appLocale = tvdbToAppLocale(nt.language);
        if (!appLocale) continue;
        if (!allTranslations[appLocale]) allTranslations[appLocale] = {};
        allTranslations[appLocale].title = nt.name;
      }
    }
    if (tr?.overviewTranslations) {
      for (const ot of tr.overviewTranslations) {
        const appLocale = tvdbToAppLocale(ot.language);
        if (!appLocale) continue;
        if (!allTranslations[appLocale]) allTranslations[appLocale] = {};
        allTranslations[appLocale].overview = ot.overview;
      }
    }

    // Determine the best title/overview for the request locale.
    const requestLocale = tvdbToAppLocale(tvdbLang3(language)) ?? 'en';
    const localeTr = allTranslations[requestLocale] ?? allTranslations['en'] ?? {};

    return {
      type: MediaType.MOVIE,
      tmdbId: 0,
      title: localeTr.title ?? (m.name || 'Untitled'),
      overview: localeTr.overview ?? (m.overview || null),
      posterUrl: this.client.artwork(poster?.image),
      backdropUrl: this.client.artwork(backdrop?.image),
      releaseDate,
      releaseYear,
      runtimeMinutes: m.runtime ?? null,
      // No public 0–10 rating on TVDB (see getShow note).
      rating: null,
      popularity: 0,
      trailerUrl: null,
      country: m.production_countries?.[0]?.name ?? null,
      language: m.spoken_languages?.[0] ?? null,
      genres,
      externals: [
        { provider: ExternalProvider.THE_TVDB, value: String(tvdbId) },
        ...(imdbId ? [{ provider: ExternalProvider.IMDB, value: imdbId }] : []),
        ...(tmdbRemoteId ? [{ provider: ExternalProvider.TMDB, value: tmdbRemoteId }] : []),
      ],
      cast,
      providers: [] as NormalizedProvider[],
      translations: Object.keys(allTranslations).length > 0 ? allTranslations : undefined,
    };
  }
}
