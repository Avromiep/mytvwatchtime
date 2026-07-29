import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Header } from '../../components/Header';
import { Button, Card, PosterImage, Screen, T, EmptyState } from '../../components/primitives';
import { useApplyOnboarding } from '../../api/hooks';
import { useAuth } from '../../context/AuthContext';
import { useAppearance } from '../../context/PreferencesProvider';
import { useOnboardingDraft } from '../../lib/onboarding/useOnboardingDraft';
import { useSkipSetup } from '../../lib/onboarding/useSkipSetup';
import {
  DraftMeta,
  DraftShow,
  buildApplyPayload,
  draftReducer,
  expectedEpisodes,
  selectionCounts,
} from '../../lib/onboarding/draft';
import { logEvent, logFirstEvent } from '../../lib/analytics';
import { showDialog } from '../../lib/dialog';
import { radius, spacing } from '../../theme/theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * Step 5 — review. Shows the ACTUAL selected titles (not just totals), computes
 * expected episode counts from metadata recorded during the progress step, and
 * applies everything in ONE batch request. Failures never lose the draft:
 * total failure keeps it untouched; partial failure trims it to the failed
 * titles so "try again" re-applies exactly those.
 */
export default function OnboardingReview() {
  const { t } = useTranslation(['onboarding', 'common']);
  const { tokens } = useAppearance();
  const insets = useSafeAreaInsets();
  const { user, refreshUser } = useAuth();
  const { draft, ready, act, clear, flush } = useOnboardingDraft(user?.id);
  const { skip } = useSkipSetup();
  const apply = useApplyOnboarding();
  const [applyFailed, setApplyFailed] = useState(false);
  const applyingRef = useRef(false);

  useEffect(() => {
    if (ready) logEvent('onboarding_review_viewed');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const counts = selectionCounts(draft);
  const episodes = expectedEpisodes(draft);
  const watchlistTotal = counts.showsWatchlisted + counts.moviesWatchlisted;
  // Server-side batch limit (ApplyOnboardingDto @ArrayMaxSize): block with a
  // clear message instead of letting the request 400.
  const tooMany =
    Object.keys(draft.shows).length > 100 || Object.keys(draft.movies).length > 100;

  const watchedShows = Object.entries(draft.shows)
    .filter(([, s]) => s.action !== 'WATCHLIST')
    .map(([id, s]) => ({ id, show: s, meta: draft.meta[id] }));
  const watchedMovies = Object.entries(draft.movies)
    .filter(([, m]) => m.action === 'WATCHED')
    .map(([id]) => ({ id, meta: draft.meta[id] }));
  const watchlistItems = [
    ...Object.entries(draft.shows)
      .filter(([, s]) => s.action === 'WATCHLIST')
      .map(([id]) => ({ id, meta: draft.meta[id] })),
    ...Object.entries(draft.movies)
      .filter(([, m]) => m.action === 'WATCHLIST')
      .map(([id]) => ({ id, meta: draft.meta[id] })),
  ];

  const onConfirm = async () => {
    if (applyingRef.current) return; // no duplicate submissions
    applyingRef.current = true;
    setApplyFailed(false);
    logEvent('onboarding_apply_started');
    try {
      const result = await apply.mutateAsync(buildApplyPayload(draft));
      await refreshUser(); // server marked onboarding COMPLETED — lets the Gate through
      const params: Record<string, string> = {
        source: 'quick-setup',
        episodes: String(result.applied.episodesMarked),
        movies: String(result.applied.moviesWatched),
        watchlist: String(result.applied.watchlistAdded),
      };
      if (result.unresolved.length === 0) {
        clear(); // removes the stored draft synchronously
        logFirstEvent('onboarding_completed', user?.id);
      } else {
        // Partial success: keep ONLY the failed titles so a retry converges.
        // Dispatch is async — persist the trimmed draft explicitly so the next
        // mounted screen hydrates the trimmed version.
        logEvent('onboarding_failed');
        const ids = result.unresolved.map((u) => u.mediaId);
        act({ type: 'keepOnly', ids });
        flush(draftReducer(draft, { type: 'keepOnly', ids }));
        params.partial = '1';
        params.failed = String(result.unresolved.length);
      }
      router.replace({ pathname: '/onboarding/done' as any, params });
    } catch {
      logEvent('onboarding_failed');
      setApplyFailed(true); // draft untouched — everything is still here
    } finally {
      applyingRef.current = false;
    }
  };

  const onClearAll = () => {
    showDialog({
      title: t('onboarding:clearConfirmTitle'),
      description: t('onboarding:clearConfirmBody'),
      buttons: [
        { label: t('onboarding:clearKeep'), variant: 'ghost' },
        {
          label: t('onboarding:clearConfirm'),
          variant: 'danger',
          onPress: () => {
            clear();
            router.replace('/onboarding/select-watched' as any);
          },
        },
      ],
    });
  };

  // Total apply failure — selections preserved, explicit retry.
  if (applyFailed) {
    return (
      <Screen>
        <Header title={t('onboarding:reviewTitle')} showBack />
        <View style={{ flex: 1, justifyContent: 'center', padding: spacing.lg, gap: spacing.md }}>
          <EmptyState
            icon="cloud-offline-outline"
            title={t('onboarding:failTitle')}
            subtitle={t('onboarding:failBody')}
          />
          <Button
            title={t('onboarding:failRetry')}
            loading={apply.isPending}
            onPress={onConfirm}
          />
          <Button
            title={t('onboarding:failBack')}
            variant="ghost"
            onPress={() => setApplyFailed(false)}
          />
        </View>
      </Screen>
    );
  }

  // Empty review — nothing to apply.
  if (ready && counts.total === 0) {
    return (
      <Screen>
        <Header title={t('onboarding:reviewTitle')} showBack />
        <View style={{ flex: 1, justifyContent: 'center', padding: spacing.lg, gap: spacing.md }}>
          <EmptyState
            icon="albums-outline"
            title={t('onboarding:emptyReviewTitle')}
            subtitle={t('onboarding:emptyReviewBody')}
          />
          <Button
            title={t('onboarding:emptyReviewChoose')}
            onPress={() => router.replace('/onboarding/select-watched' as any)}
          />
          <Button title={t('onboarding:skipSetup')} variant="ghost" onPress={() => skip(false)} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <Header title={t('onboarding:reviewTitle')} showBack />
      <ScrollView
        contentContainerStyle={{
          padding: spacing.lg,
          gap: spacing.lg,
          paddingBottom: 120 + insets.bottom,
        }}
      >
        <T variant="body" muted>
          {t('onboarding:reviewBody')}
        </T>

        {watchedShows.length > 0 ? (
          <TitleSection
            title={t('onboarding:sectionWatchedShows')}
            onEdit={() => router.push('/onboarding/progress' as any)}
          >
            {watchedShows.map(({ id, show, meta }) => (
              <ReviewTile key={id} meta={meta} progress={showProgressLabel(show, t)} />
            ))}
          </TitleSection>
        ) : null}
        {watchedMovies.length > 0 ? (
          <TitleSection
            title={t('onboarding:sectionWatchedMovies')}
            onEdit={() => router.push('/onboarding/select-watched?tab=movies' as any)}
          >
            {watchedMovies.map(({ id, meta }) => (
              <ReviewTile key={id} meta={meta} />
            ))}
          </TitleSection>
        ) : null}
        {watchlistItems.length > 0 ? (
          <TitleSection
            title={t('onboarding:sectionWatchlist')}
            onEdit={() => router.push('/onboarding/select-watchlist' as any)}
          >
            {watchlistItems.map(({ id, meta }) => (
              <ReviewTile key={id} meta={meta} />
            ))}
          </TitleSection>
        ) : null}

        <Card style={{ gap: spacing.sm }}>
          <SummaryRow
            label={t('onboarding:summaryShowsWatched')}
            value={counts.showsWatched}
            color={tokens.watched}
          />
          <SummaryRow
            label={t('onboarding:summaryMoviesWatched')}
            value={counts.moviesWatched}
            color={tokens.watched}
          />
          <SummaryRow
            label={t('onboarding:summaryEpisodes')}
            value={episodes.known}
            color={tokens.watched}
          />
          <SummaryRow
            label={t('onboarding:summaryWatchlist')}
            value={watchlistTotal}
            color={tokens.warning}
          />
          {episodes.unknown > 0 ? (
            <T variant="micro" muted style={{ marginTop: spacing.xs }}>
              {t('onboarding:episodeTotalsPending')}
            </T>
          ) : null}
        </Card>

        {tooMany ? (
          <T variant="caption" style={{ color: tokens.danger, textAlign: 'center' }}>
            {t('onboarding:tooMany')}
          </T>
        ) : null}

        <View style={{ gap: spacing.sm }}>
          <Button
            title={
              apply.isPending
                ? t('onboarding:applyingCta')
                : t('onboarding:confirmApply', { count: counts.total })
            }
            loading={apply.isPending}
            disabled={!ready || tooMany}
            onPress={onConfirm}
          />
          <Button title={t('onboarding:backToEdit')} variant="ghost" onPress={() => router.back()} />
          <Pressable
            onPress={onClearAll}
            hitSlop={8}
            accessibilityRole="button"
            style={{ alignSelf: 'center', paddingVertical: spacing.xs }}
          >
            <T variant="caption" style={{ color: tokens.danger }}>
              {t('onboarding:clearAll')}
            </T>
          </Pressable>
        </View>
      </ScrollView>
    </Screen>
  );
}

function showProgressLabel(show: DraftShow, t: any): string | undefined {
  if (show.action === 'WATCHED_THROUGH') {
    return t('onboarding:throughStatus', {
      season: show.throughSeasonNumber,
      episode: show.throughEpisodeNumber,
    });
  }
  if (show.airedCount != null) {
    return t('onboarding:allAiredEpisodes', {
      count: show.airedCount,
      defaultValue: 'All {{count}} aired episodes',
    });
  }
  return undefined;
}

function TitleSection({
  title,
  onEdit,
  children,
}: {
  title: string;
  onEdit: () => void;
  children: React.ReactNode;
}) {
  const { t } = useTranslation(['onboarding']);
  const { tokens } = useAppearance();
  return (
    <View style={{ gap: spacing.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <T variant="h2">{title}</T>
        <Pressable onPress={onEdit} hitSlop={10} accessibilityRole="button">
          <T variant="caption" style={{ color: tokens.primary }}>
            {t('onboarding:editAction')}
          </T>
        </Pressable>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: spacing.sm }}
      >
        {children}
      </ScrollView>
    </View>
  );
}

function ReviewTile({ meta, progress }: { meta?: DraftMeta; progress?: string }) {
  const { tokens } = useAppearance();
  return (
    <View style={{ width: 92 }}>
      <PosterImage
        uri={meta?.poster}
        transition={0}
        style={{ width: 92, height: 138, borderRadius: radius.md }}
      />
      <T variant="micro" numberOfLines={2} style={{ marginTop: spacing.xs }}>
        {meta?.title}
      </T>
      {progress ? (
        <T variant="micro" style={{ color: tokens.watched }} numberOfLines={1}>
          {progress}
        </T>
      ) : null}
    </View>
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
