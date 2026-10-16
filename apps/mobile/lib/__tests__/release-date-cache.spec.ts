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

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  RELEASE_DATE_CACHE_KEY,
  __resetReleaseDateCacheForTests,
  clearReleaseDateCache,
  flushReleaseDateCache,
  getReleaseEntry,
  isReleaseEntryFresh,
  loadReleaseDateCache,
  setReleaseEntry,
  type ReleaseEntry,
} from '../release-date-cache';

const HOUR = 60 * 60 * 1000;
const entry = (over: Partial<ReleaseEntry> = {}): ReleaseEntry => ({
  releaseDate: '2026-09-09',
  releaseYear: 2026,
  title: 't',
  poster: null,
  savedAt: 1_000_000_000_000,
  ...over,
});

beforeEach(() => {
  for (const k of Object.keys(mockStore)) delete mockStore[k];
  __resetReleaseDateCacheForTests();
  jest.clearAllMocks();
});

describe('release-date-cache', () => {
  it('treats corrupt JSON as empty and never throws', async () => {
    mockStore[RELEASE_DATE_CACHE_KEY] = '{not valid json';
    await expect(loadReleaseDateCache()).resolves.toBeUndefined();
    expect(getReleaseEntry('x')).toBeUndefined();
  });

  it('applies 24h TTL to dated entries and 12h to TBA (null) entries', () => {
    const now = 1_000_000_000_000;
    const dated = entry({ savedAt: now });
    const tba = entry({ releaseDate: null, savedAt: now });
    expect(isReleaseEntryFresh(dated, now + 23 * HOUR)).toBe(true);
    expect(isReleaseEntryFresh(dated, now + 25 * HOUR)).toBe(false);
    expect(isReleaseEntryFresh(tba, now + 11 * HOUR)).toBe(true);
    expect(isReleaseEntryFresh(tba, now + 13 * HOUR)).toBe(false);
  });

  it('batches writes: setEntry does not persist immediately; flush writes once', async () => {
    await loadReleaseDateCache();
    setReleaseEntry('a', entry({ title: 'A' }));
    setReleaseEntry('b', entry({ title: 'B', releaseDate: null }));
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
    await flushReleaseDateCache();
    expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);
    expect(Object.keys(JSON.parse(mockStore[RELEASE_DATE_CACHE_KEY]))).toEqual(['a', 'b']);
  });

  it('clear wipes memory and disk', async () => {
    await loadReleaseDateCache();
    setReleaseEntry('a', entry());
    await flushReleaseDateCache();
    await clearReleaseDateCache();
    expect(getReleaseEntry('a')).toBeUndefined();
    expect(mockStore[RELEASE_DATE_CACHE_KEY]).toBeUndefined();
  });
});
