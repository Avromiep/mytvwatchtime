import React, { useState } from 'react';
import { Linking, Pressable, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { formatDateTime, type ExternalReviewDto } from '@tvwatch/shared';
import { T } from '../primitives';
import { useAppearance } from '../../context/PreferencesProvider';
import { radius, spacing } from '../../theme/theme';

const AVATAR = 36;
/** TMDB brand green/blue used for the wordmark badge. */
const TMDB_BLUE = '#01b4e4';
const COLLAPSED_LINES = 6;

/**
 * A provider-authored (TMDB) review inside a comments thread. The TMDB badge next to
 * the author opens the canonical review URL on themoviedb.org.
 */
export function ExternalReviewCard({ review }: { review: ExternalReviewDto }) {
  const { tokens, resolvedLocale } = useAppearance();
  const { t } = useTranslation(['comments']);
  const [expanded, setExpanded] = useState(false);

  const openSource = () => Linking.openURL(review.url).catch(() => undefined);

  return (
    <View style={[styles.card, { backgroundColor: tokens.cardBackground }]}>
      <View style={styles.header}>
        {review.avatarUrl ? (
          <Image source={{ uri: review.avatarUrl }} style={styles.avatar} contentFit="cover" />
        ) : (
          <Ionicons name="person-circle" size={AVATAR} color={tokens.textMuted} />
        )}
        <View style={{ flex: 1, marginLeft: spacing.sm }}>
          <View style={styles.nameRow}>
            <T variant="body" numberOfLines={1} style={{ fontWeight: '700', flexShrink: 1 }}>
              {review.author}
            </T>
            <Pressable
              onPress={openSource}
              hitSlop={6}
              accessibilityRole="link"
              accessibilityLabel="TMDB"
              style={[styles.badge, { backgroundColor: TMDB_BLUE }]}
            >
              <T variant="micro" style={styles.badgeText}>
                TMDB
              </T>
              <Ionicons name="open-outline" size={10} color="#fff" />
            </Pressable>
          </View>
          <View style={styles.metaRow}>
            {review.rating != null && (
              <View style={styles.ratingRow}>
                <Ionicons name="star" size={12} color={tokens.orange} />
                <T variant="micro" style={{ color: tokens.orange, fontWeight: '700' }}>
                  {` ${review.rating}/10`}
                </T>
              </View>
            )}
            <T variant="micro" muted>
              {formatDateTime(review.createdAt, resolvedLocale)}
            </T>
          </View>
        </View>
      </View>

      <Pressable onPress={() => setExpanded((v) => !v)}>
        <T
          variant="body"
          numberOfLines={expanded ? undefined : COLLAPSED_LINES}
          style={{ marginTop: spacing.sm }}
        >
          {review.content}
        </T>
        <T variant="micro" style={{ color: tokens.primary, marginTop: 2, fontWeight: '700' }}>
          {expanded ? t('comments:showLess') : t('comments:showMore')}
        </T>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  header: { flexDirection: 'row', alignItems: 'center' },
  avatar: { width: AVATAR, height: AVATAR, borderRadius: AVATAR / 2 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    borderRadius: radius.sm,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  badgeText: { color: '#fff', fontWeight: '900', letterSpacing: 0.5, fontSize: 9 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: 1 },
  ratingRow: { flexDirection: 'row', alignItems: 'center' },
});
