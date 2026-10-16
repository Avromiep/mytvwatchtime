/**
 * Pure helpers for the Upcoming Movies tab — no imports, so they're trivially unit
 * testable and safe to load in any environment. The async loader that fills these
 * rows (network + cache) lives in ./upcoming-movies-loader.
 */

/** Resolved release info for one watchlist movie (from cache or /movies/{id}). */
export interface MovieDateInfo {
  id: string;
  title: string;
  poster: string | null;
  year: number | null;
  releaseDate: string | null;
  /** True when the detail couldn't be loaded and nothing was cached (shown as TBA). */
  loadFailed?: boolean;
}

/** A row rendered in the Upcoming Movies grid. */
export interface UpcomingMovieRow {
  id: string;
  title: string;
  posterUrl: string | null;
  year: number | null;
  upcomingLabel: string; // "Today" | "N days left" | "TBA"
  dateLabel: string | null;
  tba: boolean;
  sort: number;
}

/** Lite watchlist item shape the loader works from. */
export interface WatchlistLite {
  id: string;
  title: string;
  poster: string | null;
  year: number | null;
}

/** Localizable labels for the upcoming-movie rows. */
export interface UpcomingMovieLabels {
  today: string;
  tba: string;
  daysLeft: (n: number) => string;
}

/** English defaults, so the pure builder works without an i18n context. */
export const DEFAULT_UPCOMING_LABELS: UpcomingMovieLabels = {
  today: 'Today',
  tba: 'TBA',
  daysLeft: (n) => `${n} ${n === 1 ? 'day' : 'days'} left`,
};

/**
 * Build the sorted Upcoming Movies rows. Behavior preserved exactly from the original
 * in-component memo:
 *  - dated movies in the future first (soonest → latest), using the date's UTC calendar
 *    day vs today's local calendar day; "Today" / "N days left"; label via
 *    toLocaleDateString with timeZone 'UTC';
 *  - already-released movies (UTC day < today) are skipped;
 *  - dateless movies whose year >= the current year are shown as "TBA", ordered after
 *    the dated ones by year.
 */
export function buildUpcomingMovieRows(
  entries: MovieDateInfo[],
  now: Date,
  labels: UpcomingMovieLabels = DEFAULT_UPCOMING_LABELS,
): UpcomingMovieRow[] {
  const currentYear = now.getFullYear();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const rows: UpcomingMovieRow[] = [];
  for (const m of entries) {
    if (!m) continue;
    const base = { id: m.id, title: m.title, posterUrl: m.poster, year: m.year };
    const d = m.releaseDate ? new Date(m.releaseDate) : null;
    if (d && !Number.isNaN(d.getTime())) {
      const target = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      if (target < today) continue; // released already — not upcoming
      const days = Math.round((target - today) / 86400000);
      rows.push({
        ...base,
        upcomingLabel: days === 0 ? labels.today : labels.daysLeft(days),
        dateLabel: d.toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          timeZone: 'UTC',
        }),
        tba: false,
        sort: target,
      });
    } else if (base.year != null && base.year >= currentYear) {
      rows.push({ ...base, upcomingLabel: labels.tba, dateLabel: null, tba: true, sort: base.year });
    }
  }
  // Dated movies first (soonest → latest), then TBA movies (earliest year first).
  rows.sort((a, b) => (a.tba !== b.tba ? (a.tba ? 1 : -1) : a.sort - b.sort));
  return rows;
}
