/**
 * Deferred, low-priority warm-up for both Upcoming tabs. Runs a couple seconds after
 * start (see app/_layout) so the tabs are instant when first opened. Reads already-
 * available data (persisted query cache) and only does work when the on-device caches
 * are stale. Never blocks startup; all failures are swallowed.
 */
import type { QueryClient } from '@tanstack/react-query';
import { MediaType } from '@tvwatch/shared';
import { airTimeLabel } from './airtime';
import type { WatchlistLite } from './upcoming-movies';
import { loadUpcomingMovieDates } from './upcoming-movies-loader';
import { resolveUpcomingAirtimes } from './upcoming-airtimes';

function movieWatchlistFromCache(queryClient: QueryClient): WatchlistLite[] {
  const matches = queryClient.getQueriesData<any>({ queryKey: ['watchlist', 'paged'] });
  const out: WatchlistLite[] = [];
  const seen = new Set<string>();
  for (const [key, data] of matches) {
    if ((key as unknown[])[2] !== MediaType.MOVIE) continue;
    for (const page of data?.pages ?? []) {
      for (const m of page?.items ?? []) {
        if (!m?.id || seen.has(m.id)) continue;
        seen.add(m.id);
        out.push({
          id: m.id,
          title: m.title,
          poster: m.images?.poster ?? m.posterUrl ?? null,
          year: m.year ?? null,
        });
      }
    }
  }
  return out;
}

function timelessFromUpcoming(upcoming: any): any[] {
  const items: any[] = [];
  for (const g of upcoming?.groups ?? []) {
    for (const it of g.items ?? []) {
      if (it?.seasonNumber == null || it?.episodeNumber == null) continue;
      if (!airTimeLabel(it.airDate, it.airTime)) items.push(it);
    }
  }
  return items;
}

export async function prefetchUpcoming(queryClient: QueryClient): Promise<void> {
  // Movies: the loader only fetches entries that are missing or stale, so this is a
  // no-op when everything is already fresh.
  try {
    const items = movieWatchlistFromCache(queryClient);
    if (items.length) await loadUpcomingMovieDates(items, { queryClient });
  } catch {
    // ignore
  }

  // Shows: warm TVmaze air times for the persisted /me/upcoming slice.
  try {
    const items = timelessFromUpcoming(queryClient.getQueryData(['upcoming']));
    if (items.length) await resolveUpcomingAirtimes(items);
  } catch {
    // ignore
  }
}
