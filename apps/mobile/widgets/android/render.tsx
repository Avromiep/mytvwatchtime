import React from 'react';
import { buildTokens } from '@tvwatch/shared';
import type { WidgetInfo, WidgetRepresentation } from 'react-native-android-widget';
import {
  cacheWidgetImages,
  ensureWidgetLocale,
  fetchUpcomingGroups,
  fetchWatchNextItems,
  getWidgetLabels,
  widgetImage,
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
  const images = await cacheWidgetImages(
    state.status === 'ok'
      ? state.data.map((item) => widgetImage(item.episode.stillUrl ?? item.backdropUrl, 'w300'))
      : [],
  );
  const labels = getWidgetLabels();
  return themed((tokens) => (
    <WatchNextWidget
      state={state}
      labels={labels}
      tokens={tokens}
      height={info.height}
      images={images}
    />
  ));
}

export async function renderUpcomingWidget(info: WidgetInfo): Promise<WidgetRepresentation> {
  await ensureWidgetLocale();
  const state = await fetchUpcomingGroups();
  const images = await cacheWidgetImages(
    state.status === 'ok'
      ? state.data.flatMap((group) =>
          group.items.map((item) => widgetImage(item.posterUrl, 'w185')),
        )
      : [],
  );
  const labels = getWidgetLabels();
  return themed((tokens) => (
    <UpcomingWidget
      state={state}
      labels={labels}
      tokens={tokens}
      height={info.height}
      images={images}
    />
  ));
}
