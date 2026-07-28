import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { Header } from '../components/Header';
import { PosterCard, cardYear } from '../components/cards';
import { EmptyState, Screen, Spinner, T } from '../components/primitives';
import { api } from '../api/client';
import { useQuery } from '@tanstack/react-query';
import { useAppearance } from '../context/PreferencesProvider';
import { spacing } from '../theme/theme';
import { useTranslation } from 'react-i18next';

interface StatusItem { id: string; title: string; posterUrl?: string | null; progress: number; rating?: number | null }
type SectionKey = 'watching' | 'notStarted' | 'finished';

interface FlatRow {
  type: 'header' | 'empty' | 'cards';
  key: string;
  title?: string;
  count?: number;
  section?: SectionKey;
  message?: string;
  cards?: StatusItem[];
  /** First cards row of a section — gets breathing room under the header separator. */
  underHeader?: boolean;
}

/** Hoisted so the memoized PosterCard sees a stable style reference. */
const GRID_CARD_STYLE = { marginRight: 0 } as const;

export default function MyShowsScreen() {
  const { width } = useWindowDimensions();
  const { tokens } = useAppearance();
  const { t } = useTranslation(['social', 'common']);
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['showsByStatus'],
    queryFn: () => api.get<{ watching: StatusItem[]; notStarted: StatusItem[]; finished: StatusItem[] }>('/me/shows/progress'),
  });
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => { setRefreshing(true); await refetch(); setRefreshing(false); }, [refetch]);
  const [expanded, setExpanded] = useState<Record<SectionKey, boolean>>({ watching: true, notStarted: true, finished: true });

  const containerW = width - 32; // spacing.lg * 2
  const gap = 8;
  const cols = Math.max(3, Math.floor((containerW + gap) / (110 + gap))); // 3 per row, same as Movies tab
  const cellW = Math.floor((containerW - gap * (cols - 1)) / cols);

  const defs: { key: SectionKey; title: string; empty: string; items: StatusItem[] }[] = useMemo(
    () => [
      { key: 'watching', title: t('social:myShows.toWatch'), empty: t('social:myShows.toWatchEmpty'), items: data?.watching ?? [] },
      { key: 'notStarted', title: t('social:myShows.notStarted'), empty: t('social:myShows.notStartedEmpty'), items: data?.notStarted ?? [] },
      { key: 'finished', title: t('social:myShows.finished'), empty: t('social:myShows.finishedEmpty'), items: data?.finished ?? [] },
    ],
    [t, data],
  );

  const { rows, stickyIndices } = useMemo(() => {
    const rows: FlatRow[] = [];
    for (const s of defs) {
      rows.push({ type: 'header', key: `h_${s.key}`, title: s.title, count: s.items.length, section: s.key });
      if (expanded[s.key]) {
        if (s.items.length === 0) {
          rows.push({ type: 'empty', key: `e_${s.key}`, message: s.empty });
        } else {
          for (let i = 0; i < s.items.length; i += cols) {
            const slice = s.items.slice(i, i + cols);
            rows.push({ type: 'cards', key: `r_${s.key}_${slice[0]?.id ?? i}_${i}`, cards: slice, underHeader: i === 0 });
          }
        }
      }
    }
    const stickyIndices: number[] = [];
    rows.forEach((r, i) => { if (r.type === 'header') stickyIndices.push(i); });
    return { rows, stickyIndices };
  }, [defs, expanded, cols]);

  // Warm the disk cache for posters below the viewport (see movies.tsx note).
  useEffect(() => {
    const urls = defs
      .flatMap((s) => s.items)
      .map((m) => m.posterUrl)
      .filter((u): u is string => !!u);
    if (urls.length) Image.prefetch(urls).catch(() => undefined);
  }, [defs]);

  const renderItem = useCallback(({ item }: { item: FlatRow }) => {
    if (item.type === 'header') {
      const sec = item.section!;
      const open = expanded[sec];
      return (
        <Pressable
          style={[styles.header, { backgroundColor: tokens.background, borderBottomColor: tokens.divider }]}
          onPress={() => setExpanded((e) => ({ ...e, [sec]: !e[sec] }))}
        >
          <View style={{ flex: 1 }}>
            <View style={styles.headerLeft}>
              <T variant="h1">{item.title}</T>
              <View style={[styles.pill, { backgroundColor: tokens.chip }]}><T variant="micro" style={{ color: tokens.primary }}>{item.count}</T></View>
            </View>
          </View>
          <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={tokens.textMuted} />
        </Pressable>
      );
    }

    if (item.type === 'empty') {
      return (
        <View style={styles.emptyWrap}>
          <EmptyState title={item.message!} icon="tv-outline" />
        </View>
      );
    }

    // cards row
    const cards = item.cards!;
    const fillCount = cols - cards.length;
    return (
      <View style={[styles.cardRow, item.underHeader ? { marginTop: gap } : null]}>
        {cards.map((it) => (
          <View key={it.id} style={{ width: cellW, marginRight: gap, marginBottom: gap }}>
            <PosterCard id={it.id} kind="shows" title={it.title} poster={it.posterUrl} progress={it.progress} rating={it.rating} year={cardYear(it)} width={cellW} style={GRID_CARD_STYLE} />
          </View>
        ))}
        {Array.from({ length: fillCount }).map((_, i) => (
          <View key={'pad_' + i} style={{ width: cellW, marginRight: gap }} />
        ))}
      </View>
    );
  }, [expanded, tokens, cols, cellW]);

  if (isLoading) return <Screen><Header title={t('social:myShows.title')} showBack /><Spinner /></Screen>;

  return (
    <Screen>
      <Header title={t('social:myShows.title')} showBack />
      <FlatList
        data={rows}
        keyExtractor={(item) => item.key}
        stickyHeaderIndices={stickyIndices}
        // Android: clipped subviews make sticky headers vanish mid-scroll and come
        // back without their touch target — keep them mounted.
        removeClippedSubviews={false}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 40 }}
        renderItem={renderItem}
        initialNumToRender={12}
        maxToRenderPerBatch={8}
        windowSize={10}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[tokens.primary]} tintColor={tokens.primary} />}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    // See movies.tsx — the overhang covers the sticky-header seam where cards peek
    // through between the stuck header and the page Header.
    marginTop: -8,
    paddingTop: 16,
    paddingBottom: 8,
    borderBottomWidth: 1,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  pill: {
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  cardRow: {
    flexDirection: 'row',
  },
  emptyWrap: {
    paddingVertical: 20,
  },
});