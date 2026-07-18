import { navigateFromLink } from '../announcement';
import { router } from 'expo-router';
import { Linking } from 'react-native';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('react-native', () => ({
  Linking: { openURL: jest.fn().mockResolvedValue(undefined) },
}));

describe('navigateFromLink', () => {
  beforeEach(() => jest.clearAllMocks());

  it('ignores empty links', () => {
    navigateFromLink(null);
    navigateFromLink(undefined);
    navigateFromLink('');
    expect(router.push).not.toHaveBeenCalled();
  });

  it.each([
    ['tvwatchtime://episode/e1', '/episode/e1'],
    ['tvwatchtime://show/m1', '/show/m1'],
    ['tvwatchtime://movie/m2', '/movie/m2'],
    ['tvwatchtime://list/l1', '/list/l1'],
    ['tvwatchtime://comment/c1', '/comment/c1'],
    ['tvwatchtime://comment/c1?highlight=c1', '/comment/c1?highlight=c1'],
    ['tvwatchtime://contact', '/contact'],
    ['tvwatchtime://contact/t1', '/contact/t1'],
    ['tvwatchtime://stats?scroll=badges', '/stats?scroll=badges'],
    ['tvwatchtime://user/alice', '/user/alice'],
  ])('maps %s -> %s', (link, route) => {
    navigateFromLink(link);
    expect(router.push).toHaveBeenCalledWith(route);
  });

  it('opens external URLs instead of routing', () => {
    navigateFromLink('https://example.com/x');
    expect(Linking.openURL).toHaveBeenCalledWith('https://example.com/x');
    expect(router.push).not.toHaveBeenCalled();
  });

  it('ignores unknown scheme segments', () => {
    navigateFromLink('tvwatchtime://unknown/x');
    expect(router.push).not.toHaveBeenCalled();
  });

  it('passes plain route paths through', () => {
    navigateFromLink('/settings');
    expect(router.push).toHaveBeenCalledWith('/settings');
  });
});
