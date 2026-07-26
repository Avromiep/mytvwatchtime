import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { MediaType } from '@tvwatch/shared';
import { Header } from '../../components/Header';
import { ActivityFeed } from '../../components/ActivityFeed';
import { cardYear, Carousel, PosterCard } from '../../components/cards';
import { Chip, Screen, Spinner, T } from '../../components/primitives';
import { FilterPicker, FilterReset, FilterToggle } from '../../components/FilterPicker';
import { ExploreFilters, useDiscoverSections, useGenres, useSearch } from '../../api/hooks';
import { useAuth } from '../../context/AuthContext';
import { useTabPressReset } from '../../hooks/useTabPressReset';
import { useAppearance } from '../../context/PreferencesProvider';
import { radius, spacing, typography } from '../../theme/theme';
import { useTranslation } from 'react-i18next';

/** Curated ISO 3166-1 country filter list (display names are localized via i18n). */
const COUNTRY_CODES = ['US', 'GB', 'FR', 'DE', 'ES', 'IT', 'JP', 'KR', 'CN', 'IN', 'TR', 'BR', 'MX', 'CA', 'AU'];

type ExploreType = 'both' | 'movies' | 'shows';
type ExploreOrder = 'popularity' | 'releaseDate';

export default function ExploreScreen() {
  const { tokens } = useAppearance();
  const { width } = useWindowDimensions();
  const { t, i18n } = useTranslation(['explore', 'common']);
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [category, setCategory] = useState<'feed' | 'discover'>('discover');
  const discoverRef = useRef<ScrollView>(null);

  // Debounce so we don't hit the API on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 400);
    return () => clearTimeout(t);
  }, [q]);

  const searching = debouncedQ.length > 1;
  // Filters apply to both modes: search results AND the discover carousels.
  const [genre, setGenre] = useState<string | null>(null);
  const [excludeGenres, setExcludeGenres] = useState<string[]>([]);
  const [order, setOrder] = useState<ExploreOrder>('popularity');
  const [mediaType, setMediaType] = useState<ExploreType>('both');
  const [country, setCountry] = useState<string | null>(null);
  const [hideAnime, setHideAnime] = useState(false);
  const resetFilters = useCallback(() => {
    setGenre(null);
    setExcludeGenres([]);
    setOrder('popularity');
    setMediaType('both');
    setCountry(null);
    setHideAnime(false);
  }, []);
  const hasActiveFilters =
    !!genre ||
    excludeGenres.length > 0 ||
    order !== 'popularity' ||
    mediaType !== 'both' ||
    !!country ||
    hideAnime;
  const filters = useMemo<ExploreFilters>(
    () => ({ excludeGenres, sort: order, country, hideAnime }),
    [excludeGenres, order, country, hideAnime],
  );
  const genres = useGenres();
  const searchType =
    mediaType === 'movies' ? MediaType.MOVIE : mediaType === 'shows' ? MediaType.SHOW : undefined;
  const search = useSearch(debouncedQ, searchType, genre, filters);
  const { user } = useAuth();
  const sections = useDiscoverSections(user?.id, genre, filters);
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await sections.refetch();
    setRefreshing(false);
  }, [sections]);

  // Adaptive grid: column count scales with the available width (same approach
  // as My Shows). Renders pre-grouped rows per the project grid pattern.
  const containerW = Math.max(0, width - spacing.lg * 2);
  const gridGap = spacing.sm;
  const cols = Math.max(2, Math.floor((containerW + gridGap) / (110 + gridGap)));
  const cellW = Math.floor((containerW - gridGap * (cols - 1)) / cols);

  const searchItems = useMemo(
    () => (search.data?.pages ?? []).flatMap((p) => p.items ?? []),
    [search.data],
  );
  const searchRows: (typeof searchItems)[] = [];
  for (let i = 0; i < searchItems.length; i += cols)
    searchRows.push(searchItems.slice(i, i + cols));

  useTabPressReset(() => {
    setQ('');
    setDebouncedQ('');
    setGenre(null);
    setExcludeGenres([]);
    setOrder('popularity');
    setMediaType('both');
    setCountry(null);
    setHideAnime(false);
    discoverRef.current?.scrollTo({ y: 0, animated: true });
  });

  // Localized country names: Intl.DisplayNames when the runtime supports it
  // (Hermes doesn't), else the i18n name map shipped in every locale.
  const countryNames = useMemo(() => {
    let dn: { of: (code: string) => string | undefined } | null = null;
    try {
      const DisplayNames = (Intl as any)?.DisplayNames;
      if (DisplayNames) dn = new DisplayNames([i18n.language], { type: 'region' });
    } catch {
      dn = null;
    }
    const map: Record<string, string> = {};
    for (const code of COUNTRY_CODES) {
      map[code] = dn?.of(code) ?? t(`explore:filters.countries.${code}`);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i18n.language]);

  const genreOptions = useMemo(
    () => (genres.data ?? []).map((g) => ({ value: g.slug, label: g.name })),
    [genres.data],
  );
  const genreLabel = genre
    ? (genres.data ?? []).find((g) => g.slug === genre)?.name ?? genre
    : t('common:all');

  // Active filters ride along into see-all screens so they survive navigation.
  const moreHref = (key: string) => {
    let url = `/more?t=${key}`;
    if (genre) url += `&g=${encodeURIComponent(genre)}`;
    if (excludeGenres.length) url += `&x=${encodeURIComponent(excludeGenres.join(','))}`;
    if (order !== 'popularity') url += `&s=${order}`;
    if (country) url += `&c=${encodeURIComponent(country)}`;
    if (hideAnime) url += '&a=1';
    return url as any;
  };

  return (
    <Screen>
      <Header title={t('explore:title')} />
      <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}>
        <View style={[styles.search, { backgroundColor: tokens.surface }]}>
          <Ionicons
            name="search"
            size={18}
            color={tokens.textMuted}
            style={{ marginHorizontal: spacing.sm }}
          />
          <TextInput
            value={q}
            onChangeText={setQ}
            placeholder={t('explore:searchPlaceholder')}
            placeholderTextColor={tokens.placeholder}
            style={[styles.input, { color: tokens.textPrimary }]}
          />
          {q.length > 0 ? (
            <Pressable
              onPress={() => {
                setQ('');
                setDebouncedQ('');
              }}
              hitSlop={10}
              style={{ paddingHorizontal: spacing.sm }}
            >
              <Ionicons name="close-circle" size={20} color={tokens.textMuted} />
            </Pressable>
          ) : null}
        </View>
        <View style={{ flexDirection: 'row', marginTop: spacing.sm }}>
          <Chip
            label={t('explore:discover')}
            active={category === 'discover'}
            onPress={() => setCategory('discover')}
          />
          <Chip
            label={t('explore:feed')}
            active={category === 'feed'}
            onPress={() => setCategory('feed')}
          />
          <Chip label={t('explore:groups')} onPress={() => router.push('/groups' as any)} />
        </View>
        {/* Discovery filters don't apply to the activity feed — hide them there. */}
        {category === 'discover' ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ marginTop: spacing.sm, flexGrow: 0, flexShrink: 0 }}
        >
          <FilterPicker
            label={t('explore:filters.genre')}
            valueLabel={genreLabel}
            active={!!genre}
            dialogTitle={t('explore:filters.genre')}
            options={[{ value: '', label: t('common:all') }, ...genreOptions]}
            selected={[genre ?? '']}
            onChange={(v) => setGenre(v[0] || null)}
            onClear={() => setGenre(null)}
          />
          <FilterPicker
            label={t('explore:filters.exclude')}
            valueLabel={excludeGenres.length ? String(excludeGenres.length) : t('common:all')}
            active={excludeGenres.length > 0}
            dialogTitle={t('explore:filters.exclude')}
            options={genreOptions}
            selected={excludeGenres}
            multi
            onChange={setExcludeGenres}
            onClear={() => setExcludeGenres([])}
          />
          <FilterPicker
            label={t('explore:filters.order')}
            valueLabel={
              order === 'releaseDate'
                ? t('explore:filters.orderReleaseDate')
                : t('explore:filters.orderPopularity')
            }
            active={order !== 'popularity'}
            dialogTitle={t('explore:filters.order')}
            options={[
              { value: 'popularity', label: t('explore:filters.orderPopularity') },
              { value: 'releaseDate', label: t('explore:filters.orderReleaseDate') },
            ]}
            selected={[order]}
            onChange={(v) => setOrder((v[0] as ExploreOrder) ?? 'popularity')}
          />
          <FilterPicker
            label={t('explore:filters.type')}
            valueLabel={
              mediaType === 'movies'
                ? t('explore:filters.typeMovies')
                : mediaType === 'shows'
                  ? t('explore:filters.typeShows')
                  : t('explore:filters.typeBoth')
            }
            active={mediaType !== 'both'}
            dialogTitle={t('explore:filters.type')}
            options={[
              { value: 'both', label: t('explore:filters.typeBoth') },
              { value: 'movies', label: t('explore:filters.typeMovies') },
              { value: 'shows', label: t('explore:filters.typeShows') },
            ]}
            selected={[mediaType]}
            onChange={(v) => setMediaType((v[0] as ExploreType) ?? 'both')}
          />
          <FilterPicker
            label={t('explore:filters.country')}
            valueLabel={country ? (countryNames[country] ?? country) : t('common:all')}
            active={!!country}
            dialogTitle={t('explore:filters.country')}
            options={[
              { value: '', label: t('common:all') },
              ...COUNTRY_CODES.map((code) => ({ value: code, label: countryNames[code] ?? code })),
            ]}
            selected={[country ?? '']}
            onChange={(v) => setCountry(v[0] || null)}
            onClear={() => setCountry(null)}
          />
          {/* Additive with the profile setting — the server ORs both. */}
          <FilterToggle
            label={t('explore:filters.hideAnime')}
            value={hideAnime}
            onChange={setHideAnime}
          />
          {hasActiveFilters ? (
            <FilterReset label={t('explore:filters.resetAll')} onPress={resetFilters} />
          ) : null}
        </ScrollView>
        ) : null}
      </View>

      {/* Adaptive grid (chunked rows) when searching. */}
      {searching ? (
        search.isLoading ? (
          <Spinner />
        ) : (
          <FlatList
            data={searchRows}
            key={`grid-${cols}`}
            contentContainerStyle={{ padding: spacing.lg }}
            keyExtractor={(row, i) => row[0]?.id ?? `row-${i}`}
            ListEmptyComponent={
              <T variant="body" muted>
                {t('explore:noResults', { query: debouncedQ })}
              </T>
            }
            onEndReached={() => {
              if (search.hasNextPage && !search.isFetchingNextPage) search.fetchNextPage();
            }}
            onEndReachedThreshold={0.6}
            ListFooterComponent={search.isFetchingNextPage ? <Spinner /> : null}
            renderItem={({ item: row }) => {
              const fill = cols - row.length;
              return (
                <View style={{ flexDirection: 'row' }}>
                  {row.map((item) => (
                    <View
                      key={item.id}
                      style={{ width: cellW, marginRight: gridGap, marginBottom: gridGap }}
                    >
                      <PosterCard
                        id={item.id}
                        kind={item.type === 'SHOW' ? 'shows' : 'movies'}
                        title={item.title}
                        poster={item.images?.poster ?? item.images?.backdrop}
                        rating={item.rating}
                        year={cardYear(item)}
                        width={cellW}
                        style={{ marginRight: 0 }}
                      />
                    </View>
                  ))}
                  {fill > 0
                    ? Array.from({ length: fill }).map((_, i) => (
                        <View key={'pad_' + i} style={{ width: cellW, marginRight: gridGap }} />
                      ))
                    : null}
                </View>
              );
            }}
          />
        )
      ) : category === 'feed' ? (
        <ActivityFeed />
      ) : (
        <ScrollView
          ref={discoverRef}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              colors={[tokens.primary]}
              tintColor={tokens.primary}
            />
          }
        >
          {sections.isLoading ? (
            <Spinner />
          ) : (
            <>
              {/* Type filter: Movies hides the shows sections and vice versa. */}
              {mediaType !== 'movies' && (
                <>
                  <Carousel
                    title={t('explore:topShowsForYou')}
                    data={sections.data?.topForYou ?? []}
                    kind="shows"
                    action={t('explore:seeAll')}
                    onAction={() => router.push(moreHref('top-for-you'))}
                  />
                  <Carousel
                    title={t('explore:trendingShows')}
                    data={sections.data?.trendingShows ?? []}
                    kind="shows"
                    action={t('explore:seeAll')}
                    onAction={() => router.push(moreHref('trending-shows'))}
                  />
                </>
              )}
              {mediaType !== 'shows' && (
                <Carousel
                  title={t('explore:trendingMovies')}
                  data={sections.data?.trendingMovies ?? []}
                  kind="movies"
                  action={t('explore:seeAll')}
                  onAction={() => router.push(moreHref('trending-movies'))}
                />
              )}
            </>
          )}
        </ScrollView>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.pill,
    height: 44,
  },
  input: { flex: 1, ...typography.body },
});
