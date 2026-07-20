import React, { useState } from 'react';
import { Linking, Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { CommentDto, CommentListRefDto, CommentMediaRefDto } from '@tvwatch/shared';
import { formatDateTime } from '@tvwatch/shared';
import { PosterImage, T, APP_ICON } from '../primitives';
import { CommentMedia } from './CommentMedia';
import { useAppearance } from '../../context/PreferencesProvider';
import { radius, spacing } from '../../theme/theme';

const AVATAR = 40;
const AVATAR_COMPACT = 32;

export interface CommentCardProps {
  comment: CommentDto;
  isOwner: boolean;
  onLike: (c: CommentDto) => void;
  /** Open the dedicated thread screen (feed cards). */
  onOpenThread?: (c: CommentDto) => void;
  /** Show the overflow action sheet (report / block / edit / delete). */
  onOverflow: (c: CommentDto) => void;
  /** Open the author's profile (avatar tap). Does not open the thread. */
  onPressAuthor?: (c: CommentDto) => void;
  /** Show the reply count + icon that opens the thread. */
  showReplyAction?: boolean;
  /** Whole card is tappable to open the thread. */
  interactive?: boolean;
  /** Compact avatar (used for replies). */
  compact?: boolean;
}

/** Stop a press from bubbling into the card's open-thread handler (web). */
function stop(e: any) {
  e?.stopPropagation?.();
}

export function CommentCard({
  comment,
  onLike,
  onOpenThread,
  onOverflow,
  onPressAuthor,
  showReplyAction = false,
  interactive = false,
  compact = false,
}: CommentCardProps) {
  const { tokens, resolvedLocale } = useAppearance();
  const { t } = useTranslation(['comments', 'common']);
  const tombstone = comment.deletedByUser;
  const avatar = compact ? AVATAR_COMPACT : AVATAR;
  const author = comment.author;
  // Spoiler censoring: body + attachments stay hidden until THIS user taps to reveal
  // (per-card, per-session — never persisted).
  const [revealed, setRevealed] = useState(false);
  const censored = comment.isSpoiler && !tombstone && !revealed;

  const openThread = () => onOpenThread?.(comment);
  const openMedia = (media: CommentMediaRefDto) =>
    router.push(`/${media.mediaType === 'SHOW' ? 'show' : 'movie'}/${media.mediaId}` as any);
  const openList = (list: CommentListRefDto) => router.push(`/list/${list.id}` as any);
  const isReview = comment.kind === 'review';
  const openReviewSource = () =>
    comment.reviewUrl && Linking.openURL(comment.reviewUrl).catch(() => undefined);

  return (
    <Pressable
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: tokens.cardBackground },
        compact && styles.cardCompact,
        interactive && pressed && styles.cardPressed,
      ]}
      onPress={interactive ? openThread : undefined}
      disabled={!interactive}
    >
      {/* Header: avatar · name/date · overflow (top-right) */}
      <View style={styles.header}>
        <Pressable
          onPress={(e) => {
            stop(e);
            if (isReview) openReviewSource();
            else onPressAuthor?.(comment);
          }}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={author?.username}
        >
          <PosterImage
            uri={author?.avatarUrl}
            fallback={APP_ICON}
            style={{ width: avatar, height: avatar, borderRadius: avatar / 2 }}
          />
        </Pressable>

        <View style={styles.nameCol}>
          <View style={styles.nameRow}>
            <T variant="caption" style={{ fontWeight: '700', color: tokens.textPrimary }}>
              {author?.username}
            </T>
            {isReview ? (
              <Pressable
                onPress={(e) => {
                  stop(e);
                  openReviewSource();
                }}
                hitSlop={6}
                accessibilityRole="link"
                accessibilityLabel="TMDB"
                style={styles.reviewBadge}
              >
                <T variant="micro" style={styles.reviewBadgeText}>
                  TMDB
                </T>
                <Ionicons name="open-outline" size={10} color="#fff" />
              </Pressable>
            ) : null}
            {comment.isEdited && !tombstone ? (
              <T variant="micro" muted style={{ marginLeft: spacing.xs }}>
                · {t('comments:edited')}
              </T>
            ) : null}
          </View>
          <T variant="micro" muted style={{ marginTop: 2 }}>
            {formatDateTime(comment.createdAt, resolvedLocale)}
          </T>
        </View>

        {!isReview ? (
          <Pressable
            onPress={(e) => {
              stop(e);
              onOverflow(comment);
            }}
            hitSlop={10}
            style={styles.overflowBtn}
            accessibilityRole="button"
            accessibilityLabel={t('common:moreOptions')}
          >
            <Ionicons name="ellipsis-horizontal" size={20} color={tokens.textMuted} />
          </Pressable>
        ) : null}
      </View>

      {/* Spoiler cover: replaces body + all attachments until the reader taps to reveal */}
      {censored ? (
        <Pressable
          onPress={(e) => {
            stop(e);
            setRevealed(true);
          }}
          style={[styles.spoilerCover, { backgroundColor: tokens.surfaceElevated }]}
          accessibilityRole="button"
          accessibilityLabel={t('comments:viewSpoiler')}
        >
          <Ionicons name="eye-off-outline" size={18} color={tokens.orange} />
          <T
            variant="caption"
            style={{ color: tokens.orange, fontWeight: '700', marginLeft: spacing.xs }}
          >
            {t('comments:spoilerWarning')}
          </T>
          <T variant="micro" muted style={{ marginTop: 2 }}>
            {t('comments:viewSpoiler')}
          </T>
        </Pressable>
      ) : null}

      {/* Body */}
      {tombstone ? (
        <T variant="body" muted style={[styles.body, { fontStyle: 'italic' }]}>
          {t('comments:deleted')}
        </T>
      ) : !censored && comment.body ? (
        <T variant="body" style={styles.body}>
          {comment.body}
        </T>
      ) : null}

      {/* Media (image/GIF) — fills card width, opens full-screen viewer */}
      {!tombstone && !censored ? (
        <CommentMedia image={comment.image} gifUrl={comment.gifUrl} />
      ) : null}

      {/* Attached show/movie card — opens the media detail page */}
      {!tombstone && !censored && comment.media ? (
        <Pressable
          onPress={(e) => {
            stop(e);
            openMedia(comment.media!);
          }}
          style={({ pressed }) => [
            styles.mediaCard,
            { backgroundColor: tokens.surfaceElevated, opacity: pressed ? 0.85 : 1 },
          ]}
          accessibilityRole="button"
          accessibilityLabel={comment.media.title}
        >
          <PosterImage uri={comment.media.posterUrl} style={styles.mediaPoster} />
          <View style={styles.mediaMeta}>
            <T variant="caption" style={{ fontWeight: '700' }} numberOfLines={2}>
              {comment.media.title}
            </T>
            <View style={styles.mediaMetaRow}>
              <Ionicons
                name={comment.media.mediaType === 'SHOW' ? 'tv-outline' : 'film-outline'}
                size={12}
                color={tokens.textMuted}
              />
              {comment.media.year ? (
                <T variant="micro" muted style={{ marginLeft: 4 }}>
                  {comment.media.year}
                </T>
              ) : null}
            </View>
          </View>
          <Ionicons name="chevron-forward" size={18} color={tokens.textMuted} />
        </Pressable>
      ) : null}

      {/* Attached list card — opens the list page */}
      {!tombstone && !censored && comment.list ? (
        <Pressable
          onPress={(e) => {
            stop(e);
            openList(comment.list!);
          }}
          style={({ pressed }) => [
            styles.mediaCard,
            { backgroundColor: tokens.surfaceElevated, opacity: pressed ? 0.85 : 1 },
          ]}
          accessibilityRole="button"
          accessibilityLabel={comment.list.title}
        >
          {comment.list.coverUrl ? (
            <PosterImage uri={comment.list.coverUrl} style={styles.listCover} />
          ) : (
            <View
              style={[
                styles.listCover,
                styles.listCoverFallback,
                { backgroundColor: tokens.surface },
              ]}
            >
              <Ionicons name="list-outline" size={20} color={tokens.primary} />
            </View>
          )}
          <View style={styles.mediaMeta}>
            <T variant="caption" style={{ fontWeight: '700' }} numberOfLines={2}>
              {comment.list.title}
            </T>
            <T variant="micro" muted style={{ marginTop: 2 }}>
              {comment.list.movieCount > 0 ? `🎬 ${comment.list.movieCount}` : ''}
              {comment.list.movieCount > 0 && comment.list.showCount > 0 ? '  ' : ''}
              {comment.list.showCount > 0 ? `📺 ${comment.list.showCount}` : ''}
            </T>
          </View>
          <Ionicons name="chevron-forward" size={18} color={tokens.textMuted} />
        </Pressable>
      ) : null}

      {/* Action row: like · reply (overflow is in the header) */}
      <View style={styles.actions}>
        <Pressable
          onPress={(e) => {
            stop(e);
            if (!tombstone) onLike(comment);
          }}
          disabled={tombstone}
          hitSlop={8}
          style={styles.actionBtn}
          accessibilityRole="button"
          accessibilityLabel={t('comments:like')}
        >
          <Ionicons
            name={comment.likedByMe ? 'heart' : 'heart-outline'}
            size={18}
            color={
              comment.likedByMe ? tokens.favorite : tombstone ? tokens.textDim : tokens.textMuted
            }
          />
          <T variant="micro" muted style={{ marginLeft: 4 }}>
            {comment.likesCount}
          </T>
        </Pressable>

        {showReplyAction ? (
          <Pressable
            onPress={(e) => {
              stop(e);
              openThread();
            }}
            hitSlop={8}
            style={styles.actionBtn}
            accessibilityRole="button"
            accessibilityLabel={t('comments:openThread')}
          >
            <Ionicons name="chatbubble-outline" size={18} color={tokens.textMuted} />
            <T variant="micro" muted style={{ marginLeft: 4 }}>
              {comment.repliesCount > 0
                ? comment.repliesCount === 1
                  ? t('common:replySingular', { count: 1 })
                  : t('common:replyPlural', { count: comment.repliesCount })
                : t('comments:reply')}
            </T>
          </Pressable>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, padding: spacing.md },
  cardCompact: { padding: spacing.sm, borderRadius: radius.md },
  cardPressed: { opacity: 0.97 },
  header: { flexDirection: 'row', alignItems: 'center' },
  nameCol: { flex: 1, marginLeft: spacing.md },
  nameRow: { flexDirection: 'row', alignItems: 'center' },
  overflowBtn: { padding: spacing.xs, marginLeft: spacing.xs },
  body: { marginTop: spacing.sm, lineHeight: 20 },
  spoilerCover: {
    marginTop: spacing.sm,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reviewBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    borderRadius: radius.sm,
    paddingHorizontal: 5,
    paddingVertical: 2,
    marginLeft: spacing.xs,
    backgroundColor: '#01b4e4',
  },
  reviewBadgeText: { color: '#fff', fontWeight: '900', letterSpacing: 0.5, fontSize: 9 },
  mediaCard: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.md,
    padding: spacing.sm,
    marginTop: spacing.sm,
  },
  mediaPoster: { width: 36, height: 54, borderRadius: radius.sm },
  mediaMeta: { flex: 1, marginLeft: spacing.sm },
  mediaMetaRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
  listCover: { width: 54, height: 54, borderRadius: radius.sm },
  listCoverFallback: { alignItems: 'center', justifyContent: 'center' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, marginTop: spacing.sm },
  actionBtn: { flexDirection: 'row', alignItems: 'center' },
});
