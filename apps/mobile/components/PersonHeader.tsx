import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { PersonDetailResponse } from '@tvwatch/shared';
import { PosterImage, T } from './primitives';
import { useAppearance } from '../context/PreferencesProvider';
import { radius, spacing } from '../theme/theme';
import { formatAirDate } from '../lib/format';

const PHOTO_W = 88;
const PHOTO_H = 118;

/** Compact person header: back-button row + portrait/info row over a subtle
 *  theme-gradient surface. Person records have no genuine backdrop artwork, so
 *  there is deliberately no cinematic hero band — and the profile portrait is
 *  never enlarged into a fake one. Fixed geometry: nothing shifts on image load. */
export function PersonHeader({ person }: { person: PersonDetailResponse['person'] }) {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['person', 'common']);
  const insets = useSafeAreaInsets();

  const born = person.birthDate ? formatAirDate(person.birthDate) : null;
  const died = person.deathDate ? formatAirDate(person.deathDate) : null;

  return (
    <LinearGradient colors={[tokens.surfaceElevated, tokens.background]}>
      <View style={{ paddingTop: insets.top + spacing.sm, paddingHorizontal: spacing.xl }}>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel={t('common:back')}
          style={[styles.backBtn, { backgroundColor: tokens.overlay }]}
        >
          <Ionicons name="chevron-back" size={24} color={tokens.mediaText} />
        </Pressable>

        <View style={styles.identityRow}>
          <View
            style={[
              styles.photoFrame,
              { borderColor: tokens.border, shadowColor: tokens.overlayStrong },
            ]}
          >
            <PosterImage uri={person.profileUrl} style={{ width: PHOTO_W, height: PHOTO_H }} />
            {!person.profileUrl ? (
              <View style={[StyleSheet.absoluteFill, styles.placeholder]}>
                <Ionicons name="person-outline" size={34} color={tokens.textMuted} />
              </View>
            ) : null}
          </View>

          <View style={styles.info}>
            <T variant="title" numberOfLines={2} style={{ fontSize: 24 }}>
              {person.name}
            </T>
            {born ? (
              <View style={styles.metaRow}>
                <Ionicons name="calendar-outline" size={14} color={tokens.textMuted} />
                <T variant="caption" muted style={[styles.metaText, { fontSize: 13 }]}>
                  {died ? t('person:bornDied', { born, died }) : t('person:bornOn', { date: born })}
                </T>
              </View>
            ) : null}
            {person.birthPlace ? (
              <View style={styles.metaRow}>
                <Ionicons name="location-outline" size={14} color={tokens.textMuted} />
                <T
                  variant="caption"
                  muted
                  numberOfLines={2}
                  style={[styles.metaText, { fontSize: 13, flex: 1 }]}
                >
                  {person.birthPlace}
                </T>
              </View>
            ) : null}
          </View>
        </View>
      </View>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  backBtn: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  identityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.lg,
  },
  photoFrame: {
    width: PHOTO_W,
    height: PHOTO_H,
    borderRadius: radius.md,
    borderWidth: 1,
    overflow: 'hidden',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.35,
    shadowRadius: 6,
    elevation: 4,
  },
  placeholder: { alignItems: 'center', justifyContent: 'center' },
  info: { flex: 1, marginLeft: spacing.lg },
  metaRow: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.xs },
  metaText: { marginLeft: spacing.xs },
});
