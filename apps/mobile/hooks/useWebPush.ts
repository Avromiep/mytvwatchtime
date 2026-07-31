import { useEffect } from 'react';
import { Platform } from 'react-native';
import { api } from '../api/client';

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** atob fallback for runtimes without it (Buffer is not available in Hermes/web). */
function decodeBase64(base64: string): string {
  let out = '';
  let bits = 0;
  let acc = 0;
  for (const ch of base64) {
    const v = B64_CHARS.indexOf(ch);
    if (v < 0) continue; // padding
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((acc >> bits) & 0xff);
    }
  }
  return out;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = typeof atob !== 'undefined' ? atob(base64) : decodeBase64(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

/** Uint8Array → unpadded base64url, for comparing against the server's VAPID key. */
function uint8ToUrlBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; ++i) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function useWebPush(enabled: boolean) {
  useEffect(() => {
    if (Platform.OS !== 'web' || !enabled) return;
    if (
      typeof window === 'undefined' ||
      !('serviceWorker' in navigator) ||
      !('PushManager' in window)
    )
      return;

    let subscribed = false;

    (async () => {
      try {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') return;

        const reg = await navigator.serviceWorker.ready;
        const flags = await api.get<Record<string, any>>('/feature-flags');
        const publicKey = flags.vapid_public_key;
        if (!publicKey) return;

        let subscription = await reg.pushManager.getSubscription();
        // Self-heal after a VAPID key rotation: a PushSubscription is bound to the
        // applicationServerKey it was created with. If the server's current key
        // differs, every send 401s forever — drop the stale subscription and
        // resubscribe with the current key. (options.applicationServerKey is null
        // in older browsers — nothing to compare, keep the subscription.)
        if (subscription) {
          const boundKey = subscription.options?.applicationServerKey;
          if (
            boundKey &&
            uint8ToUrlBase64(new Uint8Array(boundKey)) !== publicKey.replace(/=+$/, '')
          ) {
            await subscription.unsubscribe().catch(() => false);
            subscription = null;
          }
        }
        if (!subscription) {
          subscription = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicKey),
          });
        }

        // Register (or refresh) with the server on EVERY app start — the upsert carries
        // the device timezone used for per-user notification scheduling. Returning early
        // for existing subscriptions left pre-tz devices with tz=NULL forever (no backfill).
        const sub = subscription.toJSON();
        await api.post('/devices/register', {
          token: subscription.endpoint,
          platform: 'web',
          pushEndpoint: subscription.endpoint,
          pushP256dh: sub.keys?.p256dh,
          pushAuth: sub.keys?.auth,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
        subscribed = true;
      } catch (e) {
        // Push not available or denied — silently skip
      }
    })();

    return () => {
      subscribed = false;
    };
  }, [enabled]);
}
