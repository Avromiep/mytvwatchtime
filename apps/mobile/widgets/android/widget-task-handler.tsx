import type { WidgetTaskHandlerProps } from 'react-native-android-widget';
import { WIDGET_KINDS, invalidateWidgetDataCache } from '../data';
import { renderUpcomingWidget, renderWatchNextWidget } from './render';

/** Headless entry: the OS invokes this for widget lifecycle + refresh clicks.
 *  OPEN_URI clicks (episode rows, headers) never reach JS — they deep-link straight
 *  into the app via intent. */
export async function widgetTaskHandler(props: WidgetTaskHandlerProps): Promise<void> {
  const render =
    props.widgetInfo.widgetName === WIDGET_KINDS.upcoming
      ? renderUpcomingWidget
      : renderWatchNextWidget;

  switch (props.widgetAction) {
    case 'WIDGET_ADDED':
    case 'WIDGET_UPDATE':
    case 'WIDGET_RESIZED':
      props.renderWidget(await render(props.widgetInfo));
      break;
    case 'WIDGET_CLICK':
      // Manual refresh (header ↻): bypass the 30s memoized data cache.
      if (props.clickAction === 'REFRESH') {
        invalidateWidgetDataCache();
        props.renderWidget(await render(props.widgetInfo));
      }
      break;
    case 'WIDGET_DELETED':
    default:
      break;
  }
}
