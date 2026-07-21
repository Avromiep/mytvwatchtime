// TV Time Out tvtime-series-*.json normalization.
//
// Rows: { uuid, id: { tvdb, imdb }, created_at, title, status, is_favorite,
//   _noEpisodeData, seasons: [{ number, is_specials, episodes: [{ id: { tvdb, imdb },
//   number, name, special, is_watched, watched_at, rewatch_count, watched_count }] }] }
//
// - is_watched episodes → watched candidates. watchCount = max(1, watched_count,
//   rewatch_count + 1) — TV Time Out carries both counters, unlike the GDPR JSON.
// - `special: true` episodes are embedded in REGULAR season numbers and share S/E
//   keys with regular episodes, and `is_specials: true` seasons are pure-special —
//   both count as specials. The dedupe key includes the special flag and the
//   footprint (used by the structural guard) counts non-special episodes only.
// - Shows with zero watched episodes → watchlist candidates (listedAt = created_at).
// - is_favorite shows → favorite candidates (listedAt = created_at).
// - The show-level `status` (up_to_date / continuing / stopped / …) is NOT imported.

import { normTitle, splitTitleYear } from '../inference';
import {
  asObj,
  boolOrFalse,
  dateOrNull,
  mediaKey,
  numOrNull,
  parseTvTimeIds,
  strOrNull,
  type TvTimeShowFootprint,
} from '../tvtime-json/types';
import type { TvTimeOutSeriesResult, TvTimeOutWatchedEpisode } from './types';

const watchCountOf = (watchedCount: number | null, rewatchCount: number | null): number =>
  Math.max(1, watchedCount ?? 0, (rewatchCount ?? 0) + 1);

export function normalizeTvTimeOutSeries(data: unknown): TvTimeOutSeriesResult {
  const episodes: TvTimeOutWatchedEpisode[] = [];
  const footprints = new Map<string, TvTimeShowFootprint>();
  const watchlist: TvTimeOutSeriesResult['watchlist'] = [];
  const favorites: TvTimeOutSeriesResult['favorites'] = [];
  const seenEpisodes = new Set<string>();
  let invalid = 0;

  if (!Array.isArray(data)) return { episodes, footprints, watchlist, favorites, invalid };

  for (const row of data) {
    const show = asObj(row);
    const rawTitle = strOrNull(show?.title);
    const showIds = parseTvTimeIds(show?.id);
    if (!show || !rawTitle) {
      invalid++;
      continue;
    }
    const { title, year } = splitTitleYear(rawTitle);
    const key = mediaKey(showIds, normTitle(title));
    let footprint = footprints.get(key);
    if (!footprint) {
      footprint = { key, showTitle: title, year, showIds, maxSeason: null, seasonEpisodes: [] };
      footprints.set(key, footprint);
    }
    const perSeason = new Map<number, number>();
    let anyWatched = false;

    const seasons = Array.isArray(show.seasons) ? show.seasons : [];
    for (const rawSeason of seasons) {
      const s = asObj(rawSeason);
      const seasonNumber = numOrNull(s?.number);
      if (!s || seasonNumber == null) continue;
      const specialsSeason = boolOrFalse(s.is_specials);
      const eps = Array.isArray(s.episodes) ? s.episodes : [];
      for (const rawEp of eps) {
        const e = asObj(rawEp);
        const number = numOrNull(e?.number);
        if (!e || number == null) {
          invalid++;
          continue;
        }
        const special = specialsSeason || boolOrFalse(e.special);
        if (!special) {
          perSeason.set(seasonNumber, Math.max(perSeason.get(seasonNumber) ?? 0, number));
        }
        if (!boolOrFalse(e.is_watched)) continue;
        anyWatched = true;
        const dedupeKey = `${key}|s${seasonNumber}|e${number}|special:${special}`;
        if (seenEpisodes.has(dedupeKey)) continue;
        seenEpisodes.add(dedupeKey);
        episodes.push({
          showTitle: title,
          year,
          season: seasonNumber,
          episode: number,
          special,
          showIds,
          episodeIds: parseTvTimeIds(e.id),
          watchedAt: dateOrNull(e.watched_at),
          watchCount: watchCountOf(numOrNull(e.watched_count), numOrNull(e.rewatch_count)),
        });
      }
    }

    footprint.maxSeason = perSeason.size ? Math.max(...perSeason.keys()) : null;
    footprint.seasonEpisodes = [...perSeason.entries()].map(([season, maxEpisode]) => ({
      season,
      maxEpisode,
    }));

    const listedAt = dateOrNull(show.created_at);
    if (!anyWatched) {
      watchlist.push({ type: 'show', title, year, ids: showIds, listedAt });
    }
    if (boolOrFalse(show.is_favorite)) {
      favorites.push({ type: 'show', title, year, ids: showIds, listedAt });
    }
  }

  return { episodes, footprints, watchlist, favorites, invalid };
}
