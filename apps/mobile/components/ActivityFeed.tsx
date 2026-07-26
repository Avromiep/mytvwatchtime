import React, { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { FeedItemDto } from '@tvwatch/shared';
import { useFeed } from '../api/hooks';
import { useAppearance } from '../context/PreferencesProvider';
import { APP_ICON, EmptyState, PosterImage, Spinner, T } from './primitives';
import { formatRelativeShort } from './comments/thread-utils';
import { REACTION_META, type ReactionTypeKey } from './voting/meta';
import { radius, spacing } from '../theme/theme';

const AVATAR = 36;
const POSTER_W = 44;
const POSTER_H = 64;
/** Runs of ≥COLLAPSE_RUN consecutive activities by the same user collapse behind a
 *  "see more" row that shows the first VISIBLE_IN_RUN items only. */
const COLLAPSE_RUN = 4;
const VISIBLE_IN_RUN = 3;

type FeedRow =
  | { kind: 'item'; key: string; item: FeedItemDto }
  | { kind: 'more'; key: string; user: FeedItemDto['user']; hidden: FeedItemDto[] };

/** Collapse consecutive same-user runs of ≥COLLAPSE_RUN (computed per page). */
function buildRows(items: FeedItemDto[]): FeedRow[] {
  const rows: FeedRow[] = [];
  let i = 0;
  while (i < items.length) {
    let j = i + 1;
    while (j < items.length && items[j].user.id === items[i].user.id) j++;
    const run = items.slice(i, j);
    const visible = run.length >= COLLAPSE_RUN ? run.slice(0, VISIBLE_IN_RUN) : run;
    for (const item of visible) rows.push({ kind: 'item', key: item.id, item });
    if (run.length >= COLLAPSE_RUN)
      rows.push({
        kind: 'more',
        key: `more:${run[0].id}`,
        user: run[0].user,
        hidden: run.slice(VISIBLE_IN_RUN),
      });
    i = j;
  }
  return rows;
}

/** "{name} watched {title} · S02E05"-style line, localized per activity type. */
function activityLine(item: FeedItemDto, t: TFunction): string {
  const name = item.user.displayName ?? item.user.username;
  const d = item.detail;
  const title =
    item.media.title +
    (d?.seasonNumber != null && d?.episodeNumber != null
      ? ` · S${String(d.seasonNumber).padStart(2, '0')}E${String(d.episodeNumber).padStart(2, '0')}`
      : '');
  switch (item.type) {
    case 'WATCHED':
      return t('feed:watched', { name, title });
    case 'WATCHLISTED':
      return t('feed:watchlisted', { name, title });
    case 'FAVORITED':
      return t('feed:favorited', { name, title });
    case 'RATED':
      return t('feed:rated', { name, title, value: d?.rating });
    case 'REACTED': {
      const meta = d?.reaction ? REACTION_META[d.reaction as ReactionTypeKey] : undefined;
      return t('feed:reacted', { name, title, reaction: meta?.emoji ?? d?.reaction ?? '' });
    }
    case 'COMMENTED':
      return t('feed:commented', { name, title });
  }
}

function FeedItemRow({
  item,
  t,
  resolvedLocale,
}: {
  item: FeedItemDto;
  t: TFunction;
  resolvedLocale: string;
}) {
  const { tokens } = useAppearance();
  const openMedia = () =>
    router.push(
      (item.media.type === 'SHOW' ? `/show/${item.media.id}` : `/movie/${item.media.id}`) as any,
    );
  return (
    <Pressable
      onPress={openMedia}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: tokens.surfaceAlt }]}
      accessibilityRole="button"
      accessibilityLabel={activityLine(item, t)}
    >
      <Pressable
        onPress={(e) => {
          e.stopPropagation();
          router.push(`/user/${item.user.username}` as any);
        }}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={item.user.displayName ?? item.user.username}
      >
        <PosterImage
          uri={item.user.avatarUrl}
          fallback={APP_ICON}
          transition={0}
          style={{ width: AVATAR, height: AVATAR, borderRadius: AVATAR / 2 }}
        />
      </Pressable>
      <View style={styles.rowBody}>
        <T variant="body" numberOfLines={2}>
          {activityLine(item, t)}
        </T>
        {/* Spoiler comments: the excerpt is masked server-side — show the same
            spoiler treatment as the comments feed instead. */}
        {item.spoiler ? (
          <View style={styles.spoilerRow}>
            <Ionicons name="eye-off-outline" size={13} color={tokens.orange} />
            <T variant="micro" style={{ color: tokens.orange, marginLeft: 4, fontWeight: '700' }}>
              {t('comments:spoilerWarning')}
            </T>
          </View>
        ) : item.detail?.excerpt ? (
          <T variant="caption" muted numberOfLines={2} style={{ marginTop: 2 }}>
            {item.detail.excerpt}
          </T>
        ) : null}
        <T variant="micro" muted style={{ marginTop: 2 }}>
          {formatRelativeShort(item.createdAt, t, resolvedLocale)}
        </T>
      </View>
      <PosterImage
        uri={item.media.posterUrl}
        transition={0}
        style={{ width: POSTER_W, height: POSTER_H, borderRadius: radius.sm }}
      />
    </Pressable>
  );
}

/** Explore "Feed" tab: activity of the viewer + their followings, newest first. */
export function ActivityFeed() {
  const { tokens, resolvedLocale } = useAppearance();
  const { t } = useTranslation(['feed', 'comments', 'common']);
  const feed = useFeed();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const rows = useMemo(
    () => (feed.data?.pages ?? []).flatMap((p) => buildRows(p.items ?? [])),
    [feed.data],
  );

  if (feed.isLoading) return <Spinner />;

  return (
    <FlatList
      data={rows}
      keyExtractor={(r) => r.key}
      contentContainerStyle={{ paddingHorizontal: spacing.sm, paddingBottom: spacing.xl }}
      ListEmptyComponent={
        <EmptyState
          icon="people-outline"
          title={t('feed:emptyTitle')}
          subtitle={t('feed:emptySubtitle')}
        />
      }
      onEndReached={() => {
        if (feed.hasNextPage && !feed.isFetchingNextPage) feed.fetchNextPage();
      }}
      onEndReachedThreshold={0.6}
      initialNumToRender={15}
      maxToRenderPerBatch={15}
      windowSize={7}
      ListFooterComponent={feed.isFetchingNextPage ? <Spinner /> : null}
      renderItem={({ item: row }) => {
        if (row.kind === 'item')
          return <FeedItemRow item={row.item} t={t} resolvedLocale={resolvedLocale} />;
        if (expanded[row.key])
          return (
            <View>
              {row.hidden.map((item) => (
                <FeedItemRow key={item.id} item={item} t={t} resolvedLocale={resolvedLocale} />
              ))}
            </View>
          );
        return (
          <Pressable
            onPress={() => setExpanded((s) => ({ ...s, [row.key]: true }))}
            style={({ pressed }) => [
              styles.moreBtn,
              { backgroundColor: tokens.surface },
              pressed && { backgroundColor: tokens.surfaceAlt },
            ]}
            accessibilityRole="button"
          >
            <T variant="caption" style={{ color: tokens.primary, fontWeight: '700' }}>
              {t('feed:seeMoreFrom', { name: row.user.displayName ?? row.user.username })}
            </T>
            <Ionicons name="chevron-down" size={14} color={tokens.primary} style={{ marginLeft: 4 }} />
          </Pressable>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
  },
  rowBody: { flex: 1, marginHorizontal: spacing.sm },
  spoilerRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
  moreBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    marginVertical: spacing.xs,
  },
});
