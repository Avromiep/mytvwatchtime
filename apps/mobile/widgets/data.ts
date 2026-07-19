import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  UPCOMING_NEAR_TERM_BUCKETS,
  WatchNextBucket,
  type UpcomingGroupDto,
  type WatchNextItemDto,
  type WatchNextResponseDto,
} from '@tvwatch/shared';
import { api } from '../api/client';
import i18n, { detectResolvedLocale, loadLocale } from '../i18n';

/** Widget kinds shared by Android (plugin widget names) and iOS (WidgetKit kind strings). */
export const WIDGET_KINDS = { watchNext: 'WatchNext', upcoming: 'Upcoming' } as const;

/** Localized strings rendered inside the widgets (headers + empty/sign-in states). */
export interface WidgetLabels {
  watchNext: string;
  upcoming: string;
  today: string;
  tomorrow: string;
  thisWeek: string;
  emptyWatchNext: string;
  emptyUpcoming: string;
  signIn: string;
}

const LANG_KEY = 'pref:lang';

/** Load the user's stored locale into i18n when running headless (widget task) where
 *  PreferencesProvider never mounted. No-op when the locale is already active. */
export async function ensureWidgetLocale(): Promise<void> {
  try {
    const pref = await AsyncStorage.getItem(LANG_KEY);
    const resolved = detectResolvedLocale((pref as any) ?? 'system');
    if (i18n.language !== resolved) await loadLocale(resolved);
  } catch {
    // keep current language
  }
}

export function getWidgetLabels(): WidgetLabels {
  return {
    watchNext: i18n.t('shows:watchNext'),
    upcoming: i18n.t('shows:upcoming'),
    today: i18n.t('shows:today'),
    tomorrow: i18n.t('shows:tomorrow'),
    thisWeek: i18n.t('shows:thisWeek'),
    emptyWatchNext: i18n.t('shows:empty.watchlistTitle'),
    emptyUpcoming: i18n.t('shows:empty.upcomingTitle'),
    signIn: i18n.t('auth:login'),
  };
}

/** Map a server upcoming bucket to its localized header (TODAY/TOMORROW/THIS_WEEK only). */
export function upcomingGroupTitle(key: string, labels: WidgetLabels, fallback: string): string {
  if (key === 'TODAY') return labels.today;
  if (key === 'TOMORROW') return labels.tomorrow;
  if (key === 'THIS_WEEK') return labels.thisWeek;
  return fallback;
}

export type WidgetFetchState<T> =
  | { status: 'ok'; data: T }
  | { status: 'auth' }
  | { status: 'error' };

// Widget renders happen once per home-screen instance and headless fetches have no
// natural timeout — bound every request and memoize results briefly so N widget
// instances rendered in the same update round share ONE network call.
const WIDGET_FETCH_TIMEOUT_MS = 15000;
const WIDGET_CACHE_TTL_MS = 30000;

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('widget fetch timeout')), WIDGET_FETCH_TIMEOUT_MS),
    ),
  ]);
}

function toState<T>(fn: () => Promise<T>): Promise<WidgetFetchState<T>> {
  return withTimeout(fn())
    .then((data): WidgetFetchState<T> => ({ status: 'ok', data }))
    .catch((e: any): WidgetFetchState<T> => {
      if (e?.status === 401) return { status: 'auth' };
      return { status: 'error' };
    });
}

const resultCache = new Map<string, { at: number; value: WidgetFetchState<any> }>();

function cached<T>(key: string, fn: () => Promise<WidgetFetchState<T>>): Promise<WidgetFetchState<T>> {
  const hit = resultCache.get(key);
  if (hit && Date.now() - hit.at < WIDGET_CACHE_TTL_MS) return Promise.resolve(hit.value);
  return fn().then((value) => {
    resultCache.set(key, { at: Date.now(), value });
    return value;
  });
}

/** Drop memoized results (login/logout/credential changes must re-render from the network). */
export function invalidateWidgetDataCache(): void {
  resultCache.clear();
}

/** Watch Next widget data: strictly the WATCH_NEXT bucket, deduped by episode id
 *  (mirrors the app's Shows tab dedupe). */
export async function fetchWatchNextItems(): Promise<WidgetFetchState<WatchNextItemDto[]>> {
  await ensureWidgetLocale();
  return cached('watchNext', () =>
    toState(async () => {
      const res = await api.get<WatchNextResponseDto>('/me/watch-next');
      const seen = new Set<string>();
      return (res.items ?? []).filter((it) => {
        if (it.bucket !== WatchNextBucket.WATCH_NEXT) return false;
        const k = it.episode?.id;
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }),
  );
}

/** Upcoming widget data: only the near-term groups (Today / Tomorrow / This week). */
export async function fetchUpcomingGroups(): Promise<WidgetFetchState<UpcomingGroupDto[]>> {
  await ensureWidgetLocale();
  return cached('upcoming', () =>
    toState(async () => {
      const res = await api.get<{ groups: UpcomingGroupDto[] }>('/me/upcoming');
      const wanted = new Set<string>(UPCOMING_NEAR_TERM_BUCKETS);
      return (res.groups ?? []).filter((g) => wanted.has(g.key) && g.items?.length);
    }),
  );
}

export function pad2(n?: number | null): string {
  return String(n ?? 0).padStart(2, '0');
}

/** "S02 E05" episode code. */
export function episodeCode(season?: number | null, episode?: number | null, separator = ' '): string {
  return `S${pad2(season)}${separator}E${pad2(episode)}`;
}

/** "Tue, Jul 21" using the device locale. */
export function shortAirDate(airDate: string): string {
  const d = new Date(airDate);
  if (isNaN(d.getTime())) return airDate;
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export const EPISODE_URI = (episodeId: string) => `tvwatchtime://episode/${episodeId}`;
export const SHOWS_URI = 'tvwatchtime://shows';

/** Rewrite a TMDB image URL to a smaller variant for widget rendering (the widget
 *  library downloads every remote bitmap uncached). Non-TMDB URLs pass through. */
export function widgetImage(url: string | null | undefined, size: 'w185' | 'w300'): string | undefined {
  if (!url) return undefined;
  return url.replace(/\/t\/p\/(?:w\d+|original)\//, `/t/p/${size}/`);
}
