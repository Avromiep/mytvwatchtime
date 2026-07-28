import React, { useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Header } from '../../components/Header';
import { Button, PosterImage, Screen, T } from '../../components/primitives';
import { ThroughPickerSheet } from '../../components/onboarding/ThroughPickerSheet';
import { useAuth } from '../../context/AuthContext';
import { useAppearance } from '../../context/PreferencesProvider';
import { useOnboardingDraft } from '../../lib/onboarding/useOnboardingDraft';
import { DraftShow } from '../../lib/onboarding/draft';
import { logEvent } from '../../lib/analytics';
import { showDialog } from '../../lib/dialog';
import { radius, spacing } from '../../theme/theme';

/**
 * Compact show-progress review: shows marked "watched" default to CAUGHT_UP;
 * the user only adjusts shows they stopped partway through. Movies never appear
 * here (watched/watchlist only).
 */
export default function OnboardingProgress() {
  const { t } = useTranslation(['onboarding', 'common']);
  const { tokens } = useAppearance();
  const { user } = useAuth();
  const { draft, ready, act } = useOnboardingDraft(user?.id);
  const [pickerFor, setPickerFor] = useState<string | null>(null);

  const rows = Object.entries(draft.shows)
    .filter(([, s]) => s.action !== 'WATCHLIST')
    .map(([id, s]) => ({ id, ...s, meta: draft.meta[id] }))
    .sort((a, b) => (a.meta?.title ?? '').localeCompare(b.meta?.title ?? ''));

  const ruleLabel = (s: DraftShow) =>
    s.action === 'WATCHED_THROUGH'
      ? (s.throughLabel ??
        t('onboarding:throughLabel', {
          season: s.throughSeasonNumber,
          episode: s.throughEpisodeNumber,
        }))
      : t('onboarding:caughtUp');

  const openRuleMenu = (id: string, title: string) => {
    showDialog({
      title,
      buttons: [
        {
          label: t('onboarding:caughtUp'),
          variant: 'primary',
          onPress: () => {
            act({ type: 'setShowAction', id, action: 'CAUGHT_UP' });
            logEvent('onboarding_progress_adjusted');
          },
        },
        {
          label: t('onboarding:watchedThrough'),
          variant: 'secondary',
          onPress: () => setPickerFor(id),
        },
        {
          label: t('onboarding:moveToWatchlist'),
          variant: 'secondary',
          onPress: () => {
            act({ type: 'setShowAction', id, action: 'WATCHLIST' });
            logEvent('onboarding_progress_adjusted');
          },
        },
        { label: t('common:cancel'), variant: 'ghost' },
      ],
    });
  };

  return (
    <Screen>
      <Header title={t('onboarding:progressTitle')} showBack />
      <T variant="body" muted style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}>
        {t('onboarding:progressDesc')}
      </T>
      {!ready ? null : rows.length === 0 ? (
        <T variant="body" muted style={{ padding: spacing.lg }}>
          {t('onboarding:noShowsToReview')}
        </T>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          contentContainerStyle={{ padding: spacing.lg, paddingBottom: 96 }}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => openRuleMenu(item.id, item.meta?.title ?? '')}
              accessibilityRole="button"
              accessibilityLabel={t('onboarding:a11yAdjust', { title: item.meta?.title ?? '' })}
              style={({ pressed }) => [
                styles.row,
                { backgroundColor: tokens.cardBackground },
                pressed && { opacity: 0.85 },
              ]}
            >
              <PosterImage
                uri={item.meta?.poster}
                transition={0}
                style={{ width: 44, height: 66, borderRadius: radius.sm }}
              />
              <View style={{ flex: 1 }}>
                <T variant="body" numberOfLines={2}>
                  {item.meta?.title}
                </T>
                <View
                  style={[styles.ruleChip, { backgroundColor: tokens.surfaceElevated }]}
                >
                  <Ionicons
                    name={item.action === 'WATCHED_THROUGH' ? 'play-forward-outline' : 'checkmark-done'}
                    size={14}
                    color={tokens.watched}
                  />
                  <T variant="caption" style={{ color: tokens.textPrimary }}>
                    {ruleLabel(item)}
                  </T>
                </View>
              </View>
              <Ionicons name="chevron-forward" size={20} color={tokens.textMuted} />
            </Pressable>
          )}
        />
      )}

      <View style={[styles.footer, { backgroundColor: tokens.cardBackground, borderTopColor: tokens.divider }]}>
        <Button title={t('onboarding:continueToReview')} onPress={() => router.push('/onboarding/review' as any)} />
      </View>

      {pickerFor ? (
        <ThroughPickerSheet
          mediaId={pickerFor}
          visible
          onClose={() => setPickerFor(null)}
          onSelect={(seasonNumber, episodeNumber, label) => {
            act({ type: 'setThrough', id: pickerFor, seasonNumber, episodeNumber, label });
            logEvent('onboarding_progress_adjusted');
          }}
        />
      ) : null}
    </Screen>
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
