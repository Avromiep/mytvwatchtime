import React, { useEffect, useMemo, useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { MediaCardDto, MediaType, ONBOARDING_VERSION } from '@tvwatch/shared';
import { Header } from '../../components/Header';
import { Button, Chip, Screen, Spinner, T, EmptyState } from '../../components/primitives';
import { SelectablePosterCard, PosterSelectState } from '../../components/onboarding/SelectablePosterCard';
import { useDiscoverSections, useSearch, useUpdateOnboardingState } from '../../api/hooks';
import { useAuth } from '../../context/AuthContext';
import { useAppearance } from '../../context/PreferencesProvider';
import { useOnboardingDraft } from '../../lib/onboarding/useOnboardingDraft';
import {
  OnboardingMode,
  needsProgressReview,
  selectionCounts,
} from '../../lib/onboarding/draft';
import { logEvent, logFirstEvent } from '../../lib/analytics';
import { showError } from '../../lib/dialog';
import { radius, spacing } from '../../theme/theme';

type Tab = 'shows' | 'movies';

export default function OnboardingSelect() {
  const { t } = useTranslation(['onboarding', 'common']);
  const { tokens } = useAppearance();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { user, refreshUser } = useAuth();
  const update = useUpdateOnboardingState();
  const { draft, ready, act } = useOnboardingDraft(user?.id);

  const [tab, setTab] = useState<Tab>('shows');
  const [mode, setMode] = useState<OnboardingMode>('WATCHED');
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 400);
    return () => clearTimeout(t);
  }, [q]);

  const searching = debouncedQ.length > 1;
  const searchType = tab === 'shows' ? MediaType.SHOW : MediaType.MOVIE;
  const search = useSearch(debouncedQ, searchType);
  const sections = useDiscoverSections(user?.id);

  // Initial content: personalized picks + trending for the active tab, deduped.
  const browseItems = useMemo(() => {
    const type = tab === 'shows' ? MediaType.SHOW : MediaType.MOVIE;
    const trending = tab === 'shows' ? sections.data?.trendingShows : sections.data?.trendingMovies;
    const merged = [...(sections.data?.topForYou ?? []), ...(trending ?? [])].filter(
      (i) => i.type === type,
    );
    const seen = new Set<string>();
    return merged.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
  }, [sections.data, tab]);

  const items: MediaCardDto[] = searching
    ? (search.data?.pages ?? []).flatMap((p) => p.items ?? [])
    : browseItems;

  // Adaptive chunked-row grid (repo grid pattern — no numColumns/flexWrap).
  const containerW = Math.max(0, width - spacing.lg * 2);
  const gridGap = spacing.sm;
  const cols = Math.max(2, Math.floor((containerW + gridGap) / (110 + gridGap)));
  const cellW = Math.floor((containerW - gridGap * (cols - 1)) / cols);
  const rows: MediaCardDto[][] = [];
  for (let i = 0; i < items.length; i += cols) rows.push(items.slice(i, i + cols));

  const counts = selectionCounts(draft);

  const stateFor = (id: string, type: MediaType): PosterSelectState => {
    const entry = type === MediaType.SHOW ? draft.shows[id] : draft.movies[id];
    if (!entry) return 'NONE';
    return entry.action === 'WATCHLIST' ? 'WATCHLIST' : 'WATCHED';
  };

  const trackedHintFor = (item: MediaCardDto): string | null => {
    const alreadySelected = stateFor(item.id, item.type) !== 'NONE';
    if (alreadySelected) return null;
    if (item.inWatchlist) return t('onboarding:inWatchlist');
    if (item.type === MediaType.MOVIE && item.watched) return t('onboarding:alreadyWatched');
    if (item.type === MediaType.SHOW && (item.userProgress ?? 0) > 0)
      return t('onboarding:inProgress');
    return null;
  };

  const toggle = (item: MediaCardDto) => {
    const wasSelected = stateFor(item.id, item.type) !== 'NONE';
    act({
      type: 'toggle',
      id: item.id,
      mediaType: item.type,
      mode,
      meta: {
        title: item.title,
        poster: item.images?.poster ?? item.images?.backdrop ?? null,
        year: item.type === MediaType.SHOW ? (item.yearStart ?? null) : (item.releaseYear ?? null),
        type: item.type,
      },
    });
    if (!wasSelected) logEvent('onboarding_title_selected');
  };

  const onSkip = async () => {
    logFirstEvent('onboarding_skipped', user?.id);
    try {
      await update.mutateAsync({ status: 'SKIPPED', version: ONBOARDING_VERSION });
      await refreshUser();
      router.replace('/(tabs)/shows');
    } catch {
      showError({ description: t('onboarding:skipFailed') });
    }
  };

  const onReview = () => {
    router.push((needsProgressReview(draft) ? '/onboarding/progress' : '/onboarding/review') as any);
  };

  const loading = searching ? search.isLoading : sections.isLoading;
  const errored = searching ? search.isError : sections.isError;

  return (
    <Screen>
      <Header
        title={t('onboarding:selectTitle')}
        right={
          <Pressable onPress={onSkip} hitSlop={10} accessibilityRole="button">
            {update.isPending ? (
              <Spinner />
            ) : (
              <T variant="caption" style={{ color: tokens.primary }}>
                {t('onboarding:skipForNow')}
              </T>
            )}
          </Pressable>
        }
      />

      {/* Search */}
      <View style={styles.searchWrap}>
        <View
          style={[
            styles.searchBox,
            { backgroundColor: tokens.surfaceElevated, borderColor: tokens.border },
          ]}
        >
          <Ionicons name="search" size={18} color={tokens.textMuted} />
          <TextInput
            value={q}
            onChangeText={setQ}
            placeholder={t('onboarding:searchPlaceholder')}
            placeholderTextColor={tokens.placeholder}
            style={[styles.searchInput, { color: tokens.textPrimary }]}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            accessibilityLabel={t('onboarding:searchPlaceholder')}
          />
          {q.length > 0 ? (
            <Pressable onPress={() => setQ('')} hitSlop={10} accessibilityRole="button">
              <Ionicons name="close-circle" size={18} color={tokens.textMuted} />
            </Pressable>
          ) : null}
        </View>
      </View>

      {/* Shows / Movies tabs + mode selector */}
      <View style={styles.controls}>
        <View style={{ flexDirection: 'row' }}>
          <Chip
            label={t('onboarding:tabShows')}
            active={tab === 'shows'}
            onPress={() => setTab('shows')}
          />
          <Chip
            label={t('onboarding:tabMovies')}
            active={tab === 'movies'}
            onPress={() => setTab('movies')}
          />
        </View>
        <View style={{ flexDirection: 'row' }}>
          <Chip
            label={t('onboarding:modeWatched')}
            active={mode === 'WATCHED'}
            color={mode === 'WATCHED' ? tokens.watched : undefined}
            onPress={() => setMode('WATCHED')}
          />
          <Chip
            label={t('onboarding:modeWatchlist')}
            active={mode === 'WATCHLIST'}
            color={mode === 'WATCHLIST' ? tokens.warning : undefined}
            onPress={() => setMode('WATCHLIST')}
          />
        </View>
      </View>
      <T variant="micro" muted style={styles.modeHint}>
        {mode === 'WATCHED' ? t('onboarding:modeWatchedHint') : t('onboarding:modeWatchlistHint')}
      </T>

      {/* Grid */}
      {!ready || loading ? (
        <Spinner />
      ) : errored ? (
        <EmptyState
          icon="cloud-offline-outline"
          title={t('onboarding:loadErrorTitle')}
          subtitle={t('onboarding:loadErrorDesc')}
          cta={t('common:tryAgain')}
          onCta={() => (searching ? search.refetch() : sections.refetch())}
        />
      ) : (
        <FlatList
          data={rows}
          key={`grid-${cols}-${tab}`}
          contentContainerStyle={{
            padding: spacing.lg,
            paddingBottom: 96 + insets.bottom,
          }}
          keyExtractor={(row) => row[0]?.id ?? 'row'}
          initialNumToRender={8}
          maxToRenderPerBatch={8}
          windowSize={7}
          ListEmptyComponent={
            <EmptyState
              icon="search-outline"
              title={searching ? t('onboarding:noResults') : t('onboarding:noSuggestions')}
            />
          }
          onEndReached={() => {
            if (searching && search.hasNextPage && !search.isFetchingNextPage)
              search.fetchNextPage();
          }}
          onEndReachedThreshold={0.6}
          ListFooterComponent={searching && search.isFetchingNextPage ? <Spinner /> : null}
          renderItem={({ item: row }) => {
            const fill = cols - row.length;
            return (
              <View style={{ flexDirection: 'row' }}>
                {row.map((item) => (
                  <View
                    key={item.id}
                    style={{ width: cellW, marginRight: gridGap, marginBottom: gridGap }}
                  >
                    <SelectablePosterCard
                      title={item.title}
                      poster={item.images?.poster ?? item.images?.backdrop}
                      year={
                        item.type === MediaType.SHOW
                          ? (item.yearStart ?? null)
                          : (item.releaseYear ?? null)
                      }
                      state={stateFor(item.id, item.type)}
                      trackedHint={trackedHintFor(item)}
                      onToggle={() => toggle(item)}
                      width={cellW}
                      accessibilityLabel={t('onboarding:a11yToggle', {
                        title: item.title,
                        mode:
                          mode === 'WATCHED'
                            ? t('onboarding:modeWatched')
                            : t('onboarding:modeWatchlist'),
                      })}
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
      )}

      {/* Sticky review action */}
      {counts.total > 0 ? (
        <View
          style={[
            styles.stickyBar,
            {
              backgroundColor: tokens.cardBackground,
              borderTopColor: tokens.divider,
              paddingBottom: insets.bottom + spacing.md,
            },
          ]}
        >
          <View style={{ flex: 1 }}>
            <T variant="caption">
              {t('onboarding:selectionSummary', {
                watched: counts.showsWatched + counts.moviesWatched,
                watchlist: counts.showsWatchlisted + counts.moviesWatchlisted,
              })}
            </T>
          </View>
          <Button
            title={t('onboarding:reviewSelections', { count: counts.total })}
            onPress={onReview}
            style={{ flexShrink: 1 }}
          />
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  searchWrap: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    minHeight: 44,
  },
  searchInput: { flex: 1, paddingVertical: spacing.sm },
  controls: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  modeHint: { paddingHorizontal: spacing.lg, paddingTop: spacing.xs },
  stickyBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderTopWidth: 1,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
});
