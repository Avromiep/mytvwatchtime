import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { Header, IconButton } from '../../components/Header';
import { EpisodeCard, UpcomingCard } from '../../components/cards';
import { Chip, EmptyState, Screen, SectionHeader, Spinner } from '../../components/primitives';
import { InfoBanner } from '../../components/InfoBanner';
import { useMarkEpisodeWatched, useRewatchEpisode, useUpcoming, useWatchNext, useActiveAnnouncement } from '../../api/hooks';
import { useTabPressReset } from '../../hooks/useTabPressReset';
import { useDismissableFlag } from '../../hooks/useDismissableFlag';
import { pickLocale, runAnnouncementAction } from '../../lib/announcement';
import { useAppearance } from '../../context/PreferencesProvider';
import { useTranslation } from 'react-i18next';
import { spacing } from '../../theme/theme';
import { WatchNextBucket } from '@tvwatch/shared';

const VALID_ICONS = new Set([
  'information-circle-outline', 'megaphone-outline', 'download-outline', 'notifications-outline',
  'bulb-outline', 'gift-outline', 'star-outline', 'trophy-outline', 'flame-outline', 'sparkles-outline',
  'calendar-outline', 'pricetag-outline', 'film-outline', 'tv-outline', 'list-outline', 'people-outline',
  'chatbubble-outline', 'warning-outline', 'checkmark-circle-outline', 'rocket-outline',
]);

// Exact row heights power getItemLayout → initialScrollIndex lands on Watch Next
// precisely on mount (even before rows lay out), with zero post-mount programmatic
// scrolling — so marking a show never yanks the viewport, and the tab-reset remount
// (key={resetKey}) re-lands exactly like a fresh open.
const CARD_H = 98; // EpisodeCard: still 74 + padding sm×2 + marginBottom sm
const UPCOMING_H = 108; // UpcomingCard: poster 84 + padding sm×2 + marginBottom sm
const HEADER_H = 44; // SectionHeader (h1 18px + paddingVertical sm×2, bottom-aligned)

type WatchRow =
  | { type: 'spacer'; key: string; h: number }
  | { type: 'header'; key: string; bucket: string; h: number }
  | { type: 'card'; key: string; item: any; h: number };

type UpcomingRow =
  | { type: 'spacer'; key: string; h: number }
  | { type: 'header'; key: string; groupKey: string; h: number }
  | { type: 'card'; key: string; item: any; h: number };

export default function ShowsScreen() {
  const [tab, setTab] = useState<'watchlist' | 'upcoming'>('watchlist');
  const [resetKey, setResetKey] = useState(0);
  const { t, i18n } = useTranslation(['shows', 'navigation', 'common']);
  const { tokens } = useAppearance();
  const { data: announcement } = useActiveAnnouncement();
  const dismissKey = announcement ? `announcement:${announcement.id}:rev:${announcement.revision}` : null;
  const { visible: showAnnouncementBanner, dismiss: dismissAnnouncementBanner } = useDismissableFlag(dismissKey ?? '');
  useTabPressReset(() => {
    setTab('watchlist');
    setResetKey((k) => k + 1);
  });
  const showBanner = !!announcement && !!dismissKey && showAnnouncementBanner === true;
  return (
    <Screen>
      <Header
        title={t('shows:title')}
        right={
          <IconButton icon="notifications-outline" onPress={() => router.push('/notifications')} />
        }
      />
      <View style={styles.tabs}>
        <Chip label={t('shows:watchList')} active={tab === 'watchlist'} onPress={() => setTab('watchlist')} />
        <Chip label={t('shows:upcoming')} active={tab === 'upcoming'} onPress={() => setTab('upcoming')} />
      </View>
      {tab === 'watchlist' && showBanner && announcement ? (
        <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}>
          <InfoBanner
            icon={(VALID_ICONS.has(announcement.icon) ? announcement.icon : 'information-circle-outline') as any}
            title={pickLocale(announcement.title, i18n.language)}
            message={pickLocale(announcement.message, i18n.language)}
            actionLabel={announcement.actionLabel ? pickLocale(announcement.actionLabel, i18n.language) : undefined}
            onAction={announcement.action?.type !== 'none' ? () => runAnnouncementAction(announcement.action) : undefined}
            onClose={dismissAnnouncementBanner}
          />
        </View>
      ) : null}
      {tab === 'watchlist' ? <WatchList key={resetKey} /> : <Upcoming />}
    </Screen>
  );
}

function WatchList() {
  const { tokens } = useAppearance();
  const { data, isLoading, refetch, isRefetching } = useWatchNext();
  const { t } = useTranslation(['shows', 'common']);
  const BUCKET_LABELS: Record<string, string> = {
    [WatchNextBucket.WATCH_NEXT]: t('shows:watchNext'),
    [WatchNextBucket.NOT_RECENTLY]: t('shows:notRecently'),
    [WatchNextBucket.HISTORY]: t('shows:history'),
    [WatchNextBucket.START_WATCHING]: t('shows:startWatching'),
  };
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => { setRefreshing(true); await refetch(); setRefreshing(false); }, [refetch]);
  const mark = useMarkEpisodeWatched();
  const rewatch = useRewatchEpisode();

  // Flat rows (header / card) so the list virtualizes — a plain ScrollView rendered
  // EVERY card (300+ for heavy users) with no windowing, and fully re-rendered on
  // every mutation.
  const rows = useMemo<WatchRow[]>(() => {
    // Dedupe by episode id: an episode should appear at most once in the watchlist.
    // (Imports / double-marks can produce duplicate watch_history rows for the same episode.)
    const seenEpisode = new Set<string>();
    const items = (data?.items ?? []).filter((it) => {
      const k = it.episode.id;
      if (seenEpisode.has(k)) return false;
      seenEpisode.add(k);
      return true;
    });
    // History is always visible (scroll up to see it), auto-scroll lands on Watch Next
    const buckets = [WatchNextBucket.HISTORY, WatchNextBucket.WATCH_NEXT, WatchNextBucket.START_WATCHING, WatchNextBucket.NOT_RECENTLY];
    const out: WatchRow[] = [];
    for (const bucket of buckets) {
      const group = items.filter((i) => i.bucket === bucket);
      if (group.length === 0) continue;
      // History: oldest on top, latest at the bottom (right above Watch Next).
      const ordered = bucket === WatchNextBucket.HISTORY ? [...group].reverse() : group;
      out.push({ type: 'header', key: `h_${bucket}`, bucket });
      for (const it of ordered) {
        // Non-History cards are keyed by showId so an optimistic mark-watched swap
        // (episode E → nextEpisode) updates the same component in place instead of
        // remounting. History rows keep the episode key (a show can appear multiple
        // times in History → showId would collide).
        out.push({ type: 'card', key: bucket === WatchNextBucket.HISTORY ? `c_${it.episode.id}` : `c_${it.showId}`, item: it });
      }
    }
    return out;
  }, [data?.items]);

  const watchNextIndex = useMemo(
    () => rows.findIndex((r) => r.type === 'header' && r.bucket === WatchNextBucket.WATCH_NEXT),
    [rows],
  );

  const listRef = useRef<FlatList<WatchRow>>(null);
  // Landing on the Watch Next header: scrollToIndex only works once the rows above
  // have been laid out, and with hundreds of rows that takes several attempts. Retry
  // on every onScrollToIndexFailed (bounded), and stop as soon as the user scrolls.
  const landingState = useRef({ attempts: 0, cancelled: false });

  const tryLand = useCallback(() => {
    const st = landingState.current;
    if (st.cancelled || st.attempts >= 15 || watchNextIndex <= 0) return;
    st.attempts += 1;
    listRef.current?.scrollToIndex({ index: watchNextIndex, animated: false });
  }, [watchNextIndex]);

  useEffect(() => {
    const timer = setTimeout(tryLand, 100);
    return () => clearTimeout(timer);
  }, [tryLand]);

  const onScrollToIndexFailed = useCallback(({ index }: { index: number }) => {
    // Jump to an estimate so FlatList lays out the rows around the target, then retry.
    listRef.current?.scrollToOffset({ offset: index * 98, animated: false });
    setTimeout(tryLand, 180);
  }, [tryLand]);

  const cancelLanding = useCallback(() => { landingState.current.cancelled = true; }, []);

  const renderRow = useCallback(({ item: row, index }: { item: WatchRow; index: number }) => {
    if (row.type === 'header') {
      return (
        <View style={index > 0 ? { marginTop: spacing.lg } : undefined}>
          <SectionHeader title={BUCKET_LABELS[row.bucket]} />
        </View>
      );
    }
    const it = row.item;
    return (
      <EpisodeCard
        item={it}
        onMarkWatched={() => mark.mutate({ id: it.episode.id, on: true })}
        onRewatch={() => rewatch.mutate(it.episode.id)}
        onUnwatch={() => mark.mutate({ id: it.episode.id, on: false })}
      />
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mark, rewatch, t]);

  if (isLoading) return <Spinner />;
  if (rows.length === 0)
    return (
      <EmptyState
        title={t('shows:empty.watchlistTitle')}
        subtitle={t('shows:empty.watchlistSubtitle')}
        cta={t('shows:empty.browseShows')}
        onCta={() => router.push('/(tabs)/explore')}
        icon="tv-outline"
      />
    );

  return (
    <FlatList
      ref={listRef}
      data={rows}
      keyExtractor={(r) => r.key}
      renderItem={renderRow}
      contentContainerStyle={{ padding: spacing.lg }}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[tokens.primary]} tintColor={tokens.primary} />}
      initialNumToRender={15}
      maxToRenderPerBatch={12}
      windowSize={9}
      onScrollToIndexFailed={onScrollToIndexFailed}
      onScrollBeginDrag={cancelLanding}
      // Keep the viewport anchored when optimistic updates insert/remove History
      // rows above the visible area.
      maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
    />
  );
}

function Upcoming() {
  const { tokens } = useAppearance();
  const { data, isLoading, refetch } = useUpcoming();
  const { t } = useTranslation(['shows', 'common']);
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => { setRefreshing(true); await refetch(); setRefreshing(false); }, [refetch]);
  const groups = data?.groups ?? [];

  const UPCOMING_GROUP_KEYS: Record<string, string> = {
    TODAY: t('shows:today'),
    TOMORROW: t('shows:tomorrow'),
    THIS_WEEK: t('shows:thisWeek'),
    NEXT_WEEK: t('shows:nextWeek'),
    LATER: t('shows:later'),
  };

  // Flat rows (header / card) so the list virtualizes (up to 200 cards server-side).
  const rows = useMemo<UpcomingRow[]>(() => {
    const out: UpcomingRow[] = [];
    for (const g of groups) {
      if (!g.items?.length) continue;
      out.push({ type: 'header', key: `h_${g.key}`, groupKey: g.key });
      for (const it of g.items) out.push({ type: 'card', key: `c_${it.id}`, item: it });
    }
    return out;
  }, [groups]);

  const landingKey = ['TODAY', 'TOMORROW', 'THIS_WEEK'].find((k) => groups.some((g: any) => g.key === k));
  const landingIndex = useMemo(
    () => rows.findIndex((r) => r.type === 'header' && r.groupKey === landingKey),
    [rows, landingKey],
  );

  const listRef = useRef<FlatList<UpcomingRow>>(null);
  // Same landing strategy as WatchList: retry scrollToIndex while rows above the
  // target lay out, stop on user scroll.
  const landingState = useRef({ attempts: 0, cancelled: false });

  const tryLand = useCallback(() => {
    const st = landingState.current;
    if (st.cancelled || st.attempts >= 15 || landingIndex <= 0) return;
    st.attempts += 1;
    listRef.current?.scrollToIndex({ index: landingIndex, animated: false });
  }, [landingIndex]);

  useEffect(() => {
    const timer = setTimeout(tryLand, 100);
    return () => clearTimeout(timer);
  }, [tryLand]);

  const onScrollToIndexFailed = useCallback(({ index }: { index: number }) => {
    listRef.current?.scrollToOffset({ offset: index * 120, animated: false });
    setTimeout(tryLand, 180);
  }, [tryLand]);

  const cancelLanding = useCallback(() => { landingState.current.cancelled = true; }, []);

  const renderRow = useCallback(({ item: row, index }: { item: UpcomingRow; index: number }) => {
    if (row.type === 'header') {
      return (
        <View style={index > 0 ? { marginTop: spacing.lg } : undefined}>
          <SectionHeader title={UPCOMING_GROUP_KEYS[row.groupKey] ?? row.groupKey} />
        </View>
      );
    }
    return <UpcomingCard item={row.item} />;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);

  if (isLoading) return <Spinner />;
  if (groups.length === 0)
    return <EmptyState title={t('shows:empty.upcomingTitle')} subtitle={t('shows:empty.upcomingSubtitle')} cta={t('shows:empty.browseAll')} onCta={() => router.push('/(tabs)/explore')} icon="calendar-outline" />;

  return (
    <FlatList
      ref={listRef}
      data={rows}
      keyExtractor={(r) => r.key}
      renderItem={renderRow}
      contentContainerStyle={{ padding: spacing.lg }}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[tokens.primary]} tintColor={tokens.primary} />}
      initialNumToRender={15}
      maxToRenderPerBatch={12}
      windowSize={9}
      onScrollToIndexFailed={onScrollToIndexFailed}
      onScrollBeginDrag={cancelLanding}
    />
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: 'row', paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
});
