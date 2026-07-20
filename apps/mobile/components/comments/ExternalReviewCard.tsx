import React, { useState } from 'react';
import { Linking, Pressable, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { formatDateTime, type CommentDto, type ExternalReviewDto } from '@tvwatch/shared';
import { PosterImage, Spinner, T, APP_ICON } from '../primitives';
import { useExternalReviewReplies } from '../../api/hooks';
import { useAppearance } from '../../context/PreferencesProvider';
import { radius, spacing } from '../../theme/theme';

const AVATAR = 36;
/** TMDB brand blue used for the wordmark badge. */
const TMDB_BLUE = '#01b4e4';
const COLLAPSED_LINES = 6;

/** One user reply under a TMDB review (compact; spoiler-aware). */
function ReviewReply({ reply }: { reply: CommentDto }) {
  const { tokens, resolvedLocale } = useAppearance();
  const { t } = useTranslation(['comments']);
  const [revealed, setRevealed] = useState(false);
  const censored = reply.isSpoiler && !revealed;
  return (
    <View style={styles.replyRow}>
      <PosterImage uri={reply.author?.avatarUrl} fallback={APP_ICON} style={styles.replyAvatar} />
      <View style={{ flex: 1, marginLeft: spacing.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}>
          <T variant="micro" style={{ fontWeight: '700', color: tokens.textPrimary }}>
            {reply.author?.username}
          </T>
          <T variant="micro" muted>
            {formatDateTime(reply.createdAt, resolvedLocale)}
          </T>
        </View>
        {censored ? (
          <Pressable onPress={() => setRevealed(true)} hitSlop={4}>
            <T variant="micro" style={{ color: tokens.orange, fontWeight: '700' }}>
              {t('comments:spoilerWarning')} · {t('comments:viewSpoiler')}
            </T>
          </Pressable>
        ) : (
          <T variant="caption">{reply.body}</T>
        )}
      </View>
    </View>
  );
}

/**
 * A provider-authored (TMDB) review inside a comments thread. The TMDB badge next to
 * the author opens the canonical review URL on themoviedb.org. Users can reply to the
 * review — it acts as a parent post in the thread.
 */
export function ExternalReviewCard({
  review,
  onReply,
}: {
  review: ExternalReviewDto;
  onReply?: (review: ExternalReviewDto) => void;
}) {
  const { tokens, resolvedLocale } = useAppearance();
  const { t } = useTranslation(['comments']);
  const [expanded, setExpanded] = useState(false);
  const [repliesOpen, setRepliesOpen] = useState(false);
  const replies = useExternalReviewReplies(review.id, repliesOpen);

  const openSource = () => Linking.openURL(review.url).catch(() => undefined);
  const replyCount = replies.data?.length ?? review.repliesCount;

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

      {/* Actions: reply · view replies */}
      <View style={styles.actions}>
        {onReply ? (
          <Pressable
            onPress={() => onReply(review)}
            hitSlop={8}
            style={styles.actionBtn}
            accessibilityRole="button"
            accessibilityLabel={t('comments:reply')}
          >
            <Ionicons name="chatbubble-outline" size={16} color={tokens.textMuted} />
            <T variant="micro" muted style={{ marginLeft: 4 }}>
              {t('comments:reply')}
            </T>
          </Pressable>
        ) : null}
        {replyCount > 0 ? (
          <Pressable
            onPress={() => setRepliesOpen((v) => !v)}
            hitSlop={8}
            style={styles.actionBtn}
            accessibilityRole="button"
          >
            <Ionicons
              name={repliesOpen ? 'chevron-up' : 'chevron-down'}
              size={16}
              color={tokens.primary}
            />
            <T variant="micro" style={{ color: tokens.primary, marginLeft: 4, fontWeight: '700' }}>
              {repliesOpen
                ? t('comments:hideReplies')
                : t('comments:viewReplies', { count: replyCount })}
            </T>
          </Pressable>
        ) : null}
      </View>

      {repliesOpen ? (
        <View style={styles.replies}>
          {replies.isLoading ? (
            <Spinner />
          ) : (
            (replies.data ?? []).map((r) => <ReviewReply key={r.id} reply={r} />)
          )}
        </View>
      ) : null}
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
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, marginTop: spacing.sm },
  actionBtn: { flexDirection: 'row', alignItems: 'center' },
  replies: {
    marginTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(128,128,128,0.3)',
    paddingTop: spacing.sm,
    gap: spacing.sm,
  },
  replyRow: { flexDirection: 'row', alignItems: 'flex-start' },
  replyAvatar: { width: 28, height: 28, borderRadius: 14 },
});
