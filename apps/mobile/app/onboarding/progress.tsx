import React, { useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Header } from '../../components/Header';
import { Button, PosterImage, Screen, T } from '../../components/primitives';
import { ProgressEditorSheet } from '../../components/onboarding/ProgressEditorSheet';
import { useShowEpisodes } from '../../api/hooks';
import { useAuth } from '../../context/AuthContext';
import { useAppearance } from '../../context/PreferencesProvider';
import { useOnboardingDraft } from '../../lib/onboarding/useOnboardingDraft';
import { useSkipSetup } from '../../lib/onboarding/useSkipSetup';
import {
  DraftShow,
  countThrough,
  eligibleAiredEpisodes,
  selectionCounts,
} from '../../lib/onboarding/draft';
import { logEvent } from '../../lib/analytics';
import { radius, spacing } from '../../theme/theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * Step 4 — show progress. Watched shows default to fully watched ("All N aired
 * episodes"); the user only adjusts the ones they stopped partway through, via
 * ONE bottom sheet per show. Movies and watchlist shows never appear here, and
 * the step is skipped entirely when no watched shows were selected.
 */
export default function OnboardingProgress() {
  const { t } = useTranslation(['onboarding', 'common']);
  const { tokens } = useAppearance();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const { draft, ready, act, flush } = useOnboardingDraft(user?.id);
  const { skip } = useSkipSetup();
  const [editorFor, setEditorFor] = useState<string | null>(null);

  const rows = useMemo(
    () =>
      Object.entries(draft.shows)
        .filter(([, s]) => s.action !== 'WATCHLIST')
        .map(([id, s]) => ({ id, ...s, meta: draft.meta[id] }))
        .sort((a, b) => (a.meta?.title ?? '').localeCompare(b.meta?.title ?? '')),
    [draft],
  );

  // No watched shows → this step has no purpose; jump straight to review.
  useEffect(() => {
    if (ready && rows.length === 0) router.replace('/onboarding/review' as any);
  }, [ready, rows.length]);

  const counts = selectionCounts(draft);
  const editorShow = editorFor ? draft.shows[editorFor] : undefined;

  return (
    <Screen>
      <Header
        title={t('onboarding:progressTitle')}
        showBack
        right={
          <Pressable
            onPress={() => skip(counts.total > 0)}
            hitSlop={10}
            accessibilityRole="button"
          >
            <T variant="caption" style={{ color: tokens.primary }}>
              {t('onboarding:skipSetup')}
            </T>
          </Pressable>
        }
      />
      <T variant="body" muted style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}>
        {t('onboarding:progressBody')}
      </T>
      {!ready ? null : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          contentContainerStyle={{ padding: spacing.lg, paddingBottom: 96 + insets.bottom }}
          renderItem={({ item }) => (
            <ProgressRow
              id={item.id}
              show={item}
              title={item.meta?.title ?? ''}
              poster={item.meta?.poster}
              onPress={() => setEditorFor(item.id)}
              onCounts={(airedCount, throughCount) =>
                act({ type: 'setCounts', id: item.id, airedCount, throughCount })
              }
            />
          )}
        />
      )}

      <View
        style={[
          styles.footer,
          {
            backgroundColor: tokens.cardBackground,
            borderTopColor: tokens.divider,
            paddingBottom: insets.bottom + spacing.md,
          },
        ]}
      >
        <Button
          title={t('onboarding:continueToReview')}
          onPress={() => {
            flush(); // review hydrates from AsyncStorage — persist first
            router.push('/onboarding/review' as any);
          }}
        />
      </View>

      {editorFor ? (
        <ProgressEditorSheet
          mediaId={editorFor}
          showTitle={draft.meta[editorFor]?.title ?? ''}
          visible
          current={editorShow}
          onClose={() => setEditorFor(null)}
          onAllAired={() => {
            act({ type: 'setCaughtUp', id: editorFor });
            logEvent('onboarding_progress_changed');
          }}
          onThrough={(seasonNumber, episodeNumber, label, episodeTitle, count) => {
            act({
              type: 'setThrough',
              id: editorFor,
              seasonNumber,
              episodeNumber,
              label,
              episodeTitle,
              count,
            });
            logEvent('onboarding_progress_changed');
          }}
          onMoveToWatchlist={() => {
            act({ type: 'moveToWatchlist', id: editorFor });
            logEvent('onboarding_progress_changed');
          }}
          onRemove={() => {
            act({ type: 'remove', id: editorFor, mediaType: 'SHOW' });
            logEvent('onboarding_progress_changed');
          }}
        />
      ) : null}
    </Screen>
  );
}

/**
 * Whole row is tappable. Loads the show's aired, non-special episode total so
 * the status reads "All 18 aired episodes" (never a vague "Caught up"), and
 * records the counts into the draft so the review totals are exact.
 */
function ProgressRow({
  id,
  show,
  title,
  poster,
  onPress,
  onCounts,
}: {
  id: string;
  show: DraftShow;
  title: string;
  poster?: string | null;
  onPress: () => void;
  onCounts: (airedCount: number, throughCount?: number) => void;
}) {
  const { t } = useTranslation(['onboarding']);
  const { tokens } = useAppearance();
  const seasonsQ = useShowEpisodes(id);

  const eligible = useMemo(
    () => eligibleAiredEpisodes((seasonsQ.data ?? []) as any),
    [seasonsQ.data],
  );

  useEffect(() => {
    if (!seasonsQ.data) return;
    const throughCount =
      show.action === 'WATCHED_THROUGH' &&
      show.throughSeasonNumber != null &&
      show.throughEpisodeNumber != null
        ? countThrough(eligible, show.throughSeasonNumber, show.throughEpisodeNumber)
        : undefined;
    onCounts(eligible.length, throughCount);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seasonsQ.data]);

  const airedTotal = show.airedCount ?? (seasonsQ.data ? eligible.length : null);
  const status =
    show.action === 'WATCHED_THROUGH'
      ? t('onboarding:throughStatus', {
          season: show.throughSeasonNumber,
          episode: show.throughEpisodeNumber,
        })
      : airedTotal != null
        ? t('onboarding:allAiredEpisodes', {
            count: airedTotal,
            defaultValue: 'All {{count}} aired episodes',
          })
        : null;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={t('onboarding:a11yAdjust', { title })}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: tokens.cardBackground },
        pressed && { opacity: 0.85 },
      ]}
    >
      <PosterImage
        uri={poster}
        transition={0}
        style={{ width: 44, height: 66, borderRadius: radius.sm }}
      />
      <View style={{ flex: 1 }}>
        <T variant="body" numberOfLines={2}>
          {title}
        </T>
        {status ? (
          <View style={[styles.ruleChip, { backgroundColor: tokens.surfaceElevated }]}>
            <Ionicons
              name={show.action === 'WATCHED_THROUGH' ? 'play-forward-outline' : 'checkmark-done'}
              size={14}
              color={tokens.watched}
            />
            <T variant="caption" style={{ color: tokens.textPrimary }}>
              {status}
            </T>
          </View>
        ) : null}
        {show.action === 'WATCHED_THROUGH' && show.throughEpisodeTitle ? (
          <T variant="micro" muted style={{ marginTop: 2 }} numberOfLines={1}>
            {show.throughEpisodeTitle}
          </T>
        ) : null}
      </View>
      <Ionicons name="chevron-forward" size={20} color={tokens.textMuted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderRadius: radius.lg,
    padding: spacing.sm,
    marginBottom: spacing.sm,
    minHeight: 80,
  },
  ruleChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    marginTop: spacing.xs,
  },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopWidth: 1,
    padding: spacing.lg,
  },
});
