import React, { useState, useCallback, useEffect, useRef } from 'react';
import { ActivityIndicator, Dimensions, FlatList, ScrollView, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Image } from 'expo-image';
import { MediaType } from '@tvwatch/shared';
import { Header } from '../components/Header';
import { PosterCard, cardProgress, cardYear } from '../components/cards';
import { Chip, EmptyState, Screen, Spinner } from '../components/primitives';
import { useAllFavorites, useAllWatchlist, useGenres } from '../api/hooks';
import { useInfiniteQuery } from '@tanstack/react-query';
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
  const { t: tab, g: initialGenre, x, s, c, a } = useLocalSearchParams<{
    t: string;
    g?: string;
    /** Explore filters handed over as route params (x=excluded slugs csv, s=sort, c=country, a=hide anime). */
    x?: string;
    s?: string;
    c?: string;
    a?: string;
  }>();
  // Genre filter (explore hands its active chip over via the `g` route param).
  const [genre, setGenre] = useState<string | null>(initialGenre ?? null);
  const genres = useGenres();
  const exploreFilters = {
    excludeGenres: x || undefined,
    sort: s || undefined,
    country: c || undefined,
    hideAnime: a === '1' ? true : undefined,
  };

  const TITLES: Record<string, string> = {
    'trending-shows': t('social:more.trendingShows'),
    'trending-movies': t('social:more.trendingMovies'),
    'top-for-you': t('social:more.topShowsForYou'),
    'top-rated-shows': t('social:more.topRatedShows'),
    'top-rated-movies': t('social:more.topRatedMovies'),
    'now-playing-movies': t('social:more.nowPlayingMovies'),
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
  // Server-paged sections: trending, curated lists + "Top shows for you" (all paginate).
  const LIST_PATHS: Record<string, string> = {
    'top-rated-shows': '/top-rated/shows',
    'top-rated-movies': '/top-rated/movies',
    'now-playing-movies': '/now-playing/movies',
  };
  const pagedPath =
    tab === 'top-for-you'
      ? '/discover/for-you'
      : isTrending
        ? `/trending/${trendingType}`
        : (LIST_PATHS[tab ?? ''] ?? null);

  const cols = useColumns();
  const screenWidth = Dimensions.get('window').width;
  const containerW = Math.min(screenWidth - spacing.lg * 2, 1200);
  const cardW = Math.floor((containerW - spacing.md * (cols - 1)) / cols);

  // --- Pagination for server-paged sections ---
  // useInfiniteQuery owns the page list: refetches REPLACE page data in place,
  // so pages never duplicate and the FlatList never remounts mid-scroll (the
  // previous manual page/allItems accumulation re-appended the current page on
  // every refetch and reset scroll to the top). Filter changes are just a new
  // query key — no reset effects.
  const pageQuery = useInfiniteQuery({
    queryKey: ['more', pagedPath, genre ?? '', x ?? '', s ?? '', c ?? '', a ?? ''],
    queryFn: ({ pageParam }) =>
      api.get<{ items: any[]; hasMore: boolean }>(pagedPath!, {
        page: pageParam,
        genre: genre || undefined,
        ...exploreFilters,
      }),
    initialPageParam: 1,
    getNextPageParam: (last, pages) => (last.hasMore ? pages.length + 1 : undefined),
    enabled: !!pagedPath,
    staleTime: 60000,
  });

  const loadMore = useCallback(() => {
    if (!pageQuery.hasNextPage || pageQuery.isFetchingNextPage) return;
    pageQuery.fetchNextPage();
  }, [pageQuery]);

  // --- Collection hooks (auto-paged to the end — see-alls show exactly what the user has) ---
  const watchlistShows = useAllWatchlist(MediaType.SHOW, genre);
  const watchlistMovies = useAllWatchlist(MediaType.MOVIE, genre);
  const favShows = useAllFavorites(MediaType.SHOW, genre);
  const favMovies = useAllFavorites(MediaType.MOVIE, genre);

  // --- Collect items ---
  let items: any[] = [];
  let loading = false;
  if (pagedPath) {
    items = pageQuery.data?.pages.flatMap((p) => p.items ?? []) ?? [];
    loading = pageQuery.isLoading;
  } else {
    switch (tab) {
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

  // Gate the grid on the first screenful of posters: every cell mounts at once and,
  // on a cold image cache, the placeholders sit empty for ~1s and then all pop in
  // together. Prefetching the visible rows first shows the spinner a beat longer,
  // then the grid appears with its posters (mirrors movies.tsx cache warming).
  const preloadKey = items
    .slice(0, cols * 4)
    .map((it) => it.posterUrl ?? it.images?.poster)
    .filter(Boolean)
    .join('|');
  const [postersReady, setPostersReady] = useState(false);
  // Gate ONLY the first paint. Re-gating whenever the first rows' data changed
  // (refetch, appended page) flipped postersReady back to false, which unmounted
  // the FlatList → visible flicker and scroll reset to the top. Appended pages
  // load their posters inline instead.
  const postersGatedRef = useRef(false);
  useEffect(() => {
    if (!preloadKey) {
      setPostersReady(true);
      return;
    }
    if (postersGatedRef.current) return;
    postersGatedRef.current = true;
    let alive = true;
    setPostersReady(false);
    // Fail-safe: never trap the grid behind a stalled prefetch.
    const failSafe = setTimeout(() => {
      if (alive) setPostersReady(true);
    }, 2000);
    Image.prefetch(preloadKey.split('|'))
      .catch(() => undefined)
      .finally(() => {
        if (alive) {
          clearTimeout(failSafe);
          setPostersReady(true);
        }
      });
    return () => {
      alive = false;
      clearTimeout(failSafe);
    };
  }, [preloadKey]);

  return (
    <Screen>
      <Header title={title} showBack />
      {/* flexShrink: 0 — on web the default flex-shrink: 1 let the growing grid
          squeeze this row smaller with every paginated append. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0, flexShrink: 0, marginBottom: spacing.sm }}
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
      {loading || !postersReady ? (
        <Spinner />
      ) : (
        <FlatList
          key={cols}
          data={rows}
          keyExtractor={(r) => r.key}
          initialNumToRender={cols * 4}
          maxToRenderPerBatch={cols * 4}
          windowSize={7}
          contentContainerStyle={{
            padding: spacing.lg,
            maxWidth: 1200,
            width: '100%',
            alignSelf: 'center',
          }}
          ListEmptyComponent={<EmptyState title={t('common:nothingHereYet')} icon="film-outline" />}
          onEndReached={pagedPath ? loadMore : undefined}
          onEndReachedThreshold={0.5}
          ListFooterComponent={
            pagedPath && pageQuery.isFetchingNextPage ? (
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
                    year={cardYear(item)}
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
