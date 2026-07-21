import { normalizeTvTimeOutMovies } from './movies';
import { normalizeTvTimeOutFailed } from './failed';

const movie = (over: Record<string, unknown> = {}) => ({
  id: { tvdb: 132202, imdb: 'tt10954600' },
  uuid: 'm1',
  created_at: '2023-02-17T23:34:11Z',
  title: 'Some Movie',
  year: 2023,
  watched_at: '2024-02-07T22:47:37Z',
  is_watched: true,
  is_favorite: false,
  rewatch_count: 0,
  ...over,
});

describe('normalizeTvTimeOutMovies', () => {
  it('splits watched and watchlist movies, favorites independent of watched state', () => {
    const res = normalizeTvTimeOutMovies([
      movie(),
      movie({
        id: { tvdb: 367574, imdb: 'tt37038661' },
        title: 'Unwatched Fav',
        watched_at: null,
        is_watched: false,
        is_favorite: true,
      }),
    ]);
    expect(res.watched).toHaveLength(1);
    expect(res.watchlist).toHaveLength(1);
    expect(res.favorites).toHaveLength(1);
    expect(res.watchlist[0]).toMatchObject({ type: 'movie', title: 'Unwatched Fav' });
    expect(res.favorites[0].title).toBe('Unwatched Fav');
    expect(res.invalid).toBe(0);
  });

  it('maps rewatch_count to watchCount (rewatches + 1)', () => {
    const res = normalizeTvTimeOutMovies([movie({ rewatch_count: 2 })]);
    expect(res.watched[0].watchCount).toBe(3);
  });

  it('prefers the explicit year field over a title-suffix year', () => {
    const res = normalizeTvTimeOutMovies([movie({ title: 'Thing (1999)', year: 2001 })]);
    expect(res.watched[0].year).toBe(2001);
  });

  it('dedupes by strongest external id', () => {
    const res = normalizeTvTimeOutMovies([movie(), movie()]);
    expect(res.watched).toHaveLength(1);
  });

  it('counts invalid rows without throwing', () => {
    const res = normalizeTvTimeOutMovies([{ id: { tvdb: 1 } }]);
    expect(res.invalid).toBe(1);
  });
});

describe('normalizeTvTimeOutFailed', () => {
  it('parses the failed-shows report', () => {
    const res = normalizeTvTimeOutFailed({
      date: '2026-07-15',
      total_failed: 1,
      shows: [{ title: 'Alphas', tvdbId: 210841 }],
    });
    expect(res.total).toBe(1);
    expect(res.shows).toEqual([{ title: 'Alphas', tvdbId: 210841 }]);
  });

  it('falls back to the parsed count when total_failed is absent', () => {
    const res = normalizeTvTimeOutFailed({ shows: [{ title: 'A', tvdbId: 1 }, { title: 'B', tvdbId: 2 }] });
    expect(res.total).toBe(2);
  });

  it('never throws on garbage', () => {
    expect(normalizeTvTimeOutFailed(null)).toEqual({ total: 0, shows: [] });
    expect(normalizeTvTimeOutFailed([1, 2, 3])).toEqual({ total: 0, shows: [] });
  });
});
