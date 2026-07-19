import { ExtensionStorage } from '@bacons/apple-targets';
import i18n from '../i18n';
import { API_DEFAULT_BASE_URL } from '../api/client';
import { tokenStorage } from '../api/storage';
import { ensureWidgetLocale, getWidgetLabels } from './data';

// Must match ios.entitlements in app.json and the widget target's expo-target.config.js.
const APP_GROUP = 'group.app.tvwatchtime.mobile';

const storage = new ExtensionStorage(APP_GROUP);

// WidgetKit reloads are budgeted by the OS and each reload re-fetches the API +
// images, so coalesce bursts (mark-watched sprees) into one reload per window.
const RELOAD_THROTTLE_MS = 5000;
let lastReload = 0;
let trailing: ReturnType<typeof setTimeout> | null = null;

function reloadThrottled(): void {
  const elapsed = Date.now() - lastReload;
  if (elapsed >= RELOAD_THROTTLE_MS && !trailing) {
    lastReload = Date.now();
    ExtensionStorage.reloadWidget();
    return;
  }
  if (trailing) return;
  trailing = setTimeout(() => {
    trailing = null;
    lastReload = Date.now();
    try {
      ExtensionStorage.reloadWidget();
    } catch {
      // ignore
    }
  }, RELOAD_THROTTLE_MS - elapsed);
}

function pushIfChanged(key: string, value: string): boolean {
  if (storage.get(key) === value) return false;
  storage.set(key, value);
  return true;
}

/**
 * The iOS widgets are separate processes that fetch the API directly (WidgetKit
 * timeline). Auth tokens are NOT pushed anywhere: the app and the extension share a
 * keychain access group (see app.json + expo-target.config.js entitlements and
 * TOKEN_OPTIONS in api/storage.ts), and the widget reads/writes that keychain item
 * itself. This only shares non-secret config + localized labels via the App Group,
 * and reloads timelines when something actually changed.
 */
export async function syncWidgetCredentials(): Promise<void> {
  try {
    await ensureWidgetLocale();
    const apiUrl = await tokenStorage.getApiUrl();
    let changed = pushIfChanged('baseUrl', apiUrl || API_DEFAULT_BASE_URL);
    changed = pushIfChanged('locale', i18n.language || 'en') || changed;
    changed = pushIfChanged('widgetLabels', JSON.stringify(getWidgetLabels())) || changed;
    if (changed) reloadThrottled();
  } catch {
    // widget sync is best-effort
  }
}

/** Logout: tokens are already gone from the shared keychain; also evict the widget's
 *  cached API payloads so a previous user's data can't linger on the home screen. */
export async function clearWidgetCredentials(): Promise<void> {
  try {
    storage.remove('cache.watchNext');
    storage.remove('cache.upcoming');
    ExtensionStorage.reloadWidget();
  } catch {
    // ignore
  }
}

export async function syncWidgetLabels(): Promise<void> {
  try {
    let changed = pushIfChanged('locale', i18n.language || 'en');
    changed = pushIfChanged('widgetLabels', JSON.stringify(getWidgetLabels())) || changed;
    if (changed) reloadThrottled();
  } catch {
    // ignore
  }
}

/** Ask WidgetKit to build fresh timelines (each reload re-fetches the API). */
export async function refreshWidgets(): Promise<void> {
  try {
    reloadThrottled();
  } catch {
    // ignore
  }
}
