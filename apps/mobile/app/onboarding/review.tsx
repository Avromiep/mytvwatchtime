import React from 'react';
import { ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Header } from '../../components/Header';
import { Button, Card, Screen, T } from '../../components/primitives';
import { useApplyOnboarding } from '../../api/hooks';
import { useAuth } from '../../context/AuthContext';
import { useAppearance } from '../../context/PreferencesProvider';
import { useOnboardingDraft } from '../../lib/onboarding/useOnboardingDraft';
import { buildApplyPayload, selectionCounts } from '../../lib/onboarding/draft';
import { logFirstEvent } from '../../lib/analytics';
import { showError } from '../../lib/dialog';
import { spacing } from '../../theme/theme';

export default function OnboardingReview() {
  const { t } = useTranslation(['onboarding', 'common']);
  const { tokens } = useAppearance();
  const { user, refreshUser } = useAuth();
  const { draft, ready, clear } = useOnboardingDraft(user?.id);
  const apply = useApplyOnboarding();

  const counts = selectionCounts(draft);
  const watchlistTotal = counts.showsWatchlisted + counts.moviesWatchlisted;
  // Server-side batch limit (ApplyOnboardingDto @ArrayMaxSize): block with a
  // clear message instead of letting the request 400.
  const tooMany =
    Object.keys(draft.shows).length > 100 || Object.keys(draft.movies).length > 100;

  const onConfirm = async () => {
    try {
      const result = await apply.mutateAsync(buildApplyPayload(draft));
      clear();
      await refreshUser(); // server marked onboarding COMPLETED — lets the Gate through
      logFirstEvent('onboarding_completed', user?.id);
      router.replace({
        pathname: '/onboarding/done' as any,
        params: {
          source: 'quick-setup',
          shows: String(result.applied.showsProcessed),
          episodes: String(result.applied.episodesMarked),
          movies: String(result.applied.moviesWatched),
          watchlist: String(result.applied.watchlistAdded),
          unresolved: String(result.unresolved.length),
        },
      });
    } catch (e: any) {
      // Apply is idempotent — retrying the same payload converges.
      showError({ description: e?.message ?? t('onboarding:applyFailed') });
    }
  };

  const onRestart = () => {
    clear();
    router.replace('/onboarding/select' as any);
  };

  return (
    <Screen>
      <Header title={t('onboarding:reviewTitle')} showBack />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
        <T variant="body" muted>
          {t('onboarding:reviewDesc')}
        </T>
        <Card style={{ gap: spacing.sm }}>
          <SummaryRow label={t('onboarding:summaryShowsWatched')} value={counts.showsWatched} color={tokens.watched} />
          <SummaryRow label={t('onboarding:summaryMoviesWatched')} value={counts.moviesWatched} color={tokens.watched} />
          <SummaryRow label={t('onboarding:summaryWatchlist')} value={watchlistTotal} color={tokens.warning} />
          <T variant="micro" muted style={{ marginTop: spacing.xs }}>
            {t('onboarding:summaryNote')}
          </T>
        </Card>
        <Button
          title={t('onboarding:confirmApply', { count: counts.total })}
          loading={apply.isPending}
          disabled={!ready || counts.total === 0 || tooMany}
          onPress={onConfirm}
        />
        {tooMany ? (
          <T variant="caption" style={{ color: tokens.danger, textAlign: 'center' }}>
            {t('onboarding:tooMany')}
          </T>
        ) : null}
        <Button title={t('onboarding:restart')} variant="ghost" onPress={onRestart} />
      </ScrollView>
    </Screen>
  );
}

function SummaryRow({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
      <T variant="body">{label}</T>
      <T variant="h2" style={{ color }}>
        {value}
      </T>
    </View>
  );
}
