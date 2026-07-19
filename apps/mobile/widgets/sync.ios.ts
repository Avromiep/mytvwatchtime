import Constants from 'expo-constants';
import { ExtensionStorage } from '@bacons/apple-targets';
import i18n from '../i18n';
import { tokenStorage } from '../api/storage';
import { ensureWidgetLocale, getWidgetLabels } from './data';

// Must match ios.entitlements in app.json and the widget target's expo-target.config.js.
const APP_GROUP = 'group.app.tvwatchtime.mobile';

const storage = new ExtensionStorage(APP_GROUP);

const DEFAULT_BASE_URL =
  (Constants.expoConfig?.extra as any)?.apiBaseUrl || 'https://api.tvwatchtime.org/api';

/**
 * The iOS widgets are separate processes that fetch the API directly (WidgetKit timeline).
 * They read credentials from the shared App Group container; this pushes the current
 * tokens / base URL / locale + localized labels there and reloads the timelines.
 */
export async function syncWidgetCredentials(): Promise<void> {
  try {
    await ensureWidgetLocale();
    const [access, refresh, apiUrl] = await Promise.all([
      tokenStorage.getAccess(),
      tokenStorage.getRefresh(),
      tokenStorage.getApiUrl(),
    ]);
    storage.set('accessToken', access ?? undefined);
    storage.set('refreshToken', refresh ?? undefined);
    storage.set('baseUrl', apiUrl || DEFAULT_BASE_URL);
    storage.set('locale', i18n.language || 'en');
    storage.set('widgetLabels', JSON.stringify(getWidgetLabels()));
    ExtensionStorage.reloadWidget();
  } catch {
    // widget sync is best-effort
  }
}

export async function clearWidgetCredentials(): Promise<void> {
  try {
    storage.set('accessToken', undefined);
    storage.set('refreshToken', undefined);
    ExtensionStorage.reloadWidget();
  } catch {
    // ignore
  }
}

export async function syncWidgetLabels(): Promise<void> {
  try {
    storage.set('locale', i18n.language || 'en');
    storage.set('widgetLabels', JSON.stringify(getWidgetLabels()));
    ExtensionStorage.reloadWidget();
  } catch {
    // ignore
  }
}

/** Ask WidgetKit to build fresh timelines (each reload re-fetches the API). */
export async function refreshWidgets(): Promise<void> {
  try {
    ExtensionStorage.reloadWidget();
  } catch {
    // ignore
  }
}
