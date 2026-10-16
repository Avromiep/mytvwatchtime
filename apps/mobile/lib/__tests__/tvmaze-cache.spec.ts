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
  TVMAZE_CACHE_KEY,
  __resetTvmazeCacheForTests,
  clearTvmazeCache,
  episodeKey,
  flushTvmazeCache,
  getEpisode,
  getShow,
  isEpisodeFresh,
  isShowFresh,
  loadTvmazeCache,
  setEpisode,
  setShow,
} from '../tvmaze-cache';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

beforeEach(() => {
  for (const k of Object.keys(mockStore)) delete mockStore[k];
  __resetTvmazeCacheForTests();
  jest.clearAllMocks();
});

describe('tvmaze-cache', () => {
  it('treats corrupt JSON as empty and never throws', async () => {
    mockStore[TVMAZE_CACHE_KEY] = 'not-json{';
    await expect(loadTvmazeCache()).resolves.toBeUndefined();
    expect(getShow('x')).toBeUndefined();
  });

  it('resolved show ids live 30 days; a null id (404) only 6h', () => {
    const now = 1_000_000_000_000;
    const resolved = { id: 5, hasNetwork: true, webChannel: null, savedAt: now };
    expect(isShowFresh(resolved, now + 29 * DAY)).toBe(true);
    expect(isShowFresh(resolved, now + 31 * DAY)).toBe(false);
    const notFound = { id: null, hasNetwork: false, webChannel: null, savedAt: now };
    expect(isShowFresh(notFound, now + 5 * HOUR)).toBe(true);
    expect(isShowFresh(notFound, now + 7 * HOUR)).toBe(false);
  });

  it('episode TTL: 12h if airing within 7 days, 24h otherwise, 6h for not-found', () => {
    const now = 1_000_000_000_000;
    const soon = { airstamp: new Date(now + 2 * DAY).toISOString(), hasNetwork: true, webChannel: null, savedAt: now };
    const far = { airstamp: new Date(now + 30 * DAY).toISOString(), hasNetwork: true, webChannel: null, savedAt: now };
    const notFound = { airstamp: null, hasNetwork: false, webChannel: null, savedAt: now };
    expect(isEpisodeFresh(soon, now + 11 * HOUR)).toBe(true);
    expect(isEpisodeFresh(soon, now + 13 * HOUR)).toBe(false);
    expect(isEpisodeFresh(far, now + 13 * HOUR)).toBe(true);
    expect(isEpisodeFresh(far, now + 25 * HOUR)).toBe(false);
    expect(isEpisodeFresh(notFound, now + 5 * HOUR)).toBe(true);
    expect(isEpisodeFresh(notFound, now + 7 * HOUR)).toBe(false);
  });

  it('batches writes and flushes once', async () => {
    await loadTvmazeCache();
    setShow('show-1', { id: 7, hasNetwork: true, webChannel: null });
    setEpisode(episodeKey('show-1', 1, 1), { airstamp: '2026-09-09T02:00:00Z', hasNetwork: true, webChannel: null });
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
    await flushTvmazeCache();
    expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);
    expect(getShow('show-1')?.id).toBe(7);
    expect(getEpisode(episodeKey('show-1', 1, 1))?.airstamp).toBe('2026-09-09T02:00:00Z');
  });

  it('clear wipes memory and disk', async () => {
    await loadTvmazeCache();
    setShow('show-1', { id: 7, hasNetwork: false, webChannel: 'Prime Video' });
    await flushTvmazeCache();
    await clearTvmazeCache();
    expect(getShow('show-1')).toBeUndefined();
    expect(mockStore[TVMAZE_CACHE_KEY]).toBeUndefined();
  });
});
