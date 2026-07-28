import React from 'react';
import { router } from 'expo-router';
import { TitlePicker } from '../../components/onboarding/TitlePicker';
import { needsProgressReview } from '../../lib/onboarding/draft';

/**
 * Step 3 — single purpose: pick titles to come back to later. Watched picks
 * from the previous step are preserved (and shown green, read-only).
 */
export default function OnboardingSelectWatchlist() {
  return (
    <TitlePicker
      mode="WATCHLIST"
      onContinue={(draft) =>
        router.push(
          (needsProgressReview(draft) ? '/onboarding/progress' : '/onboarding/review') as any,
        )
      }
    />
  );
}
