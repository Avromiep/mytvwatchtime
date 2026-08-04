import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { CommentDto, CommentListRefDto, CommentMediaRefDto } from '@tvwatch/shared';
import { PosterImage, T, APP_ICON } from '../primitives';
import { CommentMedia } from './CommentMedia';
import {
  authorDisplayName,
  formatRelativeShort,
  THREAD_AVATAR,
  THREAD_CENTER_Y,
  THREAD_CONTENT_INDENT,
  THREAD_ELBOW_R,
  THREAD_GUTTER,
  THREAD_ROW_PAD_TOP,
  type ExpandedNode,
} from './thread-utils';
import { useAppearance } from '../../context/PreferencesProvider';
import { radius, spacing } from '../../theme/theme';
import { TranslatableContent } from './TranslatableContent';

/** Avatar center X within a node (avatar starts at the node's left edge). */
const AVATAR_CX = THREAD_AVATAR / 2;
/** Own thread line X (2px wide, centered on the avatar center). */
const OWN_LINE_LEFT = AVATAR_CX - 1;
/** Parent's thread line X, relative to this node (one gutter to the left). */
const PARENT_LINE_LEFT = OWN_LINE_LEFT - THREAD_GUTTER;

export interface ThreadHandlers {
  onLike: (c: CommentDto) => void;
  onOverflow: (c: CommentDto) => void;
  onPressAuthor?: (c: CommentDto) => void;
  onReply?: (c: CommentDto) => void;
  onToggleCollapse?: (c: CommentDto) => void;
  onLoadMore: (node: CommentDto) => void;
  isOwner: (c?: CommentDto | null) => boolean;
}

interface NodeContentProps {
  comment: CommentDto;
  depth: number;
  collapsed: boolean;
  handlers: ThreadHandlers;
  /** Transient highlight (e.g. opened from a notification) — cleared by the screen. */
  highlighted?: boolean;
}

/**
 * The comment itself: avatar + username/time header, body, attachments, actions.
 * Thread lines live in ThreadNode around this — the own line emerges from the
 * avatar's bottom CENTER (hidden behind the circular avatar), like Reddit.
 */
export function NodeContent({
  comment,
  depth,
  collapsed,
  handlers,
  highlighted,
}: NodeContentProps) {
  const { tokens, resolvedLocale } = useAppearance();
  const { t } = useTranslation(['comments', 'common']);
  const tombstone = comment.deletedByUser;
  const showCollapse = depth > 0 && !!handlers.onToggleCollapse && comment.repliesCount > 0;

  const openMedia = (media: CommentMediaRefDto) =>
    router.push(`/${media.mediaType === 'SHOW' ? 'show' : 'movie'}/${media.mediaId}` as any);
  const openList = (list: CommentListRefDto) => router.push(`/list/${list.id}` as any);

  return (
    <View
      style={[
        styles.content,
        highlighted ? { backgroundColor: tokens.primary + '15', borderRadius: radius.md } : null,
      ]}
    >
      {/* Header: avatar · username · time */}
      <View style={styles.headerRow}>
        <Pressable
          onPress={() => !comment.author?.isDeletedUser && handlers.onPressAuthor?.(comment)}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={authorDisplayName(comment.author, t)}
        >
          <PosterImage
            uri={comment.author?.isDeletedUser ? null : comment.author?.avatarUrl}
            fallback={APP_ICON}
            style={{ width: THREAD_AVATAR, height: THREAD_AVATAR, borderRadius: THREAD_AVATAR / 2 }}
          />
        </Pressable>
        <View style={styles.nameRow}>
          <T
            variant="caption"
            style={{ fontWeight: '700', color: tokens.textPrimary }}
            numberOfLines={1}
          >
            {authorDisplayName(comment.author, t)}
          </T>
          <T variant="micro" muted style={{ marginLeft: spacing.xs }} numberOfLines={1}>
            · {formatRelativeShort(comment.createdAt, t, resolvedLocale)}
            {comment.isEdited && !tombstone ? ` · ${t('comments:edited')}` : ''}
          </T>
        </View>
      </View>

      {/* Body + attachments — aligned with the username (full-width for the post). */}
      <View style={{ marginLeft: depth > 0 ? THREAD_CONTENT_INDENT : 0 }}>
        {tombstone ? (
          <T variant="body" muted style={[styles.body, { fontStyle: 'italic' }]}>
            {t('comments:deleted')}
          </T>
        ) : comment.body ? (
          <TranslatableContent
            id={comment.reviewId ?? comment.id}
            kind={comment.kind === 'review' ? 'review' : 'comment'}
            content={
              comment.content ?? {
                original: comment.body,
                format: 'plain',
                eligible: false,
              }
            }
            style={styles.body}
          />
        ) : null}

        {!tombstone ? <CommentMedia image={comment.image} gifUrl={comment.gifUrl} /> : null}

        {!tombstone && comment.media ? (
          <Pressable
            onPress={() => openMedia(comment.media!)}
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

        {!tombstone && comment.list ? (
          <Pressable
            onPress={() => openList(comment.list!)}
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
      </View>

      {/* Action row: ⊖/⊕ centered on the avatar-center thread line, then like/reply/⋯.
          (The post has no line — its actions render flush left, full width.) */}
      <View
        style={[
          styles.actions,
          { marginLeft: 0 },
          !showCollapse && depth > 0 ? { paddingLeft: AVATAR_CX + 12 } : null,
        ]}
      >
        {showCollapse ? (
          <Pressable
            onPress={() => handlers.onToggleCollapse?.(comment)}
            hitSlop={8}
            style={[styles.collapseBtn, { backgroundColor: tokens.background }]}
            accessibilityRole="button"
            accessibilityLabel={t(collapsed ? 'comments:expandThread' : 'comments:collapseThread')}
          >
            <Ionicons
              name={collapsed ? 'add-circle-outline' : 'remove-circle-outline'}
              size={20}
              color={tokens.textMuted}
            />
          </Pressable>
        ) : null}
        <Pressable
          onPress={() => {
            if (!tombstone) handlers.onLike(comment);
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
        {handlers.onReply && !tombstone ? (
          <Pressable
            onPress={() => handlers.onReply?.(comment)}
            hitSlop={8}
            style={styles.actionBtn}
            accessibilityRole="button"
            accessibilityLabel={t('comments:reply')}
          >
            <Ionicons name="chatbubble-outline" size={18} color={tokens.textMuted} />
            <T variant="micro" muted style={{ marginLeft: 4 }}>
              {t('comments:reply')}
            </T>
          </Pressable>
        ) : null}
        <Pressable
          onPress={() => handlers.onOverflow(comment)}
          hitSlop={10}
          style={styles.actionBtn}
          accessibilityRole="button"
          accessibilityLabel={t('common:moreOptions')}
        >
          <Ionicons name="ellipsis-horizontal" size={20} color={tokens.textMuted} />
        </Pressable>
      </View>
    </View>
  );
}

export interface ThreadNodeProps {
  node: CommentDto;
  depth: number;
  /** Last child of its parent — the parent's line ends at this node's avatar. */
  isLast?: boolean;
  childrenOf: Map<string, CommentDto[]>;
  collapsed: ReadonlySet<string>;
  expanded: Record<string, ExpandedNode | undefined>;
  handlers: ThreadHandlers;
  /** Comment id to highlight (notification deep-link), matched at any depth. */
  highlightId?: string | null;
}

/**
 * One comment + its nested replies (Reddit-style recursive tree).
 *
 * Geometry: the node is offset one gutter (28px) from its parent. Its own thread
 * line runs at the avatar's CENTER x, emerging from the avatar's bottom — and
 * only exists while the comment has visible replies (leaf comments get no line).
 * Depth-2+ nodes get a rounded elbow from the parent's line into the avatar.
 * Top-level comments are independent (the post is NOT treated as a parent: no
 * root line, no elbow). The parent's line ends at its last child's avatar via a
 * background mask. Lines render before the content so icons mask them on top.
 */
export function ThreadNode({
  node,
  depth,
  isLast = false,
  childrenOf,
  collapsed,
  expanded,
  handlers,
  highlightId,
}: ThreadNodeProps) {
  const { tokens } = useAppearance();
  const isCollapsed = collapsed.has(node.id);

  // Collapsed: subtree hidden entirely — no children, no line, no "show more".
  const kids = isCollapsed ? [] : (childrenOf.get(node.id) ?? []);
  const remaining = isCollapsed ? 0 : Math.max(0, node.repliesCount - kids.length);
  const showKids = kids.length > 0 || remaining > 0;
  const hasParentLine = depth >= 2;

  return (
    // Depth-1 nodes render flush to the left edge (no parent line, no elbow — the
    // gutter would be dead space); every deeper level indents one gutter.
    <View style={[styles.node, { marginLeft: hasParentLine ? THREAD_GUTTER : 0 }]}>
      {/* Last child: mask the parent's line below the point where the elbow's arc
          leaves it (arc start = CENTER_Y - R + 2), so the line ends exactly at the curve. */}
      {isLast && hasParentLine ? (
        <View
          style={[
            styles.lineMask,
            {
              backgroundColor: tokens.background,
              left: PARENT_LINE_LEFT - 1,
              top: THREAD_CENTER_Y - THREAD_ELBOW_R + 2,
              bottom: 0,
            },
          ]}
        />
      ) : null}
      {/* Elbow: rounded connector from the parent's line into the avatar's center. */}
      {hasParentLine ? (
        <View
          style={[
            styles.elbow,
            {
              borderColor: tokens.border,
              left: PARENT_LINE_LEFT,
              top: THREAD_CENTER_Y - THREAD_ELBOW_R,
              // From the parent's line to just past the avatar's center (the end
              // is hidden behind the circular avatar, so the curve "plugs into" it).
              width: AVATAR_CX + 2 - PARENT_LINE_LEFT,
              height: THREAD_ELBOW_R + 2,
            },
          ]}
        />
      ) : null}
      {/* Own line: avatar bottom center → element bottom (→ the ⊕ icon's center when
          collapsed, so the marker stays connected to the avatar). Only while replies
          show or the comment is collapsed with replies. Rendered BEFORE the content
          so the collapse icon masks it on top. */}
      {showKids || (isCollapsed && node.repliesCount > 0) ? (
        <View
          style={[
            styles.vline,
            {
              backgroundColor: tokens.border,
              left: OWN_LINE_LEFT,
              top: THREAD_ROW_PAD_TOP + THREAD_AVATAR,
              bottom: isCollapsed ? 12 : 0,
            },
          ]}
        />
      ) : null}

      <NodeContent
        comment={node}
        depth={depth}
        collapsed={isCollapsed}
        handlers={handlers}
        highlighted={node.id === highlightId}
      />

      {/* Nested children + the "show more" row. */}
      {kids.map((kid, i) => (
        <ThreadNode
          key={kid.id}
          node={kid}
          depth={depth + 1}
          isLast={i === kids.length - 1 && remaining === 0}
          childrenOf={childrenOf}
          collapsed={collapsed}
          expanded={expanded}
          handlers={handlers}
          highlightId={highlightId}
        />
      ))}
      {showKids && remaining > 0 ? (
        <ThreadMoreRow
          node={node}
          remaining={remaining}
          loading={!!expanded[node.id]?.loading}
          handlers={handlers}
        />
      ) : null}
    </View>
  );
}

interface ThreadMoreRowProps {
  node: CommentDto;
  remaining: number;
  loading: boolean;
  handlers: ThreadHandlers;
}

/** "Show more replies (N)" row — its marker sits on the parent's avatar-center line. */
function ThreadMoreRow({ node, remaining, loading, handlers }: ThreadMoreRowProps) {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['comments']);

  return (
    <Pressable
      onPress={() => {
        if (!loading) handlers.onLoadMore(node);
      }}
      style={styles.moreRow}
      accessibilityRole="button"
    >
      {/* The parent's line ends at the marker — mask it below the icon. */}
      <View
        style={[
          styles.lineMask,
          { backgroundColor: tokens.background, left: OWN_LINE_LEFT - 1, top: 16, bottom: 0 },
        ]}
      />
      <View
        style={[
          styles.moreIconWrap,
          { backgroundColor: tokens.background, left: OWN_LINE_LEFT - 8 },
        ]}
      >
        <Ionicons
          name={loading ? 'hourglass-outline' : 'add-circle-outline'}
          size={18}
          color={tokens.primary}
        />
      </View>
      <T
        variant="caption"
        style={[styles.moreLabel, { color: tokens.primary, marginLeft: THREAD_GUTTER }]}
      >
        {loading ? t('comments:loadingMore') : t('comments:showMoreReplies', { count: remaining })}
      </T>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  node: { position: 'relative' },
  vline: { position: 'absolute', width: 2 },
  lineMask: { position: 'absolute', width: 4 },
  elbow: {
    position: 'absolute',
    borderLeftWidth: 2,
    borderBottomWidth: 2,
    borderBottomLeftRadius: THREAD_ELBOW_R,
    backgroundColor: 'transparent',
  },
  content: { flex: 1, paddingTop: THREAD_ROW_PAD_TOP, paddingBottom: 2 },
  headerRow: { flexDirection: 'row', alignItems: 'center' },
  nameRow: { flexDirection: 'row', alignItems: 'baseline', marginLeft: spacing.sm, flex: 1 },
  body: { marginTop: spacing.xs, lineHeight: 20 },
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
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, marginTop: spacing.xs },
  actionBtn: { flexDirection: 'row', alignItems: 'center' },
  // Centered ON the avatar-center thread line (icon is 20px wide). The background
  // color masks the line passing behind it, like Reddit's ⊖/⊕.
  collapseBtn: { marginLeft: AVATAR_CX - 10 },
  moreRow: { flexDirection: 'row', alignItems: 'center', minHeight: 32, position: 'relative' },
  moreIconWrap: { position: 'absolute', width: 18, height: 18, top: 7 },
  moreLabel: { fontWeight: '700' },
});
