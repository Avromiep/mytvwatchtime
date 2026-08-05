jest.mock('react-native', () => ({
  Platform: { OS: 'web' },
  useWindowDimensions: () => ({ width: 1440, height: 900 }),
}));

import { getContentWidth, WEB_PORTRAIT_MAX_WIDTH } from './useContentWidth';

describe('getContentWidth', () => {
  it('caps desktop web measurements to the portrait shell', () => {
    expect(getContentWidth(1440, true)).toBe(WEB_PORTRAIT_MAX_WIDTH);
  });

  it('keeps narrow web and native measurements unchanged', () => {
    expect(getContentWidth(390, true)).toBe(390);
    expect(getContentWidth(1024, false)).toBe(1024);
  });
});
