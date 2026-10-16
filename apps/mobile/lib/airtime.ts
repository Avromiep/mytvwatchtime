/**
 * Air-time formatting helpers, shared by the Upcoming Shows card and the screen-level
 * TVmaze resolver. Kept dependency-free and Hermes-safe: Eastern time is computed with
 * plain DST arithmetic, never Intl named time zones (which Hermes ships without).
 */

/** Day-of-month of the nth Sunday of a month (month is 0-indexed, UTC). */
export function nthSundayOfMonth(year: number, month: number, n: number): number {
  const firstDow = new Date(Date.UTC(year, month, 1)).getUTCDay(); // 0 = Sunday
  return 1 + ((7 - firstDow) % 7) + (n - 1) * 7;
}

/** US Eastern offset in minutes for a UTC instant (EDT = -240, EST = -300). DST runs
 *  from 07:00 UTC on the 2nd Sunday of March to 06:00 UTC on the 1st Sunday of November. */
export function easternOffsetMinutes(utcMs: number): number {
  const y = new Date(utcMs).getUTCFullYear();
  const dstStart = Date.UTC(y, 2, nthSundayOfMonth(y, 2, 2), 7);
  const dstEnd = Date.UTC(y, 10, nthSundayOfMonth(y, 10, 1), 6);
  return utcMs >= dstStart && utcMs < dstEnd ? -240 : -300;
}

/** Format a full ISO instant (with tz offset) as 12-hour Eastern. */
export function airstampToET(stamp?: string | null): string | null {
  if (!stamp) return null;
  const t = new Date(stamp).getTime();
  if (Number.isNaN(t)) return null;
  const et = new Date(t + easternOffsetMinutes(t) * 60000);
  let h = et.getUTCHours();
  const min = et.getUTCMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(min).padStart(2, '0')} ${ampm} ET`;
}

/** Normalize a provider air-time string to 12-hour Eastern. Handles 24-hour ("22:00")
 *  and existing 12-hour ("10:00 PM") inputs; returns the raw value if unrecognized. */
export function formatAirTimeET(raw?: string | null): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  const twelve = /(\d{1,2}):(\d{2})\s*([AaPp][Mm])/.exec(s);
  if (twelve) return `${parseInt(twelve[1], 10)}:${twelve[2]} ${twelve[3].toUpperCase()} ET`;
  const m = /^(\d{1,2}):(\d{2})/.exec(s);
  if (!m) return s;
  let h = parseInt(m[1], 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m[2]} ${ampm} ET`;
}

/** Air time as 12-hour Eastern. Prefers the real air moment embedded in airDate (when
 *  it carries a clock, not just a midnight-UTC date); otherwise falls back to the
 *  provider's separate air-time string. Returns null when no time is known. */
export function airTimeLabel(airDate?: string | null, airTime?: string | null): string | null {
  if (airDate) {
    const t = new Date(airDate).getTime();
    const d = new Date(airDate);
    const hasClock = !Number.isNaN(t) && (d.getUTCHours() !== 0 || d.getUTCMinutes() !== 0);
    if (hasClock) {
      const et = new Date(t + easternOffsetMinutes(t) * 60000);
      let h = et.getUTCHours();
      const min = et.getUTCMinutes();
      const ampm = h >= 12 ? 'PM' : 'AM';
      h = h % 12 || 12;
      return `${h}:${String(min).padStart(2, '0')} ${ampm} ET`;
    }
  }
  return formatAirTimeET(airTime);
}

/** Streaming release convention in ET. The major services (Netflix, Prime Video,
 *  Apple TV+, Disney+, Hulu, Max, Paramount+, Peacock) drop new episodes at
 *  12:00 AM Pacific = 3:00 AM ET. TVmaze stores no real per-episode streaming time. */
export function streamingDropET(_platform?: string | null): string {
  return '3:00 AM ET';
}

/** Minimal shapes we read off TVmaze responses. */
export interface TvmazeShow {
  network?: unknown;
  webChannel?: { name?: string | null } | null;
}
export interface TvmazeEpisode {
  airstamp?: string | null;
}

/** Turn a TVmaze episode (+ its show) into a 12-hour ET label, applying the streaming
 *  "noon UTC placeholder" convention. Returns null when no usable time exists. */
export function tvmazeEpisodeTimeLabel(
  episode: TvmazeEpisode | null | undefined,
  show: TvmazeShow | null | undefined,
): string | null {
  const stamp = episode?.airstamp;
  if (!stamp) return null;
  const d = new Date(stamp);
  if (Number.isNaN(d.getTime())) return null;
  // TVmaze stores a fake "noon UTC" placeholder for streaming shows (no broadcast
  // network) — not a real drop time, so use the platform convention instead.
  const isStreamingPlaceholder =
    !show?.network && d.getUTCHours() === 12 && d.getUTCMinutes() === 0;
  if (isStreamingPlaceholder) return streamingDropET(show?.webChannel?.name ?? null);
  return airstampToET(stamp);
}
