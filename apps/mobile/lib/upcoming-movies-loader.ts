/**
 * Async loader for the Upcoming Movies tab. Resolves each watchlist movie's release
 * date from the on-device cache first, and only fetches /movies/{id} (through a polite
 * limiter) for entries that are missing or expired. Shared by the tab and the deferred
 * app-start prefetch.
 */
import type { QueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { qk } from '../api/hooks';
import { createDeduper, createLimiter } from './limit';
import type { MovieDateInfo, WatchlistLite } from './upcoming-movies';
import {
  flushReleaseDateCache,
  getReleaseEntry,
  isReleaseEntryFresh,
  loadReleaseDateCache,
  setReleaseEntry,
  type ReleaseEntry,
} from './release-date-cache';

// Cap 4 concurrent network fetches, spaced ~334ms (≈3/sec) — polite to the shared API.
const movieLimiter = createLimiter(4, { minIntervalMs: 334 });
const movieDedupe = createDeduper<any>();

export interface LoadUpcomingMovieOpts {
  queryClient?: QueryClient;
  force?: boolean;
  onProgress?: (done: number, total: number) => void;
}

/** Stable key for the loader's useQuery, derived from the candidate ids. */
export function idsHash(ids: string[]): string {
  return `${ids.length}:${[...ids].sort().join(',')}`;
}

function fromCache(m: WatchlistLite, cached: ReleaseEntry): MovieDateInfo {
  return {
    id: m.id,
    title: cached.title || m.title,
    poster: cached.poster ?? m.poster,
    year: cached.releaseYear ?? m.year,
    releaseDate: cached.releaseDate,
  };
}

export async function loadUpcomingMovieDates(
  items: WatchlistLite[],
  opts: LoadUpcomingMovieOpts = {},
): Promise<MovieDateInfo[]> {
  await loadReleaseDateCache();
  const now = Date.now();
  const currentYear = new Date(now).getFullYear();
  // Movies released before last year can't be upcoming — skip their detail fetch.
  const candidates = items.filter((m) => m.year == null || m.year >= currentYear - 1);

  const total = candidates.length;
  let done = 0;
  const bump = (): void => {
    done += 1;
    opts.onProgress?.(done, total);
  };
  opts.onProgress?.(0, total);

  const out: MovieDateInfo[] = [];
  await Promise.all(
    candidates.map(async (m) => {
      const cached = getReleaseEntry(m.id);
      // Cache hit: resolve immediately, don't occupy a network slot.
      if (!opts.force && cached && isReleaseEntryFresh(cached, now)) {
        out.push(fromCache(m, cached));
        bump();
        return;
      }
      await movieLimiter.run(async () => {
        try {
          const detail: any = await movieDedupe(m.id, () => api.get<any>(`/movies/${m.id}`));
          const entry: ReleaseEntry = {
            releaseDate: detail?.releaseDate ?? null,
            releaseYear: detail?.releaseYear ?? m.year ?? null,
            title: detail?.title ?? m.title,
            poster: detail?.images?.poster ?? detail?.posterUrl ?? m.poster ?? null,
            savedAt: Date.now(),
          };
          setReleaseEntry(m.id, entry);
          // Keep movie-detail screens instant.
          opts.queryClient?.setQueryData(qk.movie(m.id), detail);
          out.push({
            id: m.id,
            title: entry.title,
            poster: entry.poster,
            year: entry.releaseYear,
            releaseDate: entry.releaseDate,
          });
        } catch {
          // Per-movie failure never fails the whole list.
          if (cached) out.push(fromCache(m, cached));
          else
            out.push({
              id: m.id,
              title: m.title,
              poster: m.poster,
              year: m.year,
              releaseDate: null,
              loadFailed: true,
            });
        } finally {
          bump();
        }
      });
    }),
  );
  await flushReleaseDateCache();
  return out;
}
