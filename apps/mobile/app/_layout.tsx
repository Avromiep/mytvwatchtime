import React, { useEffect, useRef } from 'react';
import { Platform, View, ActivityIndicator } from 'react-native';
import '../utils/alert-polyfill'; // Web safety-net: routes residual Alert.alert to themed dialog
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import * as WebBrowser from 'expo-web-browser';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

WebBrowser.maybeCompleteAuthSession();
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from '../context/AuthContext';
import { PreferencesProvider, useAppearance } from '../context/PreferencesProvider';
import { DialogProvider } from '../components/DialogProvider';
import { ToastHost } from '../components/ToastHost';
import { useNotificationNavigation } from '../hooks/useNotificationNavigation';
import { initAnalytics } from '../lib/analytics';
import { isOnboardingDone } from '../lib/onboarding/draft';

if (Platform.OS !== 'web') {
  SplashScreen.preventAutoHideAsync();
  initAnalytics();
}

const queryClient = new QueryClient({
  // refetchOnWindowFocus stays on for native (app-foreground refresh) but off on web:
  // every browser alt-tab refocus would otherwise storm all mounted queries
  // (watchNext, 4× 500-item lists, stats, …) at once.
  defaultOptions: { queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: Platform.OS !== 'web' } },
});

function Gate() {
  const { loading, user } = useAuth();
  const { tokens, resolvedTheme } = useAppearance();
  const segments = useSegments();
  const router = useRouter();
  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;
  const needsPasswordChange = !!user?.mustChangePassword;
  // Server onboarding fields ride on /me; the stored user doubles as the local
  // cache so cold starts don't flicker (hybrid server + device state). Users cached
  // by an older app version lack the fields — treat them as done until /me refreshes
  // rather than flashing onboarding at long-time users.
  const onboardingDone =
    user?.onboardingStatus === undefined
      ? true
      : isOnboardingDone(user?.onboardingStatus, user?.onboardingVersion);

  // Navigate on push-notification tap (whitelisted action or legacy deep link).
  useNotificationNavigation();

  // Register service worker on web (for PWA + push notifications)
  useEffect(() => {
    if (Platform.OS === 'web' && typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }, []);

  useEffect(() => {
    if (loading) return;
    const segs = segmentsRef.current;
    const inAuthGroup = segs[0] === '(auth)';
    if (!user && !inAuthGroup) {
      queryClient.clear();
      router.replace('/(auth)/login');
    } else if (user && needsPasswordChange && segs[1] !== 'change-password') {
      router.replace('/(auth)/change-password');
    } else if (user && !needsPasswordChange && !onboardingDone && (segs[0] as string) !== 'onboarding') {
      // Quick-setup onboarding: exactly once per user/version, right after auth.
      router.replace('/onboarding' as any);
    } else if (user && !needsPasswordChange && onboardingDone && inAuthGroup) {
      router.replace('/(tabs)/shows');
    }
    // Note: onboarding routes are never redirected AWAY from — completed/skipped
    // users may deliberately reopen Quick setup from Settings.
  }, [user, loading, onboardingDone]);

  useEffect(() => {
    if (!loading && Platform.OS !== 'web') SplashScreen.hideAsync();
  }, [loading]);
  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: tokens.background, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={tokens.primary} size="large" />
      </View>
    );
  }
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: tokens.background } }}>
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="onboarding" />
      <Stack.Screen name="show/[id]" options={{ presentation: 'modal' }} />
      <Stack.Screen name="movie/[id]" options={{ presentation: 'modal' }} />
      <Stack.Screen name="episode/[id]" options={{ presentation: 'modal' }} />
      <Stack.Screen name="stats" />
      <Stack.Screen name="notifications" />
      <Stack.Screen name="import" />
      <Stack.Screen name="more" />
      <Stack.Screen name="myshows" />
      <Stack.Screen name="list/[id]" />
      <Stack.Screen name="create-list" />
      <Stack.Screen name="my-lists" />
      <Stack.Screen name="followed-lists" />
      <Stack.Screen name="find-user" />
      <Stack.Screen name="user/[username]" />
      <Stack.Screen name="follows" />
    </Stack>
  );
}

function RootShell() {
  const { resolvedTheme, tokens } = useAppearance();
  return (
    <View style={{ flex: 1, backgroundColor: tokens.background }}>
      <StatusBar style={resolvedTheme === 'dark' ? 'light' : 'dark'} />
      <Gate />
    </View>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <PreferencesProvider>
              <DialogProvider>
                <RootShell />
                <ToastHost />
              </DialogProvider>
            </PreferencesProvider>
          </AuthProvider>
        </QueryClientProvider>
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
}
