import { router } from 'expo-router';
import { Linking } from 'react-native';
import {
  announcementActionToRoute,
  isExternalAction,
  type AnnouncementAction,
  type LocaleText,
} from '@tvwatch/shared';

/** Pick a locale's text, falling back to English, then to the first available value. */
export function pickLocale(map: LocaleText | null | undefined, lang: string): string {
  if (!map) return '';
  if (typeof map[lang] === 'string' && map[lang].trim() !== '') return map[lang];
  if (typeof map.en === 'string' && map.en.trim() !== '') return map.en;
  const first = Object.values(map).find((v) => typeof v === 'string' && v.trim() !== '');
  return first ?? '';
}

/** Resolve a whitelisted announcement/broadcast action to a navigation. */
export function runAnnouncementAction(action: AnnouncementAction | null | undefined) {
  const route = announcementActionToRoute(action);
  if (!route) return;
  if (isExternalAction(action)) {
    Linking.openURL(route).catch(() => undefined);
    return;
  }
  router.push(route as any);
}

/** Map a stored notification `link` / deep-link string to a route and navigate.
 *  Supports the legacy `tvwatchtime://...` scheme plus plain route paths.
 *  Query strings (`?highlight=...`, `?scroll=...`) are preserved onto the route. */
export function navigateFromLink(link: string | null | undefined) {
  if (!link) return;
  let route = link;
  if (link.startsWith('tvwatchtime://')) {
    const path = link.slice('tvwatchtime://'.length);
    const qIndex = path.indexOf('?');
    const pathname = qIndex >= 0 ? path.slice(0, qIndex) : path;
    const query = qIndex >= 0 ? path.slice(qIndex) : '';
    const [seg, id] = pathname.split('/');
    if (seg === 'episode' && id) route = `/episode/${id}${query}`;
    else if (seg === 'show' && id) route = `/show/${id}${query}`;
    else if (seg === 'list' && id) route = `/list/${id}${query}`;
    else if (seg === 'movie' && id) route = `/movie/${id}${query}`;
    else if (seg === 'comment' && id) route = `/comment/${id}${query}`;
    else if (seg === 'user' && id) route = `/user/${encodeURIComponent(id)}${query}`;
    else if (seg === 'contact') route = id ? `/contact/${id}${query}` : '/contact';
    else if (seg === 'stats') route = `/stats${query}`;
    else return;
  }
  if (route.startsWith('http://') || route.startsWith('https://')) {
    Linking.openURL(route).catch(() => undefined);
    return;
  }
  router.push(route as any);
}
