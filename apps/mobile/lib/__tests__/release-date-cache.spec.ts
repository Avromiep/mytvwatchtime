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
const DAY = 24 * HOUR;
const entry = (over: Partial<ReleaseEntry> = {}): ReleaseEntry => ({
  releaseDate: '2026-09-09',
  releaseYear: 2026,
  title: 't',
  poster: null,
  savedAt: 1_000_000_000_000,
  ttlJitter: 0,
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

  it('TTL (no jitter): near=24h, far(>30d)=7d, TBA=3d', () => {
    const now = 1_000_000_000_000;
    const near = entry({ releaseDate: new Date(now + 10 * DAY).toISOString(), savedAt: now });
    const far = entry({ releaseDate: new Date(now + 60 * DAY).toISOString(), savedAt: now });
    const tba = entry({ releaseDate: null, savedAt: now });
    expect(isReleaseEntryFresh(near, now + 23 * HOUR)).toBe(true);
    expect(isReleaseEntryFresh(near, now + 25 * HOUR)).toBe(false);
    expect(isReleaseEntryFresh(far, now + 6 * DAY)).toBe(true);
    expect(isReleaseEntryFresh(far, now + 8 * DAY)).toBe(false);
    expect(isReleaseEntryFresh(tba, now + 2 * DAY)).toBe(true);
    expect(isReleaseEntryFresh(tba, now + 4 * DAY)).toBe(false);
  });

  it('per-entry jitter extends the TTL', () => {
    const now = 1_000_000_000_000;
    // base 24h + 20% jitter ≈ 28.8h
    const jittered = entry({ releaseDate: new Date(now + 10 * DAY).toISOString(), savedAt: now, ttlJitter: 0.2 });
    expect(isReleaseEntryFresh(jittered, now + 25 * HOUR)).toBe(true);
    expect(isReleaseEntryFresh(jittered, now + 29 * HOUR)).toBe(false);
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
