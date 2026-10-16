/**
 * Async loader for the Upcoming Movies tab. Resolves each watchlist movie's release
 * date from the on-device cache first and fetches /movies/{id} only for entries that
 * are missing or stale (stale-while-revalidate: stale values stay usable meanwhile).
 *
 * Each movie is fetched at most once per fill: the module-level deduper collapses the
 * same id across overlapping runs into one network call, and every fetch re-checks the
 * cache first in case another run just filled it. Shared by the tab and the prefetch.
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
  releaseTtlJitter,
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

export interface LoadUpcomingMovieResult {
  entries: MovieDateInfo[];
  /** A movie failed to load and had no cached copy, so it was left out of `entries`. */
  failedNoCache: boolean;
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
): Promise<LoadUpcomingMovieResult> {
  await loadReleaseDateCache();
  const now = Date.now();
  const currentYear = new Date(now).getFullYear();
  // Movies released before last year can't be upcoming — never fetch their detail.
  const candidates = items.filter((m) => m.year == null || m.year >= currentYear - 1);

  const out: MovieDateInfo[] = [];
  const toFetch: WatchlistLite[] = [];
  for (const m of candidates) {
    const e = getReleaseEntry(m.id);
    if (!opts.force && e && isReleaseEntryFresh(e, now)) out.push(fromCache(m, e));
    else toFetch.push(m);
  }

  const total = toFetch.length;
  let done = 0;
  const bump = (): void => {
    done += 1;
    opts.onProgress?.(done, total);
  };
  opts.onProgress?.(0, total);

  let failedNoCache = false;
  await Promise.all(
    toFetch.map((m) =>
      movieLimiter.run(async () => {
        // Another overlapping run may have just cached this fresh — skip the fetch.
        const fresh = getReleaseEntry(m.id);
        if (!opts.force && fresh && isReleaseEntryFresh(fresh, Date.now())) {
          out.push(fromCache(m, fresh));
          bump();
          return;
        }
        try {
          const detail: any = await movieDedupe(m.id, () => api.get<any>(`/movies/${m.id}`));
          const entry: ReleaseEntry = {
            releaseDate: detail?.releaseDate ?? null,
            releaseYear: detail?.releaseYear ?? m.year ?? null,
            title: detail?.title ?? m.title,
            poster: detail?.images?.poster ?? detail?.posterUrl ?? m.poster ?? null,
            savedAt: Date.now(),
            ttlJitter: releaseTtlJitter(),
          };
          setReleaseEntry(m.id, entry);
          opts.queryClient?.setQueryData(qk.movie(m.id), detail);
          out.push({
            id: m.id,
            title: entry.title,
            poster: entry.poster,
            year: entry.releaseYear,
            releaseDate: entry.releaseDate,
          });
        } catch {
          const stale = getReleaseEntry(m.id);
          if (stale) out.push(fromCache(m, stale)); // stale-while-revalidate
          else failedNoCache = true; // no cached copy — leave it out entirely
        } finally {
          bump();
        }
      }),
    ),
  );
  await flushReleaseDateCache();
  return { entries: out, failedNoCache };
}
