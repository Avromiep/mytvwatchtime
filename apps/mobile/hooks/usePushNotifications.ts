import { useEffect } from 'react';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { api } from '../api/client';
import { showError } from '../lib/dialog';
import { navigateFromLink } from '../lib/announcement';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

export function usePushNotifications(enabled: boolean) {
  useEffect(() => {
    if (!enabled || Platform.OS === 'web') return;
    let cancelled = false;
    (async () => {
      try {
        console.log('[PUSH] Starting push registration...');

        const { status: existing } = await Notifications.getPermissionsAsync();
        console.log('[PUSH] Current permission status:', existing);
        let finalStatus = existing;
        if (existing !== 'granted') {
          const { status } = await Notifications.requestPermissionsAsync();
          console.log('[PUSH] Requested permission, got:', status);
          finalStatus = status;
        }
        if (finalStatus !== 'granted' || cancelled) {
          console.log('[PUSH] Permission not granted, aborting');
          return;
        }

        const projectId =
          (Constants.expoConfig?.extra as any)?.eas?.projectId ||
          (Constants.expoConfig?.extra as any)?.projectId ||
          (Constants.expoConfig as any)?.projectId;

        console.log('[PUSH] projectId:', projectId);
        console.log('[PUSH] expoConfig extra:', JSON.stringify(Constants.expoConfig?.extra || {}));

        let token: string;
        try {
          if (projectId) {
            token = (await Notifications.getExpoPushTokenAsync({ projectId: projectId as any })).data;
          } else {
            token = (await Notifications.getExpoPushTokenAsync()).data;
          }
        } catch (tokenErr: any) {
          console.error('[PUSH] Token generation FAILED:', tokenErr?.message || tokenErr);
          showError({ title: 'Push token failed', description: tokenErr?.message || 'Unknown error' });
          return;
        }

        console.log('[PUSH] Got token:', token.substring(0, 30) + '...');

        const res = await api.post('/devices/register', {
          token,
          platform: Platform.OS === 'ios' ? 'IOS' : 'ANDROID',
        });
        console.log('[PUSH] Device registered:', JSON.stringify(res));

        if (Platform.OS === 'android') {
          await Notifications.setNotificationChannelAsync('default', {
            name: 'default',
            importance: Notifications.AndroidImportance.HIGH,
          });
        }
        console.log('[PUSH] Registration complete!');
      } catch (e: any) {
        console.error('[PUSH] Registration failed:', e?.message || e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  // Tap handling: warm taps via listener, cold start via the last queued response.
  useEffect(() => {
    if (!enabled || Platform.OS === 'web') return;
    const open = (response: Notifications.NotificationResponse | null) => {
      const link = (response?.notification.request.content.data as any)?.link;
      if (typeof link === 'string') navigateFromLink(link);
    };
    const sub = Notifications.addNotificationResponseReceivedListener(open);
    Notifications.getLastNotificationResponseAsync().then(open).catch(() => undefined);
    return () => sub.remove();
  }, [enabled]);
}
