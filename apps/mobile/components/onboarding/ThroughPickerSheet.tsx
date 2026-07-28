import React, { useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { EpisodeDto } from '@tvwatch/shared';
import { useShowEpisodes } from '../../api/hooks';
import { Spinner, T } from '../primitives';
import { useAppearance } from '../../context/PreferencesProvider';
import { radius, spacing } from '../../theme/theme';

type SeasonRow = {
  number: number;
  title: string;
  episodes: EpisodeDto[];
};

/**
 * Bottom-sheet "Watched through…" picker: pick the latest completed season, then
 * the latest completed episode in it. Specials (season 0) and unaired episodes are
 * never offered — they can't be marked watched by onboarding.
 */
export function ThroughPickerSheet({
  mediaId,
  visible,
  onClose,
  onSelect,
}: {
  mediaId: string;
  visible: boolean;
  onClose: () => void;
  onSelect: (seasonNumber: number, episodeNumber: number, label: string) => void;
}) {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['onboarding', 'common']);
  const seasonsQ = useShowEpisodes(visible ? mediaId : '');
  const [seasonNumber, setSeasonNumber] = useState<number | null>(null);

  const seasons: SeasonRow[] = useMemo(() => {
    const now = new Date();
    const rows: SeasonRow[] = (seasonsQ.data ?? [])
      .filter((s: any) => s.number > 0) // season 0 = specials — always excluded
      .map((s: any) => ({
        number: s.number,
        title: s.title,
        episodes: (s.episodes ?? []).filter(
          (e: EpisodeDto) => e.airDate && new Date(e.airDate) <= now,
        ),
      }))
      .filter((s: SeasonRow) => s.episodes.length > 0)
      .sort((a: SeasonRow, b: SeasonRow) => a.number - b.number);
    return rows;
  }, [seasonsQ.data]);

  const activeSeason = seasons.find((s) => s.number === seasonNumber) ?? null;

  const close = () => {
    setSeasonNumber(null);
    onClose();
  };

  const label = (s: number, e: number) =>
    t('onboarding:throughLabel', { season: s, episode: e });

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
        <Pressable
          style={[
            { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
            { backgroundColor: tokens.overlayStrong },
          ]}
          onPress={close}
        />
        <View style={[styles.sheet, { backgroundColor: tokens.cardBackground }]}>
          <View style={styles.headerRow}>
            {activeSeason ? (
              <Pressable onPress={() => setSeasonNumber(null)} hitSlop={10} accessibilityRole="button">
                <Ionicons name="chevron-back" size={22} color={tokens.textPrimary} />
              </Pressable>
            ) : null}
            <T variant="h2" style={{ flex: 1 }}>
              {activeSeason
                ? activeSeason.title || t('onboarding:seasonNumber', { number: activeSeason.number })
                : t('onboarding:pickThroughTitle')}
            </T>
            <Pressable onPress={close} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('common:cancel')}>
              <Ionicons name="close" size={22} color={tokens.textMuted} />
            </Pressable>
          </View>
          {seasonsQ.isLoading ? (
            <Spinner />
          ) : seasons.length === 0 ? (
            <T variant="body" muted style={{ padding: spacing.lg }}>
              {t('onboarding:noAiredEpisodes')}
            </T>
          ) : (
            <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
              {activeSeason
                ? activeSeason.episodes.map((e) => (
                    <Pressable
                      key={e.id}
                      accessibilityRole="button"
                      onPress={() => {
                        onSelect(activeSeason.number, e.number, label(activeSeason.number, e.number));
                        close();
                      }}
                      style={({ pressed }) => [styles.row, pressed && { backgroundColor: tokens.surfaceElevated }]}
                    >
                      <T variant="body" style={{ flex: 1 }} numberOfLines={1}>
                        {label(activeSeason.number, e.number)}
                        {e.title ? ` — ${e.title}` : ''}
                      </T>
                      {e.watched ? (
                        <Ionicons name="checkmark" size={18} color={tokens.watched} />
                      ) : null}
                    </Pressable>
                  ))
                : seasons.map((s) => (
                    <Pressable
                      key={s.number}
                      accessibilityRole="button"
                      onPress={() => setSeasonNumber(s.number)}
                      style={({ pressed }) => [styles.row, pressed && { backgroundColor: tokens.surfaceElevated }]}
                    >
                      <T variant="body" style={{ flex: 1 }} numberOfLines={1}>
                        {s.title || t('onboarding:seasonNumber', { number: s.number })}
                      </T>
                      <T variant="caption" muted>
                        {t('onboarding:episodeCount', { count: s.episodes.length })}
                      </T>
                      <Ionicons name="chevron-forward" size={18} color={tokens.textMuted} />
                    </Pressable>
                  ))}
            </ScrollView>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingTop: spacing.md,
    maxHeight: '70%',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  list: { paddingHorizontal: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 48,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
  },
});
