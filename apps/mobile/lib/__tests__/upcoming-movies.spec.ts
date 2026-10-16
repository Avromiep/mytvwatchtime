import { buildUpcomingMovieRows, type MovieDateInfo } from '../upcoming-movies';

const mk = (over: Partial<MovieDateInfo>): MovieDateInfo => ({
  id: 'x',
  title: 't',
  poster: null,
  year: null,
  releaseDate: null,
  ...over,
});

// Local Sep 9 2026 noon → today's local y/m/d is fixed regardless of the test tz.
const now = new Date(2026, 8, 9, 12, 0, 0);

describe('buildUpcomingMovieRows', () => {
  it('skips movies already released (UTC day < today)', () => {
    expect(buildUpcomingMovieRows([mk({ releaseDate: '2026-09-08T00:00:00Z' })], now)).toHaveLength(0);
  });

  it('labels a same-day release "Today" using the UTC calendar day (even late-UTC)', () => {
    const rows = buildUpcomingMovieRows([mk({ id: 'a', releaseDate: '2026-09-09T23:00:00Z' })], now);
    expect(rows).toHaveLength(1);
    expect(rows[0].upcomingLabel).toBe('Today');
  });

  it('counts whole days ("1 day left" / "10 days left")', () => {
    expect(buildUpcomingMovieRows([mk({ releaseDate: '2026-09-10T00:00:00Z' })], now)[0].upcomingLabel).toBe(
      '1 day left',
    );
    expect(buildUpcomingMovieRows([mk({ releaseDate: '2026-09-19T00:00:00Z' })], now)[0].upcomingLabel).toBe(
      '10 days left',
    );
  });

  it('orders dated before TBA, dated by date and TBA by year', () => {
    const rows = buildUpcomingMovieRows(
      [
        mk({ id: 'tba2027', year: 2027 }),
        mk({ id: 'tba2026', year: 2026 }),
        mk({ id: 'far', releaseDate: '2026-12-01T00:00:00Z' }),
        mk({ id: 'soon', releaseDate: '2026-09-20T00:00:00Z' }),
      ],
      now,
    );
    expect(rows.map((r) => r.id)).toEqual(['soon', 'far', 'tba2026', 'tba2027']);
  });

  it('shows TBA only for dateless movies whose year >= the current year', () => {
    const rows = buildUpcomingMovieRows([mk({ id: 'old', year: 2020 }), mk({ id: 'new', year: 2026 })], now);
    expect(rows.map((r) => r.id)).toEqual(['new']);
    expect(rows[0].upcomingLabel).toBe('TBA');
  });

  it('formats the date label in UTC', () => {
    const rows = buildUpcomingMovieRows([mk({ releaseDate: '2026-09-20T00:00:00Z' })], now);
    expect(rows[0].dateLabel).toBe('Sep 20, 2026');
  });
});
