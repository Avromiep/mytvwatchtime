import React from 'react';
import { buildTokens } from '@tvwatch/shared';
import type { WidgetInfo, WidgetRepresentation } from 'react-native-android-widget';
import {
  ensureWidgetLocale,
  fetchUpcomingGroups,
  fetchWatchNextItems,
  getWidgetLabels,
} from '../data';
import { WatchNextWidget } from './WatchNextWidget';
import { UpcomingWidget } from './UpcomingWidget';

/** Renders both theme variants; the OS picks whichever matches the device theme. */
function themed(
  make: (tokens: ReturnType<typeof buildTokens>) => React.JSX.Element,
): WidgetRepresentation {
  return { light: make(buildTokens('light')), dark: make(buildTokens('dark')) };
}

export async function renderWatchNextWidget(info: WidgetInfo): Promise<WidgetRepresentation> {
  await ensureWidgetLocale();
  const state = await fetchWatchNextItems();
  const labels = getWidgetLabels();
  return themed((tokens) => (
    <WatchNextWidget state={state} labels={labels} tokens={tokens} height={info.height} />
  ));
}

export async function renderUpcomingWidget(info: WidgetInfo): Promise<WidgetRepresentation> {
  await ensureWidgetLocale();
  const state = await fetchUpcomingGroups();
  const labels = getWidgetLabels();
  return themed((tokens) => (
    <UpcomingWidget state={state} labels={labels} tokens={tokens} height={info.height} />
  ));
}
