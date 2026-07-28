import React, { useEffect, useRef } from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ONBOARDING_VERSION } from '@tvwatch/shared';
import { Button, Card, Screen, T } from '../../components/primitives';
import { useConfetti } from '../../components/Confetti';
import { useAuth } from '../../context/AuthContext';
import { useAppearance } from '../../context/PreferencesProvider';
import { useUpdateOnboardingState } from '../../api/hooks';
import { logFirstEvent } from '../../lib/analytics';
import { spacing } from '../../theme/theme';

/**
 * Step 6 — success. Summarizes EVERYTHING that was added (non-zero rows only),
 * in three variants: full success, partial success (some titles failed — the
 * draft was trimmed to exactly those, so "try again" re-applies them), and the
 * import completion state.
 */
export default function OnboardingDone() {
  const { t } = useTranslation(['onboarding', 'common']);
  const { tokens } = useAppearance();
  const { user, refreshUser } = useAuth();
  const update = useUpdateOnboardingState();
  const { confettiEl, fire } = useConfetti();
  const params = useLocalSearchParams<{
    source?: string;
    episodes?: string;
    movies?: string;
    watchlist?: string;
    partial?: string;
    failed?: string;
  }>();

  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    fire();
    if (params.source === 'import') {
      // The import path completes onboarding client-side (the import itself
      // doesn't touch onboarding state server-side).
      update
        .mutateAsync({ status: 'COMPLETED', version: ONBOARDING_VERSION })
        .then(() => refreshUser())
        .then(() => logFirstEvent('onboarding_completed', user?.id))
        .catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const episodes = Number(params.episodes ?? 0);
  const movies = Number(params.movies ?? 0);
  const watchlist = Number(params.watchlist ?? 0);
  const fromImport = params.source === 'import';
  const partial = params.partial === '1';

  const title = fromImport
    ? t('onboarding:importDoneTitle')
    : partial
      ? t('onboarding:partialTitle')
      : t('onboarding:doneTitle');
  const body = fromImport
    ? t('onboarding:importDoneBody')
    : partial
      ? t('onboarding:partialBody')
      : t('onboarding:doneBody');

  return (
    <Screen>
      {confettiEl}
      <View style={{ flex: 1, justifyContent: 'center', padding: spacing.lg, gap: spacing.lg }}>
        <View style={{ alignItems: 'center', gap: spacing.sm }}>
          <Ionicons
            name={partial ? 'alert-circle' : 'checkmark-circle'}
            size={64}
            color={partial ? tokens.warning : tokens.watched}
          />
          <T variant="title" style={{ textAlign: 'center' }}>
            {title}
          </T>
          <T variant="body" muted style={{ textAlign: 'center' }}>
            {body}
          </T>
        </View>

        {!fromImport && (episodes > 0 || movies > 0 || watchlist > 0) ? (
          <Card style={{ gap: spacing.xs }}>
            {episodes > 0 ? (
              <T variant="body">{t('onboarding:doneEpisodes', { count: episodes })}</T>
            ) : null}
            {movies > 0 ? (
              <T variant="body">{t('onboarding:doneMovies', { count: movies })}</T>
            ) : null}
            {watchlist > 0 ? (
              <T variant="body">{t('onboarding:doneWatchlist', { count: watchlist })}</T>
            ) : null}
          </Card>
        ) : null}

        {partial ? (
          <View style={{ gap: spacing.sm }}>
            <Button
              title={t('onboarding:partialRetry')}
              onPress={() => router.replace('/onboarding/review' as any)}
            />
            <Button
              title={t('onboarding:partialContinue')}
              variant="ghost"
              onPress={() => router.replace('/(tabs)/shows')}
            />
          </View>
        ) : (
          <Button title={t('onboarding:doneCta')} onPress={() => router.replace('/(tabs)/shows')} />
        )}
      </View>
    </Screen>
  );
}
