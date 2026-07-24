import { useEffect } from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import type {
  AnnouncementAction,
  AnnouncementActionParams,
  AnnouncementTarget,
} from '@tvwatch/shared';
import { runAnnouncementAction, navigateFromLink } from '../lib/announcement';

// Responses already navigated for. Both the tap listener AND
// getLastNotificationResponseAsync() can deliver the same response (the "last"
// response persists until a newer one arrives), and the app must have exactly ONE
// tap handler (a second listener elsewhere once pushed every route twice).
const handledResponses = new Set<string>();
let lastHandledTarget: { target: string; at: number } | null = null;

function parseActionParams(value: unknown): AnnouncementActionParams | undefined {
  if (!value) return undefined;
  if (typeof value === 'object') return value as AnnouncementActionParams;
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as AnnouncementActionParams) : undefined;
  } catch {
    return undefined;
  }
}

function isDuplicateTarget(target: string) {
  const now = Date.now();
  if (lastHandledTarget?.target === target && now - lastHandledTarget.at < 1500) return true;
  lastHandledTarget = { target, at: now };
  return false;
}

/**
 * Listens for push-notification taps and navigates to the configured action
 * (whitelisted target) or a legacy `link`/deep-link. Registered once at the root —
 * warm taps via the listener, cold starts via the last queued response.
 */
export function useNotificationNavigation() {
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const open = (response: Notifications.NotificationResponse | null, delayMs = 0) => {
      if (!response) return;
      const data = response.notification.request.content.data as
        Record<string, unknown> | undefined;
      if (!data) return;
      const hasAction = !!data.actionTarget && data.actionTarget !== 'none';
      const link = typeof data.link === 'string' ? data.link : null;
      if (!hasAction && !link) return;

      const actionParams = parseActionParams(data.actionParams);
      const target = hasAction
        ? `action:${String(data.actionTarget)}:${JSON.stringify(actionParams ?? {})}`
        : `link:${link}`;
      const key = `${response.notification.request.identifier}:${response.notification.date}:${target}`;
      if (handledResponses.has(key)) return;
      if (isDuplicateTarget(target)) return;
      if (handledResponses.size > 100) handledResponses.clear();
      handledResponses.add(key);

      // Action-driven navigation (announcements + broadcasts).
      if (hasAction) {
        const action: AnnouncementAction = {
          type: (data.actionType as AnnouncementAction['type']) || 'navigate',
          target: data.actionTarget as AnnouncementTarget,
          params: actionParams,
        };
        setTimeout(() => runAnnouncementAction(action), delayMs);
        return;
      }

      // Legacy link / deep-link field.
      setTimeout(() => navigateFromLink(link), delayMs);
    };
    const sub = Notifications.addNotificationResponseReceivedListener(open);
    Notifications.getLastNotificationResponseAsync()
      // Cold-start taps can arrive before Expo Router's initial index redirect
      // finishes; delay just this path so it doesn't get replaced by home.
      .then((response) => open(response, 1200))
      .catch(() => undefined);
    return () => sub.remove();
  }, []);
}
