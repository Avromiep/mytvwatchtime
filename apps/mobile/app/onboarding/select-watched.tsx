import React from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { TitlePicker } from '../../components/onboarding/TitlePicker';

/**
 * Step 2 — single purpose: pick titles the user has already watched.
 * Continue (or skip) always advances to the watchlist step; the progress step
 * is inserted later only when watched shows exist.
 */
export default function OnboardingSelectWatched() {
  const params = useLocalSearchParams<{ tab?: string }>();
  return (
    <TitlePicker
      mode="WATCHED"
      initialTab={params.tab === 'movies' ? 'movies' : 'shows'}
      onContinue={() => router.push('/onboarding/select-watchlist' as any)}
    />
  );
}
