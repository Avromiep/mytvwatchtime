import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { PosterImage, T } from '../primitives';
import { useAppearance } from '../../context/PreferencesProvider';
import { radius, spacing } from '../../theme/theme';

export type PosterSelectState = 'NONE' | 'WATCHED' | 'WATCHLIST';

/**
 * PosterCard variant for quick-setup bulk selection: no navigation Link — taps
 * toggle the selection state instead. Watched = green ring + check, watchlist =
 * yellow ring + bookmark. Already-tracked titles get a subtle library badge.
 */
export function SelectablePosterCard({
  title,
  poster,
  year,
  state,
  trackedHint,
  onToggle,
  width,
  accessibilityLabel,
}: {
  title: string;
  poster?: string | null;
  year?: number | null;
  state: PosterSelectState;
  /** Localized short label (e.g. "In library") shown when the user already tracks this title. */
  trackedHint?: string | null;
  onToggle?: () => void;
  width: number;
  accessibilityLabel?: string;
}) {
  const { tokens } = useAppearance();
  const selected = state !== 'NONE';
  const ringColor = state === 'WATCHED' ? tokens.watched : state === 'WATCHLIST' ? tokens.warning : 'transparent';
  const height = Math.round(width * 1.5);
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={accessibilityLabel ?? title}
      style={{ width }}
    >
      <View
        style={[
          styles.posterWrap,
          { borderRadius: radius.md, borderColor: ringColor, width, height },
        ]}
      >
        <PosterImage
          uri={poster}
          transition={0}
          style={{ width: '100%', height: '100%', borderRadius: radius.md }}
        />
        {selected ? (
          <View style={[styles.badge, { backgroundColor: ringColor }]}>
            <Ionicons
              name={state === 'WATCHED' ? 'checkmark' : 'bookmark'}
              size={16}
              color={tokens.primaryForeground}
            />
          </View>
        ) : null}
        {trackedHint ? (
          <View style={[styles.tracked, { backgroundColor: tokens.mediaScrim }]}>
            <T variant="micro" style={{ color: tokens.mediaText }}>
              {trackedHint}
            </T>
          </View>
        ) : null}
      </View>
      <T variant="caption" numberOfLines={2} style={{ marginTop: spacing.xs }}>
        {title}
      </T>
      {year ? (
        <T variant="micro" muted>
          {year}
        </T>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  posterWrap: { borderWidth: 3, overflow: 'hidden' },
  badge: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tracked: {
    position: 'absolute',
    left: 6,
    bottom: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
});
