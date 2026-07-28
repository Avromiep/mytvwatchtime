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
import { logEvent, logFirstEvent } from '../../lib/analytics';
import { spacing } from '../../theme/theme';

export default function OnboardingDone() {
  const { t } = useTranslation(['onboarding', 'common']);
  const { tokens } = useAppearance();
  const { user, refreshUser } = useAuth();
  const update = useUpdateOnboardingState();
  const { confettiEl, fire } = useConfetti();
  const params = useLocalSearchParams<{
    source?: string;
    shows?: string;
    episodes?: string;
    movies?: string;
    watchlist?: string;
    unresolved?: string;
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
        .then(() => {
          logFirstEvent('onboarding_completed', user?.id);
          logEvent('onboarding_import_completed');
        })
        .catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const episodes = Number(params.episodes ?? 0);
  const movies = Number(params.movies ?? 0);
  const watchlist = Number(params.watchlist ?? 0);
  const unresolved = Number(params.unresolved ?? 0);
  const fromImport = params.source === 'import';

  return (
    <Screen>
      {confettiEl}
      <View style={{ flex: 1, justifyContent: 'center', padding: spacing.lg, gap: spacing.lg }}>
        <View style={{ alignItems: 'center', gap: spacing.sm }}>
          <Ionicons name="checkmark-circle" size={64} color={tokens.watched} />
          <T variant="title" style={{ textAlign: 'center' }}>
            {t('onboarding:doneTitle')}
          </T>
          <T variant="body" muted style={{ textAlign: 'center' }}>
            {t('onboarding:doneDesc')}
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
            {unresolved > 0 ? (
              <T variant="caption" muted>
                {t('onboarding:doneUnresolved', { count: unresolved })}
              </T>
            ) : null}
          </Card>
        ) : null}
        <Button
          title={t('onboarding:doneCta')}
          onPress={() => router.replace('/(tabs)/shows')}
        />
      </View>
    </Screen>
  );
}
