import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';
import { Header } from '../components/Header';
import { NotificationItem } from '../components/cards';
import { Button, Chip, EmptyState, Screen, Spinner, T } from '../components/primitives';
import { useClearNotifications, useMarkNotificationRead, useNotifications } from '../api/hooks';
import { useAppearance } from '../context/PreferencesProvider';
import { navigateFromLink } from '../lib/announcement';
import { spacing } from '../theme/theme';
import { useTranslation } from 'react-i18next';

export default function NotificationsScreen() {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['notifications', 'common']);
  const [unreadOnly, setUnreadOnly] = useState(true);
  const { data, isLoading, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useNotifications({ unreadOnly });
  const mark = useMarkNotificationRead();
  const clear = useClearNotifications();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  }, [refetch]);
  const items = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data]);

  return (
    <Screen>
      <Header
        title={t('notifications:title')}
        showBack
        right={
          <Button
            title={unreadOnly ? t('notifications:markAll') : t('notifications:clearAll')}
            variant="ghost"
            onPress={() => (unreadOnly ? mark.mutate({ all: true }) : clear.mutate())}
            loading={unreadOnly ? mark.isPending : clear.isPending}
            disabled={items.length === 0}
            style={{ paddingHorizontal: spacing.sm }}
          />
        }
      />
      <View
        style={{ flexDirection: 'row', paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}
      >
        <Chip
          label={t('notifications:all')}
          active={!unreadOnly}
          onPress={() => setUnreadOnly(false)}
        />
        <Chip
          label={t('notifications:unread')}
          active={unreadOnly}
          onPress={() => setUnreadOnly(true)}
        />
      </View>
      {isLoading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState
          title={t('notifications:empty')}
          subtitle={t('notifications:emptyDesc')}
          icon="notifications-off-outline"
        />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
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
            if (hasNextPage && !isFetchingNextPage) fetchNextPage();
          }}
          onEndReachedThreshold={0.4}
          initialNumToRender={15}
          maxToRenderPerBatch={15}
          windowSize={7}
          ListFooterComponent={
            isFetchingNextPage ? (
              <View style={{ paddingVertical: spacing.md, alignItems: 'center' }}>
                <T variant="micro" muted>
                  {t('common:loading')}
                </T>
              </View>
            ) : null
          }
          renderItem={({ item }) => (
            <NotificationItem
              item={item}
              onPress={() => {
                if (!item.read) mark.mutate({ id: item.id });
                navigateFromLink(item.link);
              }}
            />
          )}
        />
      )}
    </Screen>
  );
}
