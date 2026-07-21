// TV Time Out (browser extension) export normalization: shared types.
//
// The export is a zip with dated JSON files (tvtime-series-*.json,
// tvtime-movies-*.json) plus an informational tvtime-failed-*.json and a
// human-readable tvtime-summary-*.html. No ratings, emotions, comments,
// character votes, or lists exist in this format.
//
// Media identity: `id: { tvdb: number, imdb: string|null }` — imdb is always
// null on shows/episodes in practice. We reuse TraktIds ({ tvdb, imdb }) so
// the matcher's external-id pipeline works unchanged.

import type { TraktIds } from '../trakt/types';
import type { TvTimeShowFootprint, TvTimeWatchlistCandidate } from '../tvtime-json/types';

export interface TvTimeOutWatchedEpisode {
  showTitle: string;
  year: number | null;
  season: number;
  episode: number;
  special: boolean;
  showIds: TraktIds;
  episodeIds: TraktIds;
  watchedAt: Date | null;
  watchCount: number;
}

export interface TvTimeOutSeriesResult {
  episodes: TvTimeOutWatchedEpisode[];
  footprints: Map<string, TvTimeShowFootprint>;
  watchlist: TvTimeWatchlistCandidate[];
  favorites: TvTimeWatchlistCandidate[];
  invalid: number;
}

export interface TvTimeOutMoviesResult {
  watched: { movieTitle: string; year: number | null; movieIds: TraktIds; watchedAt: Date | null; watchCount: number }[];
  watchlist: TvTimeWatchlistCandidate[];
  favorites: TvTimeWatchlistCandidate[];
  invalid: number;
}

export interface TvTimeOutFailedResult {
  total: number;
  shows: { title: string | null; tvdbId: number | null }[];
}
