import AsyncStorage from '@react-native-async-storage/async-storage';
import { requestWidgetUpdate } from 'react-native-android-widget';
import {
  WIDGET_KINDS,
  fetchUpcomingGroups,
  fetchWatchNextItems,
  getWidgetLabels,
  invalidateWidgetDataCache,
} from './data';
import { renderUpcomingWidget, renderWatchNextWidget } from './android/render';

// Android widgets run in this app's process (headless JS) and read tokens from the
// keychain/SecureStore themselves, so there is nothing to push — "sync" just
// re-renders every home-screen instance with fresh API data.
//
// Every mark-watched/watchlist mutation funnels here, so coalesce bursts into one
// update per window (each update already shares one fetch across instances via the
// memoized data cache in data.ts).
const UPDATE_THROTTLE_MS = 5000;
let lastUpdate = 0;
let trailing: ReturnType<typeof setTimeout> | null = null;

// Skip no-op re-renders: the widget library downloads every remote bitmap uncached,
// so pushing an identical payload visibly reloads every image (most noticeable as
// the trailing throttle edge firing ~5s after the leading update). Hash the payload
// plus the localized labels (also part of the rendered tree) and only re-render
// when something actually changed.
const HASH_KEY = 'widget:lastPayloadHash';

async function currentPayloadHash(): Promise<string> {
  const [watchNext, upcoming] = await Promise.all([fetchWatchNextItems(), fetchUpcomingGroups()]);
  return JSON.stringify({ watchNext, upcoming, labels: getWidgetLabels() });
}

async function runUpdate(): Promise<void> {
  lastUpdate = Date.now();
  invalidateWidgetDataCache();
  let hash: string | null = null;
  try {
    hash = await currentPayloadHash();
    const lastHash = await AsyncStorage.getItem(HASH_KEY);
    if (lastHash === hash) return;
  } catch {
    // hashing failed (storage/network) — fall through and render anyway
  }
  await Promise.allSettled([
    requestWidgetUpdate({
      widgetName: WIDGET_KINDS.watchNext,
      renderWidget: (info) => renderWatchNextWidget(info),
    }),
    requestWidgetUpdate({
      widgetName: WIDGET_KINDS.upcoming,
      renderWidget: (info) => renderUpcomingWidget(info),
    }),
  ]);
  if (hash) {
    try {
      await AsyncStorage.setItem(HASH_KEY, hash);
    } catch {
      // best effort
    }
  }
}

async function updateAll(): Promise<void> {
  const elapsed = Date.now() - lastUpdate;
  if (elapsed >= UPDATE_THROTTLE_MS && !trailing) {
    await runUpdate().catch(() => undefined);
    return;
  }
  if (trailing) return; // a trailing update already coalesces this call
  trailing = setTimeout(() => {
    trailing = null;
    void runUpdate().catch(() => undefined);
  }, UPDATE_THROTTLE_MS - elapsed);
}

export async function syncWidgetCredentials(): Promise<void> {
  await updateAll();
}

export async function clearWidgetCredentials(): Promise<void> {
  await updateAll();
}

export async function syncWidgetLabels(): Promise<void> {
  await updateAll();
}

export async function refreshWidgets(): Promise<void> {
  await updateAll();
}
