import {
  isValidTimeZone,
  tzOffsetMs,
  utcFromZoned,
  zonedDayRange,
  zonedParts,
} from './timezone.util';

describe('timezone.util', () => {
  it('computes the tz offset at an instant (DST-aware)', () => {
    const winter = new Date('2026-01-15T12:00:00Z');
    const summer = new Date('2026-07-15T12:00:00Z');
    expect(tzOffsetMs('America/New_York', winter)).toBe(-5 * 3600_000);
    expect(tzOffsetMs('America/New_York', summer)).toBe(-4 * 3600_000);
    expect(tzOffsetMs('UTC', summer)).toBe(0);
  });

  it('utcFromZoned converts a local wall-clock time to UTC (both DST seasons)', () => {
    expect(utcFromZoned('America/New_York', 2026, 1, 15, 12, 0).toISOString()).toBe(
      '2026-01-15T17:00:00.000Z',
    );
    expect(utcFromZoned('America/New_York', 2026, 7, 15, 12, 0).toISOString()).toBe(
      '2026-07-15T16:00:00.000Z',
    );
    expect(utcFromZoned('Europe/Rome', 2026, 7, 15, 12, 0).toISOString()).toBe(
      '2026-07-15T10:00:00.000Z',
    );
  });

  it('zonedDayRange returns the user-local day as a UTC range', () => {
    const at = new Date('2026-07-15T15:00:00Z');
    const { start, end } = zonedDayRange('Europe/Rome', at); // UTC+2 in July
    expect(start.toISOString()).toBe('2026-07-14T22:00:00.000Z');
    expect(end.toISOString()).toBe('2026-07-15T22:00:00.000Z');

    const pacific = zonedDayRange('Pacific/Auckland', at); // UTC+12 in July → already Jul 16 there
    expect(pacific.start.toISOString()).toBe('2026-07-15T12:00:00.000Z');
    expect(pacific.end.toISOString()).toBe('2026-07-16T12:00:00.000Z');
  });

  it('zonedParts renders the wall clock in the zone', () => {
    const at = new Date('2026-07-15T00:30:00Z');
    const p = zonedParts(at, 'America/New_York'); // still July 14 evening there
    expect([p.year, p.month, p.day, p.hour]).toEqual([2026, 7, 14, 20]);
  });

  it('isValidTimeZone', () => {
    expect(isValidTimeZone('Europe/Rome')).toBe(true);
    expect(isValidTimeZone('not-a-zone')).toBe(false);
  });
});
