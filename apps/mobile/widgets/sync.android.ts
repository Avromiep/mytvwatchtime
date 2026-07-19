import { requestWidgetUpdate } from 'react-native-android-widget';
import { WIDGET_KINDS } from './data';
import { renderUpcomingWidget, renderWatchNextWidget } from './android/render';

// Android widgets run in this app's process (headless JS) and read tokens from
// SecureStore themselves, so there is nothing to push — "sync" just re-renders
// every home-screen instance with fresh API data.

async function updateAll(): Promise<void> {
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
}

export async function syncWidgetCredentials(): Promise<void> {
  await updateAll().catch(() => undefined);
}

export async function clearWidgetCredentials(): Promise<void> {
  await updateAll().catch(() => undefined);
}

export async function syncWidgetLabels(): Promise<void> {
  await updateAll().catch(() => undefined);
}

export async function refreshWidgets(): Promise<void> {
  await updateAll().catch(() => undefined);
}
