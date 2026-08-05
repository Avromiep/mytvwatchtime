import { Platform, useWindowDimensions } from 'react-native';

/** The web app deliberately renders as a centered portrait experience. */
export const WEB_PORTRAIT_MAX_WIDTH = 720;

export function getContentWidth(viewportWidth: number, isWeb = Platform.OS === 'web'): number {
  return isWeb ? Math.min(viewportWidth, WEB_PORTRAIT_MAX_WIDTH) : viewportWidth;
}

/**
 * Width available to screens inside the app shell. On web, the browser viewport
 * can be much wider than the centered portrait frame, so grid math must use the
 * frame width instead of the browser width.
 */
export function useContentWidth(): number {
  const { width } = useWindowDimensions();
  return getContentWidth(width);
}
