import {
  resolveTheme,
  type ResolvedTheme,
  type ThemePreference,
} from '@tvwatch/shared';

/**
 * Static web rendering cannot read browser storage or media queries. Keep the
 * server and the browser's first hydration render identical, then apply the
 * real preference once local storage is available.
 */
export function resolveHydratedTheme(
  preferencesLoaded: boolean,
  preference: ThemePreference,
  systemScheme: 'light' | 'dark' | null | undefined,
): ResolvedTheme {
  return preferencesLoaded ? resolveTheme(preference, systemScheme) : 'light';
}
