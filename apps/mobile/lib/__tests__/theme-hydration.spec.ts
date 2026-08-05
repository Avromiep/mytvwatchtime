import { resolveHydratedTheme } from '../theme-hydration';

describe('resolveHydratedTheme', () => {
  it('uses the same deterministic theme before web preference hydration', () => {
    expect(resolveHydratedTheme(false, 'dark', 'dark')).toBe('light');
    expect(resolveHydratedTheme(false, 'system', 'dark')).toBe('light');
  });

  it('applies the saved preference after hydration', () => {
    expect(resolveHydratedTheme(true, 'dark', 'light')).toBe('dark');
    expect(resolveHydratedTheme(true, 'system', 'dark')).toBe('dark');
  });
});
