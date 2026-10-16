const mockStore: Record<string, string> = {};
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn((k: string) => Promise.resolve(mockStore[k] ?? null)),
    setItem: jest.fn((k: string, v: string) => {
      mockStore[k] = v;
      return Promise.resolve();
    }),
    removeItem: jest.fn((k: string) => {
      delete mockStore[k];
      return Promise.resolve();
    }),
  },
}));

const apiGet = jest.fn();
jest.mock('../../api/client', () => ({ api: { get: (...a: any[]) => apiGet(...a) } }));
jest.mock('../../api/hooks', () => ({ qk: { movie: (id: string) => ['movie', id] } }));

import { loadUpcomingMovieDates } from '../upcoming-movies-loader';
import { __resetReleaseDateCacheForTests } from '../release-date-cache';
import type { WatchlistLite } from '../upcoming-movies';

const movie = (id: string, over: Partial<WatchlistLite> = {}): WatchlistLite => ({
  id,
  title: `T${id}`,
  poster: null,
  year: 2099, // always a candidate, regardless of the year the test runs
  ...over,
});

beforeEach(() => {
  for (const k of Object.keys(mockStore)) delete mockStore[k];
  __resetReleaseDateCacheForTests();
  apiGet.mockReset();
});

describe('loadUpcomingMovieDates', () => {
  it('fetches each movie once across two overlapping runs', async () => {
    apiGet.mockImplementation(
      () =>
        new Promise((r) =>
          setTimeout(() => r({ id: 'm1', releaseDate: '2099-12-01', releaseYear: 2099, title: 'M1' }), 10),
        ),
    );
    const items = [movie('m1')];
    const [a, b] = await Promise.all([loadUpcomingMovieDates(items), loadUpcomingMovieDates(items)]);
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(a.entries).toHaveLength(1);
    expect(b.entries).toHaveLength(1);
  });

  it('renders from cache with no network when entries are fresh', async () => {
    apiGet.mockResolvedValue({ id: 'm1', releaseDate: '2099-12-01', releaseYear: 2099, title: 'M1' });
    await loadUpcomingMovieDates([movie('m1')]); // first run caches
    apiGet.mockClear();
    const res = await loadUpcomingMovieDates([movie('m1')]); // second run: fresh cache
    expect(apiGet).not.toHaveBeenCalled();
    expect(res.entries).toHaveLength(1);
  });

  it('adding one id fetches only that id', async () => {
    apiGet.mockImplementation((url: string) =>
      Promise.resolve({ id: url.split('/').pop(), releaseDate: '2099-12-01', releaseYear: 2099, title: 'x' }),
    );
    await loadUpcomingMovieDates([movie('m1')]);
    apiGet.mockClear();
    await loadUpcomingMovieDates([movie('m1'), movie('m2')]);
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(apiGet).toHaveBeenCalledWith('/movies/m2');
  });

  it('leaves out a movie that fails with no cached copy and flags it', async () => {
    apiGet.mockRejectedValue(new Error('boom'));
    const res = await loadUpcomingMovieDates([movie('m1')]);
    expect(res.entries).toHaveLength(0);
    expect(res.failedNoCache).toBe(true);
  });
});
