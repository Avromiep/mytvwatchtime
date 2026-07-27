import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MediaType } from '@tvwatch/shared';
import { Header } from '../../components/Header';
import { PosterCard } from '../../components/cards';
import { EmptyState, Screen, Spinner, T } from '../../components/primitives';
import { useAllFavorites, useAllHistory, useAllWatchlist } from '../../api/hooks';
import { useAppearance } from '../../context/PreferencesProvider';
import { useTranslation } from 'react-i18next';
import { useWindowDimensions } from 'react-native';
import { spacing } from '../../theme/theme';

interface MovieItem { id: string; title: string; posterUrl?: string | null; progress?: number; watched?: boolean; rating?: number | null; year?: number | null }
type SectionKey = 'watchlist' | 'watched' | 'favorites';

interface FlatRow {
  type: 'header' | 'empty' | 'cards';
  key: string;
  title?: string;
  count?: number;
  section?: SectionKey;
  message?: string;
  cards?: MovieItem[];
}

/** Hoisted so the memoized PosterCard sees a stable style reference. */
const GRID_CARD_STYLE = { marginRight: 0 } as const;

export default function MoviesScreen() {
  const { width } = useWindowDimensions();
  const { tokens } = useAppearance();
  const { t } = useTranslation(['movies', 'common']);
  // Complete collections (auto-paged to the end) — sections show exactly what the
  // user has, not just the first 500.
  const watchlist = useAllWatchlist(MediaType.MOVIE);
  const watched = useAllHistory({ mediaType: MediaType.MOVIE });
  const favorites = useAllFavorites(MediaType.MOVIE);
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([watchlist.refetch(), watched.refetch(), favorites.refetch()]);
    setRefreshing(false);
  }, [watchlist, watched, favorites]);
  const [expanded, setExpanded] = useState<Record<SectionKey, boolean>>({ watchlist: true, watched: false, favorites: true });

  const containerW = width - 32;
  const gap = 8;
  const cols = Math.max(3, Math.floor((containerW + gap) / (110 + gap))); // same density as My Shows see-all
  const cellW = Math.floor((containerW - gap * (cols - 1)) / cols);

  // Memoized end-to-end: the auto-paginated queries append pages in rapid
  // succession, and rebuilding every row object per append re-rendered every
  // visible card (poster flicker while scrolling).
  const watchedItems: MovieItem[] = useMemo(() => {
    const watchedMovieMap = new Map<string, MovieItem>();
    for (const h of watched.items as any[]) {
      if (watchedMovieMap.has(h.mediaId)) continue;
      watchedMovieMap.set(h.mediaId, {
        id: h.mediaId, title: h.title, posterUrl: h.posterUrl, watched: true, progress: 1, rating: h.rating ?? null, year: h.year ?? null,
      });
    }
    return [...watchedMovieMap.values()];
  }, [watched.items]);

  const watchedIds = useMemo(() => new Set(watchedItems.map((m) => m.id)), [watchedItems]);

  const watchlistItems: MovieItem[] = useMemo(
    () =>
      watchlist.items
        .filter((m: any) => !watchedIds.has(m.id))
        .map((m: any) => ({ id: m.id, title: m.title, posterUrl: m.images?.poster ?? m.posterUrl, rating: m.rating ?? null, year: m.year ?? null })),
    [watchlist.items, watchedIds],
  );

  const favoriteItems: MovieItem[] = useMemo(
    () =>
      favorites.items.map((m: any) => {
        const watched = watchedIds.has(m.id);
        return { id: m.id, title: m.title, posterUrl: m.images?.poster ?? m.posterUrl, watched, progress: watched ? 1 : undefined, rating: m.rating ?? null, year: m.year ?? null };
      }),
    [favorites.items, watchedIds],
  );

  const sections = useMemo(
    () => [
      { key: 'watchlist' as SectionKey, title: t('movies:watchlist'), empty: t('movies:watchlistEmpty'), items: watchlistItems },
      { key: 'watched' as SectionKey, title: t('movies:watched'), empty: t('movies:watchedEmpty'), items: watchedItems },
      { key: 'favorites' as SectionKey, title: t('movies:favorites'), empty: t('movies:favoritesEmpty'), items: favoriteItems },
    ],
    [t, watchlistItems, watchedItems, favoriteItems],
  );

  const { rows, stickyIndices } = useMemo(() => {
    const rows: FlatRow[] = [];
    for (const s of sections) {
      rows.push({ type: 'header', key: `h_${s.key}`, title: s.title, count: s.items.length, section: s.key });
      if (expanded[s.key]) {
        if (s.items.length === 0) {
          rows.push({ type: 'empty', key: `e_${s.key}`, message: s.empty });
        } else {
          for (let i = 0; i < s.items.length; i += cols) {
            const slice = s.items.slice(i, i + cols);
            rows.push({ type: 'cards', key: `r_${s.key}_${slice[0]?.id ?? i}_${i}`, cards: slice });
          }
        }
      }
    }
    const stickyIndices: number[] = [];
    rows.forEach((r, i) => { if (r.type === 'header') stickyIndices.push(i); });
    return { rows, stickyIndices };
  }, [sections, expanded, cols]);

  const noData =
    watchlist.items.length === 0 && watched.items.length === 0 && favorites.items.length === 0;
  const initialLoading =
    noData && (watchlist.isPending || watched.isPending || favorites.isPending);

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
      return <View style={styles.emptyWrap}><EmptyState title={item.message!} icon="film-outline" /></View>;
    }
    const cards = item.cards!;
    const fillCount = cols - cards.length;
    return (
      <View style={styles.cardRow}>
        {cards.map((it) => (
          <View key={it.id} style={{ width: cellW, marginRight: gap, marginBottom: gap }}>
            <PosterCard id={it.id} kind="movies" title={it.title} poster={it.posterUrl} progress={it.progress} rating={it.rating} year={it.year} width={cellW} style={GRID_CARD_STYLE} />
          </View>
        ))}
        {Array.from({ length: fillCount }).map((_, i) => (
          <View key={'pad_' + i} style={{ width: cellW, marginRight: gap }} />
        ))}
      </View>
    );
  }, [expanded, tokens, cols, cellW]);

  if (initialLoading) {
    return (
      <Screen>
        <Header title={t('movies:title')} />
        <Spinner />
      </Screen>
    );
  }

  return (
    <Screen>
      <Header title={t('movies:title')} />
      <FlatList
        data={rows}
        keyExtractor={(item) => item.key}
        stickyHeaderIndices={stickyIndices}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 40 }}
        renderItem={renderItem}
        initialNumToRender={12}
        maxToRenderPerBatch={8}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[tokens.primary]} tintColor={tokens.primary} />}
        windowSize={10}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pill: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  cardRow: { flexDirection: 'row' },
  emptyWrap: { paddingVertical: 20 },
});
