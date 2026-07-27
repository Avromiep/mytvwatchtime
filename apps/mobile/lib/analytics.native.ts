import analytics from '@react-native-firebase/analytics';
import crashlytics from '@react-native-firebase/crashlytics';
import * as SecureStore from 'expo-secure-store';
import type { CurrentUserDto } from '@tvwatch/shared';
import { tokenStorage } from '../api/storage';

const FIRST_KEY_PREFIX = 'tvwatch.analytics.first.';

let initialized = false;

export function initAnalytics() {
  if (initialized) return;
  initialized = true;
  const utils = (globalThis as any).ErrorUtils;
  if (utils?.getGlobalHandler && utils?.setGlobalHandler) {
    const previous = utils.getGlobalHandler();
    utils.setGlobalHandler((error: Error, isFatal?: boolean) => {
      try {
        crashlytics().recordError(error);
      } catch {
        // never let crash reporting break the app's own error path
      }
      previous?.(error, isFatal);
    });
  }
}

export function setAnalyticsUser(userId: string | null) {
  void Promise.all([
    analytics().setUserId(userId),
    crashlytics().setUserId(userId ?? ''),
  ]).catch(() => {});
}

export function logEvent(name: string) {
  void analytics()
    .logEvent(name)
    .catch(() => {});
}

export function logFirstEvent(name: string, userId?: string | null) {
  void (async () => {
    let uid = userId ?? null;
    if (!uid) {
      const user = await tokenStorage.getUser<CurrentUserDto>().catch(() => null);
      uid = user?.id ?? null;
    }
    if (!uid) return;
    const key = `${FIRST_KEY_PREFIX}${uid}.${name}`;
    const seen = await SecureStore.getItemAsync(key).catch(() => null);
    if (seen) return;
    await analytics()
      .logEvent(name)
      .catch(() => {});
    await SecureStore.setItemAsync(key, '1').catch(() => {});
  })();
}
