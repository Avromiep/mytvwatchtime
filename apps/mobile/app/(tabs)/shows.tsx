import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { Header, IconButton } from '../../components/Header';
import { EpisodeCard, UpcomingCard } from '../../components/cards';
import { Chip, EmptyState, Screen, SectionHeader, Spinner } from '../../components/primitives';
import { InfoBanner } from '../../components/InfoBanner';
import {
  useMarkEpisodeWatched,
  useRewatchEpisode,
  useUpcoming,
  useUpcomingPast,
  useWatchNext,
  useActiveAnnouncement,
} from '../../api/hooks';
import { useQueryClient } from '@tanstack/react-query';
import { useTabPressReset } from '../../hooks/useTabPressReset';
import { useDismissableFlag } from '../../hooks/useDismissableFlag';
import { pickLocale, runAnnouncementAction } from '../../lib/announcement';
import { useAppearance } from '../../context/PreferencesProvider';
import { useTranslation } from 'react-i18next';
import { spacing } from '../../theme/theme';
import { UpcomingGroupDto, UpcomingPastBucket, WatchNextBucket } from '@tvwatch/shared';

const VALID_ICONS = new Set([
  'information-circle-outline',
  'megaphone-outline',
  'download-outline',
  'notifications-outline',
  'bulb-outline',
  'gift-outline',
  'star-outline',
  'trophy-outline',
  'flame-outline',
  'sparkles-outline',
  'calendar-outline',
  'pricetag-outline',
  'film-outline',
  'tv-outline',
  'list-outline',
  'people-outline',
  'chatbubble-outline',
  'warning-outline',
  'checkmark-circle-outline',
  'rocket-outline',
]);

// Exact row heights power getItemLayout → initialScrollIndex lands on Watch Next
// precisely on mount (even before rows lay out), with zero post-mount programmatic
// scrolling — so marking a show never yanks the viewport, and the tab-reset remount
// (key={resetKey}) re-lands exactly like a fresh open.
const CARD_H = 122; // EpisodeCard: header 20 + gap xs + still 74 + padding sm×2 + marginBottom sm
const UPCOMING_H = 108; // UpcomingCard: poster 84 + padding sm×2 + marginBottom sm
const HEADER_H = 44; // SectionHeader (h1 18px + paddingVertical sm×2, bottom-aligned)

type WatchRow =
  | { type: 'spacer'; key: string; h: number }
  | { type: 'header'; key: string; bucket: string; h: number }
  | { type: 'card'; key: string; item: any; h: number };

type UpcomingRow =
  | { type: 'spacer'; key: string; h: number }
  | { type: 'loader'; key: string; h: number }
  | { type: 'header'; key: string; groupKey: string; group: UpcomingGroupDto; h: number }
  | { type: 'card'; key: string; item: any; h: number };

export default function ShowsScreen() {
  const [tab, setTab] = useState<'watchlist' | 'upcoming'>('watchlist');
  const [resetKey, setResetKey] = useState(0);
  const { t, i18n } = useTranslation(['shows', 'navigation', 'common']);
  const { tokens } = useAppearance();
  const { data: announcement } = useActiveAnnouncement();
  const dismissKey = announcement
    ? `announcement:${announcement.id}:rev:${announcement.revision}`
    : null;
  const { visible: showAnnouncementBanner, dismiss: dismissAnnouncementBanner } =
    useDismissableFlag(dismissKey ?? '');
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
        <Chip
          label={t('shows:watchList')}
          active={tab === 'watchlist'}
          onPress={() => setTab('watchlist')}
        />
        <Chip
          label={t('shows:upcoming')}
          active={tab === 'upcoming'}
          onPress={() => setTab('upcoming')}
        />
      </View>
      {tab === 'watchlist' && showBanner && announcement ? (
        <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}>
          <InfoBanner
            icon={
              (VALID_ICONS.has(announcement.icon)
                ? announcement.icon
                : 'information-circle-outline') as any
            }
            title={pickLocale(announcement.title, i18n.language)}
            message={pickLocale(announcement.message, i18n.language)}
            actionLabel={
              announcement.actionLabel
                ? pickLocale(announcement.actionLabel, i18n.language)
                : undefined
            }
            onAction={
              announcement.action?.type !== 'none'
                ? () => runAnnouncementAction(announcement.action)
                : undefined
            }
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
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  }, [refetch]);
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
    const buckets = [
      WatchNextBucket.HISTORY,
      WatchNextBucket.WATCH_NEXT,
      WatchNextBucket.START_WATCHING,
      WatchNextBucket.NOT_RECENTLY,
    ];
    const out: WatchRow[] = [{ type: 'spacer', key: 'top', h: spacing.lg }];
    let isFirstSection = true;
    for (const bucket of buckets) {
      const group = items.filter((i) => i.bucket === bucket);
      if (group.length === 0) continue;
      // History: oldest on top, latest at the bottom (right above Watch Next).
      const ordered = bucket === WatchNextBucket.HISTORY ? [...group].reverse() : group;
      out.push({
        type: 'header',
        key: `h_${bucket}`,
        bucket,
        h: HEADER_H + (isFirstSection ? 0 : spacing.lg),
      });
      isFirstSection = false;
      for (const it of ordered) {
        // Non-History cards are keyed by showId so an optimistic mark-watched swap
        // (episode E → nextEpisode) updates the same component in place instead of
        // remounting. History rows keep the episode key (a show can appear multiple
        // times in History → showId would collide).
        out.push({
          type: 'card',
          key: bucket === WatchNextBucket.HISTORY ? `c_${it.episode.id}` : `c_${it.showId}`,
          item: it,
          h: CARD_H,
        });
      }
    }
    return out;
  }, [data?.items]);

  const watchNextIndex = useMemo(
    () => rows.findIndex((r) => r.type === 'header' && r.bucket === WatchNextBucket.WATCH_NEXT),
    [rows],
  );

  const getItemLayout = useCallback(
    (_: any, index: number) => {
      let offset = 0;
      for (let i = 0; i < index; i++) offset += rows[i].h;
      return { length: rows[index].h, offset, index };
    },
    [rows],
  );

  // Land on the Watch Next header ONCE per mount. Exact getItemLayout makes
  // scrollToIndex compute the offset without any layout pass, so a single next-frame
  // call always lands. (initialScrollIndex was abandoned: rows above the index stay
  // blank on mount — with short lists the whole History section never rendered.)
  // The landed-ref means marking a show never re-scrolls; the tab-reset remount
  // (key={resetKey}) re-lands like a fresh open.
  const listRef = useRef<FlatList<WatchRow>>(null);
  const landed = useRef(false);
  useEffect(() => {
    if (landed.current || watchNextIndex <= 0) return;
    landed.current = true;
    const timer = setTimeout(
      () => listRef.current?.scrollToIndex({ index: watchNextIndex, animated: false }),
      0,
    );
    return () => clearTimeout(timer);
  }, [watchNextIndex]);

  const renderRow = useCallback(
    ({ item: row }: { item: WatchRow }) => {
      if (row.type === 'spacer') return <View style={{ height: row.h }} />;
      if (row.type === 'header') {
        return (
          <View style={{ height: row.h, justifyContent: 'flex-end' }}>
            <SectionHeader title={BUCKET_LABELS[row.bucket]} />
          </View>
        );
      }
      const it = row.item;
      return (
        <View style={{ height: CARD_H }}>
          <EpisodeCard
            item={it}
            onMarkWatched={() => mark.mutate({ id: it.episode.id, on: true })}
            onRewatch={() => rewatch.mutate(it.episode.id)}
            onUnwatch={() => mark.mutate({ id: it.episode.id, on: false })}
          />
        </View>
      );
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [mark, rewatch, t],
  );

  if (isLoading) return <Spinner />;
  // rows always contains the top spacer; "empty" = nothing but the spacer.
  if (rows.length <= 1)
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
      contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.lg }}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          colors={[tokens.primary]}
          tintColor={tokens.primary}
        />
      }
      initialNumToRender={15}
      maxToRenderPerBatch={12}
      windowSize={9}
      getItemLayout={getItemLayout}
      // Keep the viewport anchored when optimistic updates insert/remove History
      // rows above the visible area.
      maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
    />
  );
}

function Upcoming() {
  const { tokens } = useAppearance();
  const { data, isLoading, refetch } = useUpcoming();
  const queryClient = useQueryClient();
  const { t } = useTranslation(['shows', 'common']);
  const pastCursor = data?.past?.cursor ?? null;
  const pastHasMore = data?.past?.hasMore ?? false;
  const pastQuery = useUpcomingPast(pastCursor);
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    // Reset fetched past pages — their cursors chain from the pre-refresh slice.
    queryClient.removeQueries({ queryKey: ['upcoming', 'past'] });
    await refetch();
    setRefreshing(false);
  }, [refetch, queryClient]);

  const UPCOMING_GROUP_KEYS: Record<string, string> = {
    TODAY: t('shows:today'),
    TOMORROW: t('shows:tomorrow'),
    THIS_WEEK: t('shows:thisWeek'),
    NEXT_WEEK: t('shows:nextWeek'),
    LATER: t('shows:later'),
  };

  // Localized group header: past buckets translate via key + params, future buckets
  // via the fixed map; server label is the fallback for unknown keys.
  const groupLabel = useCallback(
    (g: UpcomingGroupDto): string => {
      switch (g.key) {
        case UpcomingPastBucket.YESTERDAY:
          return t('shows:yesterday');
        case UpcomingPastBucket.EARLIER_THIS_WEEK:
          return t('shows:earlierThisWeek');
        case UpcomingPastBucket.LAST_WEEK:
          return t('shows:lastWeek');
        case UpcomingPastBucket.LAST_MONTH:
          return t('shows:lastMonth');
        case UpcomingPastBucket.MONTHS_AGO:
          return t('shows:pastMonthsAgo', { count: g.params?.count ?? 0 });
        case UpcomingPastBucket.YEARS_AGO:
          return t('shows:pastYearsAgo', { count: g.params?.years ?? g.params?.count ?? 1 });
        case UpcomingPastBucket.YEARS_MONTHS_AGO:
          return t('shows:pastYearsMonthsAgo', {
            years: g.params?.years ?? 1,
            count: g.params?.months ?? 1,
          });
        default:
          return UPCOMING_GROUP_KEYS[g.key] ?? g.label ?? g.key;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t],
  );

  // Merge older infinite-scroll pages above the main slice. Pages are fetched
  // newest-older → oldest, so they prepend in reverse fetch order; groups with
  // the same identity (key + params) merge, items deduped by episode id.
  const groups = useMemo<UpcomingGroupDto[]>(() => {
    const mainGroups = data?.groups ?? [];
    const pages = pastQuery.data?.pages ?? [];
    if (pages.length === 0) return mainGroups;
    const merged: UpcomingGroupDto[] = [];
    const byIdentity = new Map<string, UpcomingGroupDto>();
    const seenIds = new Set<string>();
    const pushGroups = (gs: UpcomingGroupDto[]) => {
      for (const g of gs) {
        const identity = `${g.key}|${JSON.stringify(g.params ?? null)}`;
        let target = byIdentity.get(identity);
        if (!target) {
          target = { ...g, items: [] };
          byIdentity.set(identity, target);
          merged.push(target);
        }
        for (const it of g.items) {
          if (seenIds.has(it.id)) continue;
          seenIds.add(it.id);
          target.items.push(it);
        }
      }
    };
    for (const page of [...pages].reverse()) pushGroups(page.groups);
    pushGroups(mainGroups);
    return merged.filter((g) => g.items.length > 0);
  }, [data?.groups, pastQuery.data?.pages]);

  // Infinite top scroll: with no pages fetched yet, the main endpoint's
  // hasMore+cursor gates the first fetch; afterwards the last page's cursor gates.
  const canFetchPast =
    (pastQuery.data?.pages.length ?? 0) > 0 ? !!pastQuery.hasNextPage : pastHasMore && !!pastCursor;
  // Top detection via onScroll (react-native-web's onStartReached is unreliable)
  // + manual anchor restore computed from our exact row heights — RNW has no
  // maintainVisibleContentPosition, so without this the offset pinned at 0 after
  // a prepend and wheeling up emitted no scroll events: nothing could retrigger.
  // The 1.2s cooldown caps a refire burst at ~50 req/min.
  const listRef = useRef<FlatList<UpcomingRow>>(null);
  const offsetRef = useRef(0);
  const rowsRef = useRef<UpcomingRow[]>([]);
  const pendingPrepend = useRef<{ height: number; offset: number } | null>(null);
  const pastFetchGate = useRef(0);
  const maybeFetchPast = useCallback(() => {
    if (!canFetchPast || pastQuery.isFetchingNextPage) return;
    const now = Date.now();
    if (now - pastFetchGate.current < 1200) return;
    pastFetchGate.current = now;
    pendingPrepend.current = {
      height: rowsRef.current.reduce((sum, r) => sum + r.h, 0),
      offset: offsetRef.current,
    };
    pastQuery.fetchNextPage();
  }, [canFetchPast, pastQuery]);
  const onScroll = useCallback((e: any) => {
    offsetRef.current = e.nativeEvent.contentOffset.y;
  }, []);
  // Level-triggered top detection: edge-triggered approaches (onStartReached,
  // onScroll crossings) are flaky on web — after the anchor restore the offset can
  // sit inside the threshold with no further events, forcing a scroll-down-and-up
  // dance. A cheap interval just looks at the current position: near the top →
  // load (cooldown-capped), away from the top → does nothing. No event dependence.
  useEffect(() => {
    const id = setInterval(() => {
      if (offsetRef.current < 250) maybeFetchPast();
    }, 500);
    return () => clearInterval(id);
  }, [maybeFetchPast]);

  // Flat rows (header / card) so the list virtualizes (up to 200 cards server-side).
  const rows = useMemo<UpcomingRow[]>(() => {
    const out: UpcomingRow[] = [{ type: 'spacer', key: 'top', h: spacing.lg }];
    if (pastQuery.isFetchingNextPage) out.push({ type: 'loader', key: 'past_loader', h: 48 });
    let isFirstSection = true;
    for (const g of groups) {
      if (!g.items?.length) continue;
      out.push({
        type: 'header',
        key: `h_${g.key}_${JSON.stringify(g.params ?? null)}`,
        groupKey: g.key,
        group: g,
        h: HEADER_H + (isFirstSection ? 0 : spacing.lg),
      });
      isFirstSection = false;
      for (const it of g.items)
        out.push({ type: 'card', key: `c_${it.id}`, item: it, h: UPCOMING_H });
    }
    return out;
  }, [groups, pastQuery.isFetchingNextPage]);
  rowsRef.current = rows;

  // Restore the visual anchor once a prepended page has rendered: the delta comes
  // from our exact row heights, so it works identically on web and native.
  useEffect(() => {
    const pending = pendingPrepend.current;
    if (!pending || pastQuery.isFetchingNextPage) return;
    pendingPrepend.current = null;
    const delta = rows.reduce((sum, r) => sum + r.h, 0) - pending.height;
    const next = pending.offset + Math.max(0, delta);
    offsetRef.current = next;
    if (next > 0) listRef.current?.scrollToOffset({ offset: next, animated: false });
  }, [rows, pastQuery.isFetchingNextPage]);

  const landingKey = ['TODAY', 'TOMORROW', 'THIS_WEEK'].find((k) =>
    groups.some((g: any) => g.key === k),
  );
  const landingIndex = useMemo(
    () => rows.findIndex((r) => r.type === 'header' && r.groupKey === landingKey),
    [rows, landingKey],
  );

  const getItemLayout = useCallback(
    (_: any, index: number) => {
      let offset = 0;
      for (let i = 0; i < index; i++) offset += rows[i].h;
      return { length: rows[index].h, offset, index };
    },
    [rows],
  );

  // Same landing strategy as WatchList: one exact next-frame scroll per mount
  // (no initialScrollIndex — rows above the index stayed blank on short lists).
  const landed = useRef(false);
  useEffect(() => {
    if (landed.current || landingIndex <= 0) return;
    landed.current = true;
    const timer = setTimeout(
      () => listRef.current?.scrollToIndex({ index: landingIndex, animated: false }),
      0,
    );
    return () => clearTimeout(timer);
  }, [landingIndex]);

  const renderRow = useCallback(
    ({ item: row }: { item: UpcomingRow }) => {
      if (row.type === 'spacer') return <View style={{ height: row.h }} />;
      if (row.type === 'loader') {
        return (
          <View style={{ height: row.h, justifyContent: 'center' }}>
            <Spinner />
          </View>
        );
      }
      if (row.type === 'header') {
        return (
          <View style={{ height: row.h, justifyContent: 'flex-end' }}>
            <SectionHeader title={groupLabel(row.group)} />
          </View>
        );
      }
      return (
        <View style={{ height: UPCOMING_H }}>
          <UpcomingCard item={row.item} />
        </View>
      );
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [t, groupLabel],
  );

  if (isLoading) return <Spinner />;
  if (groups.length === 0)
    return (
      <EmptyState
        title={t('shows:empty.upcomingTitle')}
        subtitle={t('shows:empty.upcomingSubtitle')}
        cta={t('shows:empty.browseAll')}
        onCta={() => router.push('/(tabs)/explore')}
        icon="calendar-outline"
      />
    );

  return (
    <FlatList
      ref={listRef}
      data={rows}
      keyExtractor={(r) => r.key}
      renderItem={renderRow}
      contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.lg }}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          colors={[tokens.primary]}
          tintColor={tokens.primary}
        />
      }
      initialNumToRender={15}
      maxToRenderPerBatch={12}
      windowSize={9}
      getItemLayout={getItemLayout}
      onScroll={onScroll}
      scrollEventThrottle={16}
    />
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: 'row', paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
});
