import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Pressable, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { CommentDto, Paginated } from '@tvwatch/shared';
import { Header } from '../../components/Header';
import { EmptyState, Screen, Spinner, T } from '../../components/primitives';
import { SortBar } from '../../components/comments/SortBar';
import { CommentCard } from '../../components/comments/CommentCard';
import { NodeContent, ThreadNode, type ThreadHandlers } from '../../components/comments/ThreadNode';
import { CommentComposer } from '../../components/comments/CommentComposer';
import { CommentEditDialog } from '../../components/comments/CommentEditDialog';
import { useCommentActions } from '../../components/comments/useCommentActions';
import { feedColumn } from '../../components/comments/layout';
import {
  buildChildrenMap,
  threadContextLabel,
  type ExpandedNode,
} from '../../components/comments/thread-utils';
import {
  useComment,
  useCommentReplies,
  useMe,
  useToggleCommentLike,
  useToggleExternalReviewLike,
  type CommentSortMode,
} from '../../api/hooks';
import { api } from '../../api/client';
import { useAppearance } from '../../context/PreferencesProvider';
import { spacing } from '../../theme/theme';
import { showError } from '../../lib/dialog';

export default function CommentThreadScreen() {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['comments', 'common', 'groups']);
  const params = useLocalSearchParams<{ id: string; highlight?: string }>();
  const id = params.id;

  const [sort, setSort] = useState<CommentSortMode>('LATEST');
  const [editing, setEditing] = useState<CommentDto | null>(null);
  // Reddit-style thread state: collapsed sub-threads, inline-expanded subtrees,
  // and the comment the composer is currently replying to (null = thread root).
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<Record<string, ExpandedNode>>({});
  const [replyTarget, setReplyTarget] = useState<CommentDto | null>(null);
  // Transient highlight from a notification deep-link (?highlight=<commentId>), cleared after 2s.
  const [highlightId, setHighlightId] = useState<string | null>(params.highlight ?? null);
  const listRef = useRef<FlatList<CommentDto>>(null);
  const didScrollToHighlight = useRef(false);

  useEffect(() => {
    if (!highlightId) return;
    const timer = setTimeout(() => setHighlightId(null), 2000);
    return () => clearTimeout(timer);
  }, [highlightId]);

  const { data: me } = useMe();
  const currentUserId = me?.id;
  const parentQ = useComment(id, true);
  const parent = parentQ.data;

  const replies = useCommentReplies(id, sort, { polling: true, depth: 2 });
  const like = useToggleCommentLike();
  const reviewLike = useToggleExternalReviewLike();
  const { openOverflow } = useCommentActions({ onEdit: setEditing });

  const rootItems = useMemo(
    () => replies.data?.pages.flatMap((p) => p.items) ?? [],
    [replies.data],
  );
  const repliesTotal = replies.data?.pages[0]?.total ?? parent?.repliesCount ?? 0;
  const isFetchingNextPage = replies.isFetchingNextPage;

  const { childrenOf, byId } = useMemo(
    () => buildChildrenMap(rootItems, expanded),
    [rootItems, expanded],
  );
  const topLevel = useMemo(() => childrenOf.get(id) ?? [], [childrenOf, id]);

  // Scroll a highlighted top-level reply into view (header highlight needs no scroll).
  useEffect(() => {
    if (!highlightId || highlightId === id || didScrollToHighlight.current) return;
    const index = topLevel.findIndex((c) => c.id === highlightId);
    if (index < 0) return;
    didScrollToHighlight.current = true;
    listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.3 });
  }, [highlightId, id, topLevel]);

  /** "Show more replies": inline-expand the next page of a node's children (appended). */
  const loadMore = useCallback(
    async (node: CommentDto) => {
      const nextPage = (expanded[node.id]?.page ?? 0) + 1;
      setExpanded((prev) => ({
        ...prev,
        [node.id]: {
          items: prev[node.id]?.items ?? [],
          loading: true,
          page: prev[node.id]?.page ?? 0,
        },
      }));
      try {
        const res = await api.get<Paginated<CommentDto>>(`/comments/${node.id}/replies`, {
          page: nextPage,
          pageSize: 50,
          sort,
          depth: 2,
        });
        setExpanded((prev) => ({
          ...prev,
          [node.id]: {
            items: [...(prev[node.id]?.items ?? []), ...res.items],
            loading: false,
            page: nextPage,
          },
        }));
      } catch {
        setExpanded((prev) => ({
          ...prev,
          [node.id]: {
            items: prev[node.id]?.items ?? [],
            loading: false,
            page: prev[node.id]?.page ?? 0,
          },
        }));
        showError({ description: t('comments:failedToLoad') });
      }
    },
    [expanded, sort, t],
  );

  const toggleCollapse = useCallback((c: CommentDto) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(c.id)) next.delete(c.id);
      else next.add(c.id);
      return next;
    });
  }, []);

  /** Optimistically patch a comment inside locally expanded subtrees (RQ caches are patched by the mutation). */
  const patchExpanded = useCallback((commentId: string, patch: (c: CommentDto) => CommentDto) => {
    setExpanded((prev) => {
      let changed = false;
      const next: Record<string, ExpandedNode> = {};
      for (const [k, v] of Object.entries(prev)) {
        const items = v.items.map((c) => (c.id === commentId ? patch(c) : c));
        if (items.some((c, i) => c !== v.items[i])) changed = true;
        next[k] = { ...v, items };
      }
      return changed ? next : prev;
    });
  }, []);

  const handleLike = useCallback(
    (c: CommentDto) => {
      const liked = c.likedByMe;
      patchExpanded(c.id, (x) => ({
        ...x,
        likedByMe: !liked,
        likesCount: Math.max(0, x.likesCount + (liked ? -1 : 1)),
      }));
      like.mutate(
        { commentId: c.id, liked },
        {
          onError: () =>
            patchExpanded(c.id, (x) => ({
              ...x,
              likedByMe: liked,
              likesCount: Math.max(0, x.likesCount + (liked ? 1 : -1)),
            })),
        },
      );
    },
    [like, patchExpanded],
  );

  /** After sending: reset the composer target; make a non-root reply appear right away. */
  const handleSent = useCallback(async () => {
    const target = replyTarget;
    setReplyTarget(null);
    if (target && target.id !== id) {
      // Re-fetch the target's subtree so the new reply shows without waiting for the poll.
      const fresh = byId.get(target.id) ?? target;
      await loadMore(fresh);
    }
  }, [replyTarget, id, byId, loadMore]);

  const isOwner = useCallback(
    (c?: CommentDto | null) => !!c && c.author?.id === currentUserId,
    [currentUserId],
  );
  const openAuthor = useCallback(
    (c: CommentDto) =>
      c.author?.username && router.push(`/user/${encodeURIComponent(c.author.username)}` as any),
    [],
  );

  const handlers: ThreadHandlers = useMemo(
    () => ({
      onLike: handleLike,
      onOverflow: (c: CommentDto) => openOverflow(c, isOwner(c)),
      onPressAuthor: openAuthor,
      onReply: (c: CommentDto) => setReplyTarget(c),
      onToggleCollapse: toggleCollapse,
      onLoadMore: loadMore,
      isOwner,
    }),
    [handleLike, openOverflow, isOwner, openAuthor, toggleCollapse, loadMore],
  );

  const renderNode = ({ item }: { item: CommentDto }) => (
    <ThreadNode
      node={item}
      depth={1}
      childrenOf={childrenOf}
      collapsed={collapsed}
      expanded={expanded}
      handlers={handlers}
      highlightId={highlightId}
    />
  );

  const ListHeader = parent ? (
    <View style={{ paddingBottom: spacing.sm }}>
      {/* Review parent: this comment replies to a provider review — show it (with the
          TMDB badge) above the reply; tapping it opens the full review thread. */}
      {parent.review ? (
        <View style={{ marginBottom: spacing.sm }}>
          <CommentCard
            comment={parent.review}
            isOwner={false}
            onLike={(c) => reviewLike.mutate({ reviewId: c.reviewId!, liked: c.likedByMe })}
            onOpenThread={(c) => router.push(`/review/${c.reviewId}` as any)}
            onOverflow={() => undefined}
            showReplyAction={false}
            interactive
          />
        </View>
      ) : null}
      {/* Ancestor chain (root-first) when this comment is a reply — deep links from
          "My Comments" show the parents above the target comment. */}
      {(parent.ancestors ?? []).map((a) => (
        <View key={a.id} style={{ opacity: 0.75 }}>
          <NodeContent comment={a} depth={0} collapsed={false} handlers={handlers} />
        </View>
      ))}
      <NodeContent
        comment={parent}
        depth={0}
        collapsed={false}
        handlers={handlers}
        highlighted={parent.id === highlightId}
      />
      <View style={{ paddingTop: spacing.sm, paddingLeft: spacing.xs }}>
        <SortBar
          sort={sort}
          onChange={setSort}
          total={repliesTotal}
          totalLabel={(n) =>
            `${n} ${t(n === 1 ? 'comments:replySingular' : 'comments:replyPlural', { count: n })}`
          }
        />
      </View>
    </View>
  ) : null;

  const headerTitle = parent?.context
    ? threadContextLabel(parent.context, t) || t('comments:threadTitle')
    : t('comments:threadTitle');

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: tokens.background }}
      behavior="padding"
    >
      <Screen style={{ flex: 1 }}>
        <Header
          title={headerTitle}
          showBack
          right={
            parent ? (
              // Compact text action (not the pill Button): the 48dp button would grow the
              // 40dp header row and push the back arrow down a few pixels.
              <Pressable
                onPress={() =>
                  router.push(
                    `/comments?type=${parent.threadType}&threadId=${encodeURIComponent(parent.threadId)}` as any,
                  )
                }
                hitSlop={8}
                accessibilityRole="button"
              >
                <T variant="caption" style={{ color: tokens.primary, fontWeight: '700' }}>
                  {t('comments:viewFullThread')}
                </T>
              </Pressable>
            ) : undefined
          }
        />

        {/* Centered column (same max-width as the main feed). */}
        <View style={[feedColumn.root, { flex: 1 }]}>
          {parentQ.isLoading ? (
            <Spinner />
          ) : parentQ.isError || !parent ? (
            <EmptyState title={t('comments:failedToLoad')} icon="alert-circle-outline" />
          ) : (
            <FlatList
              ref={listRef}
              style={{ flex: 1 }}
              data={topLevel}
              keyExtractor={(c) => c.id}
              keyboardShouldPersistTaps="handled"
              onScrollToIndexFailed={({ averageItemLength, index }) =>
                listRef.current?.scrollToOffset({
                  offset: (averageItemLength || 120) * index,
                  animated: true,
                })
              }
              contentContainerStyle={{
                paddingHorizontal: spacing.sm,
                paddingBottom: spacing.xl,
                flexGrow: 1,
              }}
              ListHeaderComponent={ListHeader}
              ListEmptyComponent={
                replies.isLoading ? null : (
                  <EmptyState
                    title={t('comments:noReplies')}
                    subtitle={t('comments:beFirstToReply')}
                    icon="chatbubble-outline"
                  />
                )
              }
              ListFooterComponent={
                isFetchingNextPage ? (
                  <View style={{ paddingVertical: spacing.md, alignItems: 'center' }}>
                    <T variant="micro" muted>
                      {t('comments:loadingMore')}
                    </T>
                  </View>
                ) : topLevel.length > 0 && !replies.hasNextPage ? (
                  <T variant="micro" muted style={{ textAlign: 'center', marginTop: spacing.md }}>
                    {t('comments:reachedEnd')}
                  </T>
                ) : null
              }
              onEndReached={() => {
                if (replies.hasNextPage && !isFetchingNextPage && !replies.isError)
                  replies
                    .fetchNextPage()
                    .catch(() => showError({ description: t('comments:failedToLoad') }));
              }}
              onEndReachedThreshold={0.4}
              renderItem={renderNode}
            />
          )}
        </View>

        {parent ? (
          <CommentComposer
            threadType={parent.threadType}
            threadId={parent.threadId}
            parentId={replyTarget?.id ?? parent.id}
            placeholder={t('comments:addReply')}
            replyTarget={replyTarget}
            onCancelReply={() => setReplyTarget(null)}
            onSent={handleSent}
          />
        ) : null}
        <CommentEditDialog comment={editing} onClose={() => setEditing(null)} />
      </Screen>
    </KeyboardAvoidingView>
  );
}
