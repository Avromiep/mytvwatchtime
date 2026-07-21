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

/**
 * Listens for push-notification taps and navigates to the configured action
 * (whitelisted target) or a legacy `link`/deep-link. Registered once at the root —
 * warm taps via the listener, cold starts via the last queued response.
 */
export function useNotificationNavigation() {
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const open = (response: Notifications.NotificationResponse | null) => {
      if (!response) return;
      const data = response.notification.request.content.data as
        Record<string, unknown> | undefined;
      if (!data) return;
      const hasAction = !!data.actionTarget && data.actionTarget !== 'none';
      const link = typeof data.link === 'string' ? data.link : null;
      if (!hasAction && !link) return;
      const key = `${response.notification.request.identifier}:${response.notification.date}:${
        hasAction ? `action:${String(data.actionTarget)}` : link
      }`;
      if (handledResponses.has(key)) return;
      if (handledResponses.size > 100) handledResponses.clear();
      handledResponses.add(key);

      // Action-driven navigation (announcements + broadcasts).
      if (hasAction) {
        const action: AnnouncementAction = {
          type: (data.actionType as AnnouncementAction['type']) || 'navigate',
          target: data.actionTarget as AnnouncementTarget,
          params: data.actionParams as AnnouncementActionParams | undefined,
        };
        runAnnouncementAction(action);
        return;
      }

      // Legacy link / deep-link field.
      navigateFromLink(link);
    };
    const sub = Notifications.addNotificationResponseReceivedListener(open);
    Notifications.getLastNotificationResponseAsync()
      .then(open)
      .catch(() => undefined);
    return () => sub.remove();
  }, []);
}
