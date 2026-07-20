/**
 * IANA timezone helpers built on Intl (no library). Used to schedule per-user
 * notifications in the USER's timezone: "today" and wall-clock spread times must be
 * computed against the device's tz, not the server's.
 */

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Wall-clock parts of instant `at` in timezone `tz`. */
export function zonedParts(at: Date, tz: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24, // some environments render midnight as "24"
    minute: get('minute'),
    second: get('second'),
  };
}

/** Offset (ms) of timezone `tz` at instant `at`: wall-clock-as-UTC minus real UTC. */
export function tzOffsetMs(tz: string, at: Date): number {
  const p = zonedParts(at, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - at.getTime();
}

/** The UTC instant of a local wall time (y-m-d h:m) in timezone `tz`. */
export function utcFromZoned(tz: string, y: number, m: number, d: number, h = 0, min = 0): Date {
  const guess = new Date(Date.UTC(y, m - 1, d, h, min));
  return new Date(guess.getTime() - tzOffsetMs(tz, guess));
}

/** The user's local day containing `at` as a UTC [start, end) range. */
export function zonedDayRange(tz: string, at: Date): { start: Date; end: Date } {
  const p = zonedParts(at, tz);
  const start = utcFromZoned(tz, p.year, p.month, p.day, 0, 0);
  // Date.UTC rolls d+1 into the next month correctly; 00:00 exists on every day.
  const end = utcFromZoned(tz, p.year, p.month, p.day + 1, 0, 0);
  return { start, end };
}

/** True when `tz` is a valid IANA timezone name. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
