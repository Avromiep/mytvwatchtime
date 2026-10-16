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

import { resolveUpcomingAirtimes, showResolveKey } from '../upcoming-airtimes';
import { __resetTvmazeCacheForTests, getShow, isShowFresh } from '../tvmaze-cache';

const item = { mediaId: 's1', title: 'Reacher', seasonNumber: 4, episodeNumber: 7 };
const HOUR = 60 * 60 * 1000;
const originalFetch = global.fetch;

beforeEach(() => {
  for (const k of Object.keys(mockStore)) delete mockStore[k];
  __resetTvmazeCacheForTests();
});
afterEach(() => {
  global.fetch = originalFetch;
});

describe('resolveUpcomingAirtimes caching', () => {
  it('does not cache a show on a 500 error', async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 500, ok: false }) as any;
    await resolveUpcomingAirtimes([item]);
    expect(getShow(showResolveKey(item))).toBeUndefined();
  });

  it('does not cache a show on a network error', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('offline')) as any;
    await resolveUpcomingAirtimes([item]);
    expect(getShow(showResolveKey(item))).toBeUndefined();
  });

  it('caches a real 404 as not-found with the 6h TTL', async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 404, ok: false }) as any;
    await resolveUpcomingAirtimes([item]);
    const e = getShow(showResolveKey(item));
    expect(e).toBeDefined();
    expect(e?.id).toBeNull();
    expect(isShowFresh(e!, e!.savedAt + 5 * HOUR)).toBe(true);
    expect(isShowFresh(e!, e!.savedAt + 7 * HOUR)).toBe(false);
  });
});
