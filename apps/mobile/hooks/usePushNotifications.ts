import { useEffect } from 'react';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { api } from '../api/client';
import { showError } from '../lib/dialog';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

/**
 * Push REGISTRATION only (permissions + token + device upsert). Notification TAP
 * handling lives exclusively in useNotificationNavigation (app root) — a second
 * response listener here pushed every tapped route twice.
 */
export function usePushNotifications(enabled: boolean) {
  useEffect(() => {
    if (!enabled || Platform.OS === 'web') return;
    let cancelled = false;
    (async () => {
      try {
        if (__DEV__) console.log('[PUSH] Starting push registration...');

        const { status: existing } = await Notifications.getPermissionsAsync();
        if (__DEV__) console.log('[PUSH] Current permission status:', existing);
        let finalStatus = existing;
        if (existing !== 'granted') {
          const { status } = await Notifications.requestPermissionsAsync();
          if (__DEV__) console.log('[PUSH] Requested permission, got:', status);
          finalStatus = status;
        }
        if (finalStatus !== 'granted' || cancelled) {
          if (__DEV__) console.log('[PUSH] Permission not granted, aborting');
          return;
        }

        const projectId =
          (Constants.expoConfig?.extra as any)?.eas?.projectId ||
          (Constants.expoConfig?.extra as any)?.projectId ||
          (Constants.expoConfig as any)?.projectId;

        if (__DEV__) console.log('[PUSH] projectId:', projectId);

        let token: string;
        try {
          if (projectId) {
            token = (await Notifications.getExpoPushTokenAsync({ projectId: projectId as any }))
              .data;
          } else {
            token = (await Notifications.getExpoPushTokenAsync()).data;
          }
        } catch (tokenErr: any) {
          if (__DEV__) console.error('[PUSH] Token generation FAILED:', tokenErr?.message || tokenErr);
          showError({
            title: 'Push token failed',
            description: tokenErr?.message || 'Unknown error',
          });
          return;
        }

        if (__DEV__) console.log('[PUSH] Got token:', token.substring(0, 30) + '...');

        const res = await api.post('/devices/register', {
          token,
          platform: Platform.OS === 'ios' ? 'IOS' : 'ANDROID',
          // Device timezone drives per-user notification scheduling server-side.
          // Re-registered on every app start, so tz changes and pre-tz users backfill.
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
        if (__DEV__) console.log('[PUSH] Device registered:', JSON.stringify(res));

        if (Platform.OS === 'android') {
          await Notifications.setNotificationChannelAsync('default', {
            name: 'default',
            importance: Notifications.AndroidImportance.HIGH,
          });
        }
        if (__DEV__) console.log('[PUSH] Registration complete!');
      } catch (e: any) {
        if (__DEV__) console.error('[PUSH] Registration failed:', e?.message || e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);
}
