import { useEffect } from 'react';
import { Redirect, Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as WebBrowser from 'expo-web-browser';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { useAppearance } from '../../context/PreferencesProvider';
import { usePushNotifications } from '../../hooks/usePushNotifications';
import { useWebPush } from '../../hooks/useWebPush';
import { tokenStorage } from '../../api/storage';
import { showDialog } from '../../lib/dialog';
import { isOnboardingDone } from '../../lib/onboarding/draft';

const DISCORD_URL = 'https://discord.gg/g9JBPUeqQV';
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
// One popup per app session, no matter how often the effect re-runs (user object
// changes several times during boot/onboarding, and each run used to schedule its
// own 3s timer — the "close it 3 times" bug).
let discordPopupScheduled = false;

export default function TabsLayout() {
  const { user } = useAuth();
  const { t } = useTranslation(['navigation', 'common']);
  const { tokens } = useAppearance();
  const insets = useSafeAreaInsets();
  usePushNotifications(!!user);
  // Web push registration lives in its own hook (native skips web, web skips native).
  // Registers on every app start so the device timezone backfills for pre-tz devices.
  useWebPush(!!user);

  // Keep the tab bar clear of the Android system navigation/gesture bar: extend the
  // bar by the bottom safe-area inset and pad its content up above it. Fall back to
  // the original 6px breathing room when there is no system bar (inset == 0).
  const safeBottom = Math.max(insets.bottom, 6);

  useEffect(() => {
    if (!user) return;
    // Never compete with the quick-setup onboarding: a user who hasn't finished
    // (or skipped) it should see onboarding first, not a Discord prompt.
    if (!isOnboardingDone(user.onboardingStatus, user.onboardingVersion)) return;
    if (discordPopupScheduled) return;
    // Claim the slot synchronously — concurrent effect runs would both pass the
    // async storage checks below before either scheduled its timer.
    discordPopupScheduled = true;

    // Periodic Discord popup (the old first-time import popup was replaced by the
    // quick-setup onboarding flow).
    (async () => {
      const neverShow = await tokenStorage.getDiscordNeverShow();
      const lastShown = await tokenStorage.getDiscordLastShown();
      const now = Date.now();
      if (neverShow || (lastShown && now - lastShown < THREE_DAYS_MS)) {
        discordPopupScheduled = false; // not due — a later eligible run may schedule
        return;
      }

      setTimeout(async () => {
        await tokenStorage.setDiscordLastShown(Date.now());
        showDialog({
          title: t('common:discordTitle'),
          description: t('common:discordDesc'),
          buttons: [
            {
              label: t('common:never'),
              variant: 'danger',
              onPress: () => tokenStorage.setDiscordNeverShow(),
            },
            { label: t('common:later'), variant: 'secondary' },
            {
              label: t('common:join'),
              variant: 'primary',
              onPress: () => WebBrowser.openBrowserAsync(DISCORD_URL),
            },
          ],
        });
      }, 3000);
    })();
  }, [user, t]);

  if (!user) return <Redirect href="/(auth)/login" />;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: tokens.tabBarBackground,
          borderTopColor: tokens.border,
          height: 54 + safeBottom,
          paddingBottom: safeBottom,
        },
        tabBarActiveTintColor: tokens.primary,
        tabBarInactiveTintColor: tokens.textMuted,
        tabBarLabelStyle: { fontSize: 11, fontWeight: '700' },
      }}
    >
      <Tabs.Screen
        name="shows"
        options={{
          title: t('navigation:tabs.shows'),
          tabBarIcon: ({ color }) => <Ionicons name="tv" size={24} color={color} />,
        }}
      />
      <Tabs.Screen
        name="movies"
        options={{
          title: t('navigation:tabs.movies'),
          tabBarIcon: ({ color }) => <Ionicons name="film" size={24} color={color} />,
        }}
      />
      <Tabs.Screen
        name="explore"
        options={{
          title: t('navigation:tabs.explore'),
          tabBarIcon: ({ color }) => <Ionicons name="compass" size={24} color={color} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: t('navigation:tabs.profile'),
          tabBarIcon: ({ color }) => <Ionicons name="person" size={24} color={color} />,
        }}
      />
    </Tabs>
  );
}
