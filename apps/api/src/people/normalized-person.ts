import { MediaType } from '@tvwatch/shared';
import type { PersonCreditsSnapshot, PersonCreditSnapshotItem } from '@tvwatch/shared';
import type { TmdbPersonPayload } from '../media-metadata/providers/tmdb.provider';
import type { TvdbPersonPayload } from '../media-metadata/providers/tvdb.provider';
import { tvdbLangToLocale } from '../media-metadata/providers/tvdb.provider';

/** Talk-show / documentary self appearances — excluded from the acting rails. */
const SELF_CHARACTER = /^(himself|herself|self|themselves)(\s*[-–—:].*)?$/i;

export function isSelfAppearance(character?: string | null): boolean {
  return !!character && SELF_CHARACTER.test(character.trim());
}

function yearOf(date?: string | null): number | null {
  const y = Number((date ?? '').slice(0, 4));
  return Number.isFinite(y) && y > 0 ? y : null;
}

/** Sort filmography: newest first, unknown years last, stable within a year. */
export function sortCredits(items: PersonCreditSnapshotItem[]): PersonCreditSnapshotItem[] {
  return [...items].sort((a, b) => (b.year ?? -1) - (a.year ?? -1));
}

/** TMDB combined_credits.cast → snapshot items (acting only, no self appearances). */
export function normalizeTmdbCredits(
  payload: TmdbPersonPayload,
  img: (path?: string | null, size?: string) => string | null,
): PersonCreditSnapshotItem[] {
  const out = new Map<string, PersonCreditSnapshotItem>();
  for (const c of payload.combined_credits?.cast ?? []) {
    if (c.media_type !== 'movie' && c.media_type !== 'tv') continue;
    if (isSelfAppearance(c.character)) continue;
    const type = c.media_type === 'movie' ? MediaType.MOVIE : MediaType.SHOW;
    const title = (c.media_type === 'movie' ? c.title : c.name) || '';
    if (!title) continue;
    const key = `tmdb:${c.id}:${type}`;
    if (out.has(key)) continue;
    out.set(key, {
      key,
      tmdbId: c.id,
      type,
      title,
      posterUrl: img(c.poster_path, 'w185'),
      year: yearOf(c.media_type === 'movie' ? c.release_date : c.first_air_date),
      character: c.character || null,
      rating: c.vote_average ?? null,
    });
  }
  return sortCredits([...out.values()]);
}

/**
 * TVDB characters[] → snapshot items. Only peopleType 'Actor' (drops Guest Star —
   talk-show noise — plus Writer/Director crew entries).
 */
export function normalizeTvdbCredits(
  payload: TvdbPersonPayload,
  artwork: (path?: string | null) => string | null,
): PersonCreditSnapshotItem[] {
  const out = new Map<string, PersonCreditSnapshotItem>();
  for (const c of payload.characters ?? []) {
    if ((c.peopleType ?? 'Actor') !== 'Actor') continue;
    if (isSelfAppearance(c.name)) continue;
    if (c.movieId != null) {
      const title = c.movie?.name || '';
      if (!title) continue;
      const key = `tvdb:${c.movieId}:MOVIE`;
      if (out.has(key)) continue;
      out.set(key, {
        key,
        tvdbId: c.movieId,
        type: MediaType.MOVIE,
        title,
        posterUrl: artwork(c.movie?.image),
        year: yearOf(c.movie?.year),
        character: c.name || null,
      });
    } else if (c.seriesId != null) {
      const title = c.series?.name || '';
      if (!title) continue;
      const key = `tvdb:${c.seriesId}:SHOW`;
      if (out.has(key)) continue;
      out.set(key, {
        key,
        tvdbId: c.seriesId,
        type: MediaType.SHOW,
        title,
        posterUrl: artwork(c.series?.image),
        year: yearOf(c.series?.year),
        character: c.name || null,
      });
    }
  }
  return sortCredits([...out.values()]);
}

/** Pick a TVDB biography translation for an app locale (3-letter codes), en fallback. */
export function tvdbBiography(payload: TvdbPersonPayload, locale: string): string | null {
  const translated = payload.translations?.nameTranslations ?? [];
  const byLocale = translated.find((b) => tvdbLangToLocale(b.language) === locale && b.overview);
  if (byLocale?.overview) return byLocale.overview;
  const en = translated.find((b) => b.language === 'eng' && b.overview);
  if (en?.overview) return en.overview;
  const anyBio = payload.biographies?.find((b) => b.biography);
  return anyBio?.biography ?? null;
}

/** Merge new locale titles into an existing snapshot's locales map. */
export function mergeLocaleTitles(
  snapshot: PersonCreditsSnapshot | null,
  locale: string,
  items: PersonCreditSnapshotItem[],
): Record<string, Record<string, string>> {
  const locales: Record<string, Record<string, string>> = { ...(snapshot?.locales ?? {}) };
  const titles: Record<string, string> = { ...(locales[locale] ?? {}) };
  for (const item of items) {
    const base = snapshot?.items.find((i) => i.key === item.key)?.title;
    // Only store a value when it differs from the English base (else fallback
    // handles it and the map stays small).
    if (item.title && item.title !== base) titles[item.key] = item.title;
  }
  locales[locale] = titles;
  return locales;
}
