import React, { useState } from 'react';
import { FlatList, KeyboardAvoidingView, Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { CommentDto } from '@tvwatch/shared';
import { Header } from '../Header';
import { EmptyState, Screen, Spinner, T } from '../primitives';
import { SortBar } from './SortBar';
import { CommentCard } from './CommentCard';
import { CommentComposer } from './CommentComposer';
import { CommentEditDialog } from './CommentEditDialog';
import { useCommentActions } from './useCommentActions';
import { feedColumn } from './layout';
import { threadContextLabel } from './thread-utils';
import {
  useCommentsFeed,
  useMe,
  useToggleCommentLike,
  useToggleExternalReviewLike,
  type CommentSortMode,
} from '../../api/hooks';
import { useAppearance } from '../../context/PreferencesProvider';
import { spacing } from '../../theme/theme';
import { showError } from '../../lib/dialog';

/** Full comment feed screen body for any thread (media or community group). */
export function CommentsFeed({
  threadType,
  threadId,
  title,
}: {
  threadType: string;
  threadId: string;
  title: string;
}) {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['comments', 'common', 'groups']);

  const [sort, setSort] = useState<CommentSortMode>('LATEST');
  const [editing, setEditing] = useState<CommentDto | null>(null);

  const { data: me } = useMe();
  const currentUserId = me?.id;
  const feed = useCommentsFeed({ threadType, threadId, sort, polling: true });
  const like = useToggleCommentLike();
  const reviewLike = useToggleExternalReviewLike();
  const { openOverflow } = useCommentActions({ onEdit: setEditing });

  const items: CommentDto[] = feed.data?.pages.flatMap((p) => p.items) ?? [];
  const total = feed.data?.pages[0]?.total ?? 0;
  const isFetchingNextPage = feed.isFetchingNextPage;
  // Header names the thread (show/movie/episode title, localized group name) once the
  // first page arrives; the caller-provided title is the fallback.
  const threadCtx = feed.data?.pages[0]?.thread;
  const headerTitle = threadCtx ? threadContextLabel(threadCtx, t) || title : title;

  // Reviews are first-class thread roots: they open their own thread page and like
  // through the review endpoint; everything else behaves like a normal comment card.
  const openThread = (c: CommentDto) =>
    c.kind === 'review'
      ? router.push(`/review/${c.reviewId}` as any)
      : router.push(`/comment/${c.id}` as any);
  const handleLike = (c: CommentDto) =>
    c.kind === 'review'
      ? reviewLike.mutate({ reviewId: c.reviewId!, liked: c.likedByMe })
      : like.mutate({ commentId: c.id, liked: c.likedByMe });
  const openAuthor = (c: CommentDto) =>
    c.kind !== 'review' &&
    c.author?.username &&
    router.push(`/user/${encodeURIComponent(c.author.username)}` as any);

  const renderItem = ({ item }: { item: CommentDto }) => (
    <CommentCard
      comment={item}
      isOwner={item.author?.id === currentUserId}
      onLike={handleLike}
      onOpenThread={openThread}
      onOverflow={(c) => openOverflow(c, c.author?.id === currentUserId)}
      onPressAuthor={openAuthor}
      showReplyAction
      interactive
    />
  );

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: tokens.background }}
      behavior="padding"
    >
      <Screen style={{ flex: 1 }}>
        <Header title={headerTitle} showBack />

        {/* Centered feed column: full-width on mobile, capped + centered on desktop/tablet. */}
        <View style={[feedColumn.root, { flex: 1 }]}>
          <View style={{ paddingHorizontal: spacing.lg }}>
            <SortBar
              sort={sort}
              onChange={setSort}
              total={total}
              totalLabel={(n) =>
                `${n} ${t(n === 1 ? 'comments:commentSingular' : 'comments:commentPlural', { count: n })}`
              }
            />
          </View>

          {feed.isLoading ? (
            <Spinner />
          ) : feed.isError ? (
            <View style={{ padding: spacing.xl, alignItems: 'center' }}>
              <T variant="body" muted style={{ marginBottom: spacing.md }}>
                {t('comments:failedToLoad')}
              </T>
              <Pressable onPress={() => feed.refetch()} hitSlop={8}>
                <T variant="caption" style={{ color: tokens.primary, fontWeight: '700' }}>
                  {t('comments:retry')}
                </T>
              </Pressable>
            </View>
          ) : (
            <FlatList
              style={{ flex: 1 }}
              data={items}
              keyExtractor={(i) => i.id}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{
                paddingHorizontal: spacing.lg,
                paddingBottom: spacing.xl,
                flexGrow: 1,
              }}
              ListEmptyComponent={
                <EmptyState
                  title={t('comments:noComments')}
                  subtitle={t('comments:beFirst')}
                  icon="chatbubble-ellipses-outline"
                />
              }
              ListFooterComponent={
                isFetchingNextPage ? (
                  <View style={{ paddingVertical: spacing.md, alignItems: 'center' }}>
                    <T variant="micro" muted>
                      {t('comments:loadingMore')}
                    </T>
                  </View>
                ) : items.length > 0 && !feed.hasNextPage ? (
                  <T variant="micro" muted style={{ textAlign: 'center', marginTop: spacing.md }}>
                    {t('comments:reachedEnd')}
                  </T>
                ) : null
              }
              onEndReached={() => {
                if (feed.hasNextPage && !isFetchingNextPage && !feed.isError)
                  feed
                    .fetchNextPage()
                    .catch(() => showError({ description: t('comments:failedToLoad') }));
              }}
              onEndReachedThreshold={0.4}
              ItemSeparatorComponent={() => <View style={{ height: spacing.md }} />}
              renderItem={renderItem}
            />
          )}
        </View>

        <CommentComposer
          threadType={threadType}
          threadId={threadId}
          parentId={null}
          placeholder={t('comments:addComment')}
        />
        <CommentEditDialog comment={editing} onClose={() => setEditing(null)} />
      </Screen>
    </KeyboardAvoidingView>
  );
}
