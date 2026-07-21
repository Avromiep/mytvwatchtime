import React, { useState, useCallback, useEffect } from 'react';
import { ActivityIndicator, Dimensions, FlatList, ScrollView, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { MediaType } from '@tvwatch/shared';
import { Header } from '../components/Header';
import { PosterCard, cardProgress } from '../components/cards';
import { Chip, EmptyState, Screen, Spinner } from '../components/primitives';
import { useDiscoverSections, useAllFavorites, useAllWatchlist, useGenres } from '../api/hooks';
import { useAuth } from '../context/AuthContext';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAppearance } from '../context/PreferencesProvider';
import { spacing } from '../theme/theme';
import { useTranslation } from 'react-i18next';

function useColumns() {
  const [width, setWidth] = useState(Dimensions.get('window').width);
  useEffect(() => {
    const sub = Dimensions.addEventListener('change', ({ window }) => setWidth(window.width));
    return () => sub?.remove();
  }, []);
  if (width >= 1200) return 6;
  if (width >= 900) return 5;
  if (width >= 768) return 4;
  return 3;
}

export default function MoreScreen() {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['social', 'common']);
  const { t: tab, g: initialGenre } = useLocalSearchParams<{ t: string; g?: string }>();
  // Genre filter (explore hands its active chip over via the `g` route param).
  const [genre, setGenre] = useState<string | null>(initialGenre ?? null);
  const genres = useGenres();

  const TITLES: Record<string, string> = {
    'trending-shows': t('social:more.trendingShows'),
    'trending-movies': t('social:more.trendingMovies'),
    'top-for-you': t('social:more.topShowsForYou'),
    'watchlist-shows': t('social:more.myShows'),
    'watchlist-movies': t('social:more.myMovies'),
    'favorites-shows': t('social:more.favoriteShows'),
    'favorites-movies': t('social:more.favoriteMovies'),
  };

  const title = TITLES[tab ?? ''] ?? t('social:more.browse');
  const isMovies = tab?.endsWith('movies');
  const kind: 'shows' | 'movies' = isMovies ? 'movies' : 'shows';
  const isTrending = tab === 'trending-shows' || tab === 'trending-movies';
  const trendingType = tab === 'trending-movies' ? 'movies' : 'shows';

  const cols = useColumns();
  const screenWidth = Dimensions.get('window').width;
  const containerW = Math.min(screenWidth - spacing.lg * 2, 1200);
  const cardW = Math.floor((containerW - spacing.md * (cols - 1)) / cols);

  // --- Pagination for trending ---
  const [page, setPage] = useState(1);
  const [allItems, setAllItems] = useState<any[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const pageQuery = useQuery({
    queryKey: ['trending-page', trendingType, page, genre ?? ''],
    queryFn: () =>
      api.get<{ items: any[]; hasMore: boolean }>(`/trending/${trendingType}`, {
        page,
        genre: genre || undefined,
      }),
    enabled: isTrending,
    staleTime: 60000,
  });

  useEffect(() => {
    if (!isTrending || !pageQuery.data) return;
    const newItems = pageQuery.data.items ?? [];
    setAllItems((prev) => (page === 1 ? newItems : [...prev, ...newItems]));
    setHasMore(pageQuery.data.hasMore ?? false);
    setLoadingMore(false);
  }, [pageQuery.data, page, isTrending]);

  // Reset when tab or genre filter changes
  useEffect(() => {
    if (isTrending) {
      setAllItems([]);
      setPage(1);
      setHasMore(true);
      setLoadingMore(false);
    }
  }, [tab, genre]);

  const loadMore = useCallback(() => {
    if (!hasMore || loadingMore || pageQuery.isFetching) return;
    setLoadingMore(true);
    setPage((p) => p + 1);
  }, [hasMore, loadingMore, pageQuery.isFetching]);

  // --- Collection hooks (auto-paged to the end — see-alls show exactly what the user has) ---
  const { user } = useAuth();
  const sections = useDiscoverSections(user?.id, genre);
  const watchlistShows = useAllWatchlist(MediaType.SHOW, genre);
  const watchlistMovies = useAllWatchlist(MediaType.MOVIE, genre);
  const favShows = useAllFavorites(MediaType.SHOW, genre);
  const favMovies = useAllFavorites(MediaType.MOVIE, genre);

  // --- Collect items ---
  let items: any[] = [];
  let loading = false;
  if (isTrending) {
    items = allItems;
    loading = page === 1 && allItems.length === 0 && pageQuery.isLoading;
  } else {
    switch (tab) {
      case 'top-for-you':
        items = sections.data?.topForYou ?? [];
        loading = sections.isLoading;
        break;
      case 'watchlist-shows':
        items = watchlistShows.items;
        loading = watchlistShows.isLoading;
        break;
      case 'watchlist-movies':
        items = watchlistMovies.items;
        loading = watchlistMovies.isLoading;
        break;
      case 'favorites-shows':
        items = favShows.items;
        loading = favShows.isLoading;
        break;
      case 'favorites-movies':
        items = favMovies.items;
        loading = favMovies.isLoading;
        break;
    }
  }

  // --- Chunk into rows ---
  const rows: { key: string; cards: any[] }[] = [];
  for (let i = 0; i < items.length; i += cols) {
    rows.push({ key: `row_${i}`, cards: items.slice(i, i + cols) });
  }

  return (
    <Screen>
      <Header title={title} showBack />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0, marginBottom: spacing.sm }}
        contentContainerStyle={{ paddingHorizontal: spacing.lg }}
      >
        <Chip label={t('common:all')} active={!genre} onPress={() => setGenre(null)} />
        {(genres.data ?? []).map((g) => (
          <Chip
            key={g.id}
            label={g.name}
            active={genre === g.slug}
            onPress={() => setGenre(genre === g.slug ? null : g.slug)}
          />
        ))}
      </ScrollView>
      {loading ? (
        <Spinner />
      ) : (
        <FlatList
          key={cols}
          data={rows}
          keyExtractor={(r) => r.key}
          contentContainerStyle={{
            padding: spacing.lg,
            maxWidth: 1200,
            width: '100%',
            alignSelf: 'center',
          }}
          ListEmptyComponent={<EmptyState title={t('common:nothingHereYet')} icon="film-outline" />}
          onEndReached={isTrending ? loadMore : undefined}
          onEndReachedThreshold={0.5}
          ListFooterComponent={
            isTrending && loadingMore ? (
              <ActivityIndicator color={tokens.primary} style={{ padding: spacing.lg }} />
            ) : null
          }
          renderItem={({ item: row }) => {
            const fillCount = cols - row.cards.length;
            return (
              <View style={{ flexDirection: 'row', marginBottom: spacing.md }}>
                {row.cards.map((item) => (
                  <PosterCard
                    key={item.id}
                    id={item.id}
                    kind={kind}
                    title={item.title}
                    poster={item.posterUrl ?? item.images?.poster}
                    progress={cardProgress(item)}
                    rating={item.rating}
                    width={cardW}
                    style={{ marginRight: spacing.md }}
                  />
                ))}
                {Array.from({ length: fillCount }).map((_, i) => (
                  <View key={`pad_${i}`} style={{ width: cardW, marginRight: spacing.md }} />
                ))}
              </View>
            );
          }}
        />
      )}
    </Screen>
  );
}
