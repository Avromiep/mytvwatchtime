import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import type { MyCommentDto } from '@tvwatch/shared';
import { Header } from '../components/Header';
import { EmptyState, Screen, Spinner, T } from '../components/primitives';
import { useMyComments } from '../api/hooks';
import { useAppearance } from '../context/PreferencesProvider';
import { radius, spacing } from '../theme/theme';
import { formatRelativeShort } from '../components/comments/thread-utils';

const THREAD_ICONS = {
  SHOW: 'tv-outline',
  MOVIE: 'film-outline',
  EPISODE: 'play-circle-outline',
  GROUP: 'chatbubbles-outline',
} as const;

export default function MyCommentsScreen() {
  const { tokens, resolvedLocale } = useAppearance();
  const { t } = useTranslation(['comments', 'groups', 'common']);
  const query = useMyComments();
  const items = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await query.refetch();
    setRefreshing(false);
  }, [query]);

  const renderItem = ({ item }: { item: MyCommentDto }) => (
    <MyCommentRow item={item} onPress={() => router.push(`/comment/${item.id}`)} />
  );

  return (
    <Screen>
      <Header title={t('comments:myCommentsTitle')} showBack />
      {query.isLoading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState
          title={t('comments:myCommentsEmpty')}
          subtitle={t('comments:myCommentsEmptyDesc')}
          icon="chatbubbles-outline"
        />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(c) => c.id}
          contentContainerStyle={{ padding: spacing.lg }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              colors={[tokens.primary]}
              tintColor={tokens.primary}
            />
          }
          onEndReached={() => {
            if (query.hasNextPage && !query.isFetchingNextPage) query.fetchNextPage();
          }}
          onEndReachedThreshold={0.4}
          initialNumToRender={15}
          maxToRenderPerBatch={15}
          windowSize={7}
          ListFooterComponent={
            query.isFetchingNextPage ? (
              <View style={{ paddingVertical: spacing.md, alignItems: 'center' }}>
                <T variant="micro" muted>
                  {t('common:loading')}
                </T>
              </View>
            ) : null
          }
          renderItem={renderItem}
        />
      )}
    </Screen>
  );
}

function MyCommentRow({ item, onPress }: { item: MyCommentDto; onPress: () => void }) {
  const { tokens, resolvedLocale } = useAppearance();
  const { t } = useTranslation(['comments', 'groups']);
  const ctx = item.context;
  const icon = THREAD_ICONS[ctx?.threadType ?? item.threadType] ?? 'chatbubble-outline';
  const label = ctx
    ? ctx.threadType === 'GROUP'
      ? t(`groups:names.${ctx.groupId ?? ctx.label}`, { defaultValue: ctx.label })
      : ctx.label
    : '';

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        {
          backgroundColor: tokens.surface,
          borderRadius: radius.md,
          padding: spacing.md,
          marginBottom: spacing.sm,
          opacity: pressed ? 0.85 : 1,
        },
      ]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Ionicons name={icon} size={14} color={tokens.primary} />
        <T
          variant="caption"
          style={{ fontWeight: '700', color: tokens.primary, marginLeft: spacing.xs, flex: 1 }}
          numberOfLines={1}
        >
          {label}
          {ctx?.sublabel ? ` · ${ctx.sublabel}` : ''}
        </T>
        <T variant="micro" muted>
          {formatRelativeShort(item.createdAt, t, resolvedLocale)}
        </T>
      </View>
      {item.body ? (
        <T variant="body" numberOfLines={3} style={{ marginTop: spacing.xs }}>
          {item.body}
        </T>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: spacing.xs }}>
        <Ionicons name="heart-outline" size={12} color={tokens.textMuted} />
        <T variant="micro" muted style={{ marginLeft: 4, marginRight: spacing.md }}>
          {item.likesCount}
        </T>
        <Ionicons name="chatbubble-outline" size={12} color={tokens.textMuted} />
        <T variant="micro" muted style={{ marginLeft: 4 }}>
          {item.repliesCount}
        </T>
        <View style={{ flex: 1 }} />
        <Ionicons name="chevron-forward" size={14} color={tokens.textMuted} />
      </View>
    </Pressable>
  );
}
