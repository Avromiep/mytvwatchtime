const mockLogEvent = jest.fn(() => Promise.resolve());
const mockSetUserId = jest.fn(() => Promise.resolve());
const mockRecordError = jest.fn();

jest.mock('@react-native-firebase/analytics', () => ({
  __esModule: true,
  default: () => ({ logEvent: mockLogEvent, setUserId: mockSetUserId }),
}));

jest.mock('@react-native-firebase/crashlytics', () => ({
  __esModule: true,
  default: () => ({ recordError: mockRecordError, setUserId: mockSetUserId }),
}));

const secureStoreData = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn((key: string) => Promise.resolve(secureStoreData.get(key) ?? null)),
  setItemAsync: jest.fn((key: string, value: string) => {
    secureStoreData.set(key, value);
    return Promise.resolve();
  }),
}));

let storedUser: unknown = null;
jest.mock('../../api/storage', () => ({
  tokenStorage: {
    getUser: jest.fn(() => Promise.resolve(storedUser)),
  },
}));

import { logEvent, logFirstEvent, setAnalyticsUser, initAnalytics } from '../analytics.native';

const flush = () => new Promise<void>((resolve) => setImmediate(() => resolve()));

beforeEach(() => {
  jest.clearAllMocks();
  secureStoreData.clear();
  storedUser = null;
});

describe('logFirstEvent', () => {
  it('logs once per user and persists the dedupe flag', async () => {
    logFirstEvent('first_login', 'u1');
    await flush();
    logFirstEvent('first_login', 'u1');
    await flush();
    expect(mockLogEvent).toHaveBeenCalledTimes(1);
    expect(mockLogEvent).toHaveBeenCalledWith('first_login');
    expect(secureStoreData.get('tvwatch.analytics.first.u1.first_login')).toBe('1');
  });

  it('tracks the same event independently per user', async () => {
    logFirstEvent('first_login', 'u1');
    await flush();
    logFirstEvent('first_login', 'u2');
    await flush();
    expect(mockLogEvent).toHaveBeenCalledTimes(2);
  });

  it('tracks different events independently for the same user', async () => {
    logFirstEvent('first_comment', 'u1');
    await flush();
    logFirstEvent('first_comment_like', 'u1');
    await flush();
    expect(mockLogEvent).toHaveBeenCalledTimes(2);
  });

  it('resolves the user id from stored auth when not provided', async () => {
    storedUser = { id: 'u9' };
    logFirstEvent('first_watched_episode');
    await flush();
    expect(mockLogEvent).toHaveBeenCalledWith('first_watched_episode');
    expect(secureStoreData.get('tvwatch.analytics.first.u9.first_watched_episode')).toBe('1');
  });

  it('does nothing when no user id is available', async () => {
    logFirstEvent('first_login');
    await flush();
    expect(mockLogEvent).not.toHaveBeenCalled();
  });
});

describe('logEvent', () => {
  it('logs without dedupe', () => {
    logEvent('delete_account');
    logEvent('delete_account');
    expect(mockLogEvent).toHaveBeenCalledTimes(2);
  });
});

describe('setAnalyticsUser', () => {
  it('sets the id on analytics and crashlytics', async () => {
    setAnalyticsUser('u1');
    await flush();
    expect(mockSetUserId).toHaveBeenCalledWith('u1');
    expect(mockSetUserId).toHaveBeenCalledTimes(2);
  });

  it('clears with an empty crashlytics id on null', async () => {
    setAnalyticsUser(null);
    await flush();
    expect(mockSetUserId).toHaveBeenCalledWith(null);
    expect(mockSetUserId).toHaveBeenCalledWith('');
  });
});

describe('initAnalytics', () => {
  it('is safe to call when ErrorUtils is unavailable', () => {
    expect(() => initAnalytics()).not.toThrow();
  });
});
