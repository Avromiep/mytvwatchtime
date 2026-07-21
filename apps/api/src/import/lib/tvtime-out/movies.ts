// TV Time Out tvtime-movies-*.json normalization.
//
// Rows: { id: { tvdb, imdb }, uuid, created_at, title, year, watched_at,
//   is_watched, is_favorite, rewatch_count }
//
// is_watched=true  → watched movie candidate (watchedAt, watchCount = rewatch_count + 1)
// is_watched=false → watchlist movie candidate (listedAt = created_at)
// is_favorite=true → favorite movie candidate (listedAt = created_at) — independent
// of watched state.

import { normTitle, splitTitleYear } from '../inference';
import {
  asObj,
  boolOrFalse,
  dateOrNull,
  numOrNull,
  parseTvTimeIds,
  strOrNull,
} from '../tvtime-json/types';
import type { TvTimeOutMoviesResult } from './types';

export function normalizeTvTimeOutMovies(data: unknown): TvTimeOutMoviesResult {
  const watched: TvTimeOutMoviesResult['watched'] = [];
  const watchlist: TvTimeOutMoviesResult['watchlist'] = [];
  const favorites: TvTimeOutMoviesResult['favorites'] = [];
  const seen = new Set<string>();
  let invalid = 0;

  if (!Array.isArray(data)) return { watched, watchlist, favorites, invalid };

  for (const row of data) {
    const m = asObj(row);
    const rawTitle = strOrNull(m?.title);
    const ids = parseTvTimeIds(m?.id);
    if (!m || !rawTitle) {
      invalid++;
      continue;
    }
    const { title, year: titleYear } = splitTitleYear(rawTitle);
    const year = numOrNull(m.year) ?? titleYear;
    const key = ids.tvdb != null ? `tvdb:${ids.tvdb}` : ids.imdb ? `imdb:${ids.imdb}` : `title:${normTitle(title)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const listedAt = dateOrNull(m.created_at);
    if (boolOrFalse(m.is_watched)) {
      watched.push({
        movieTitle: title,
        year,
        movieIds: ids,
        watchedAt: dateOrNull(m.watched_at),
        watchCount: Math.max(1, (numOrNull(m.rewatch_count) ?? 0) + 1),
      });
    } else {
      watchlist.push({ type: 'movie', title, year, ids, listedAt });
    }
    if (boolOrFalse(m.is_favorite)) {
      favorites.push({ type: 'movie', title, year, ids, listedAt });
    }
  }

  return { watched, watchlist, favorites, invalid };
}
