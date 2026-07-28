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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { MediaCardDto, MediaType } from '@tvwatch/shared';
import { Header } from '../Header';
import { Button, Chip, Screen, Spinner, T, EmptyState } from '../primitives';
import { SelectablePosterCard, PosterSelectState } from './SelectablePosterCard';
import { useDiscoverSections, useSearch } from '../../api/hooks';
import { useAuth } from '../../context/AuthContext';
import { useAppearance } from '../../context/PreferencesProvider';
import { useOnboardingDraft } from '../../lib/onboarding/useOnboardingDraft';
import { useSkipSetup } from '../../lib/onboarding/useSkipSetup';
import { OnboardingDraft, selectionCounts } from '../../lib/onboarding/draft';
import { logEvent } from '../../lib/analytics';
import { showToast } from '../../lib/toast';
import { radius, spacing } from '../../theme/theme';

export type PickerMode = 'WATCHED' | 'WATCHLIST';
type Tab = 'shows' | 'movies';

/**
 * Shared single-purpose title picker: the watched screen selects watched titles
 * (green), the watchlist screen selects watchlist titles (orange + bookmark).
 * One draft powers both, so Shows/Movies tab switches and back-navigation keep
 * every selection. The two screens never convert each other's picks silently:
 * the watchlist screen refuses watched picks with a toast.
 */
export function TitlePicker({
  mode,
  initialTab = 'shows',
  onContinue,
}: {
  mode: PickerMode;
  initialTab?: Tab;
  /** Receives the LIVE draft (the caller must not hold a second draft instance). */
  onContinue: (draft: OnboardingDraft) => void;
}) {
  const { t } = useTranslation(['onboarding', 'common']);
  const { tokens } = useAppearance();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const { draft, ready, act, flush } = useOnboardingDraft(user?.id);
  const { skip, pending: skipPending } = useSkipSetup();

  const [tab, setTab] = useState<Tab>(initialTab);
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(q.trim()), 400);
    return () => clearTimeout(timer);
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
  const modeCount =
    mode === 'WATCHED'
      ? counts.showsWatched + counts.moviesWatched
      : counts.showsWatchlisted + counts.moviesWatchlisted;

  const stateFor = (id: string, type: MediaType): PosterSelectState => {
    const entry = type === MediaType.SHOW ? draft.shows[id] : draft.movies[id];
    if (!entry) return 'NONE';
    const watched = entry.action !== 'WATCHLIST';
    // The watched screen only reflects watched picks (no bookmark icon here);
    // the watchlist screen shows watched picks green so they read as taken.
    if (mode === 'WATCHED') return watched ? 'WATCHED' : 'NONE';
    return watched ? 'WATCHED' : 'WATCHLIST';
  };

  const trackedHintFor = (item: MediaCardDto): string | null => {
    if (stateFor(item.id, item.type) !== 'NONE') return null;
    if (item.inWatchlist) return t('onboarding:inWatchlist');
    if (item.type === MediaType.MOVIE && item.watched) return t('onboarding:alreadyWatched');
    if (item.type === MediaType.SHOW && (item.userProgress ?? 0) > 0)
      return t('onboarding:inProgress');
    return null;
  };

  const metaFor = (item: MediaCardDto) => ({
    title: item.title,
    poster: item.images?.poster ?? item.images?.backdrop ?? null,
    year: item.type === MediaType.SHOW ? (item.yearStart ?? null) : (item.releaseYear ?? null),
    type: item.type,
  });

  const toggle = (item: MediaCardDto) => {
    const entry = item.type === MediaType.SHOW ? draft.shows[item.id] : draft.movies[item.id];
    if (mode === 'WATCHED') {
      act({ type: 'toggleWatched', id: item.id, mediaType: item.type, meta: metaFor(item) });
      // Log only genuine new selections (including watchlist→watched conversions).
      if (!entry || entry.action === 'WATCHLIST') logEvent('onboarding_watched_title_selected');
      return;
    }
    if (entry && entry.action !== 'WATCHLIST') {
      // Watched wins: never silently convert — small non-blocking message.
      showToast(t('onboarding:alreadyWatchedToast'));
      return;
    }
    act({ type: 'toggleWatchlist', id: item.id, mediaType: item.type, meta: metaFor(item) });
    if (!entry) logEvent('onboarding_watchlist_title_selected');
  };

  const loading = searching ? search.isLoading : sections.isLoading;
  const errored = searching ? search.isError : sections.isError;

  return (
    <Screen>
      <Header
        title={t(mode === 'WATCHED' ? 'onboarding:watchedTitle' : 'onboarding:watchlistTitle')}
        showBack
        right={
          <Pressable
            onPress={() => skip(counts.total > 0)}
            hitSlop={10}
            accessibilityRole="button"
          >
            {skipPending ? (
              <Spinner />
            ) : (
              <T variant="caption" style={{ color: tokens.primary }}>
                {t('onboarding:skipSetup')}
              </T>
            )}
          </Pressable>
        }
      />
      <T variant="body" muted style={styles.body}>
        {t(mode === 'WATCHED' ? 'onboarding:watchedBody' : 'onboarding:watchlistBody')}
      </T>

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

      {/* Shows / Movies tabs (selections survive the switch — one shared draft) */}
      <View style={styles.controls}>
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
      <T variant="micro" muted style={styles.sectionLabel}>
        {t(searching ? 'onboarding:searchResults' : 'onboarding:popularNow')}
      </T>

      {/* Grid */}
      {!ready || loading ? (
        <PosterSkeleton cols={cols} cellW={cellW} gap={gridGap} />
      ) : errored ? (
        <EmptyState
          icon="cloud-offline-outline"
          title={t('onboarding:loadErrorTitle')}
          subtitle={t('onboarding:loadErrorBody')}
          cta={t('common:tryAgain')}
          onCta={() => (searching ? search.refetch() : sections.refetch())}
        />
      ) : (
        <FlatList
          data={rows}
          key={`grid-${cols}-${tab}`}
          contentContainerStyle={{
            paddingHorizontal: spacing.lg,
            paddingBottom: 96 + insets.bottom,
          }}
          keyExtractor={(row) => row[0]?.id ?? 'row'}
          initialNumToRender={8}
          maxToRenderPerBatch={8}
          windowSize={7}
          ListEmptyComponent={
            searching ? (
              <EmptyState
                icon="search-outline"
                title={t('onboarding:noResultsTitle')}
                subtitle={t('onboarding:noResultsBody')}
              />
            ) : (
              <EmptyState icon="film-outline" title={t('onboarding:noSuggestions')} />
            )
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

      {/* Sticky footer — always visible; primary action adapts to the selection */}
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
        <Button
          title={
            modeCount > 0
              ? t(mode === 'WATCHED' ? 'onboarding:continueWatched' : 'onboarding:continueSaved', {
                  count: modeCount,
                })
              : t(mode === 'WATCHED' ? 'onboarding:skipWatched' : 'onboarding:skipWatchlist')
          }
          onPress={() => {
            flush(); // next screen hydrates from AsyncStorage — persist first
            onContinue(draft);
          }}
          style={{ flex: 1 }}
        />
      </View>
    </Screen>
  );
}

/** Poster-grid skeleton while suggestions/search load — no blank screens. */
function PosterSkeleton({ cols, cellW, gap }: { cols: number; cellW: number; gap: number }) {
  const { tokens } = useAppearance();
  const rows = 4;
  return (
    <View style={{ paddingHorizontal: spacing.lg }}>
      {Array.from({ length: rows }).map((_, r) => (
        <View key={r} style={{ flexDirection: 'row' }}>
          {Array.from({ length: cols }).map((_, c) => (
            <View
              key={c}
              style={{
                width: cellW,
                height: Math.round(cellW * 1.5),
                marginRight: gap,
                marginBottom: gap,
                borderRadius: radius.md,
                backgroundColor: tokens.surfaceElevated,
              }}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xs },
  searchWrap: { paddingHorizontal: spacing.lg, paddingTop: spacing.xs },
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
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    gap: spacing.xs,
  },
  sectionLabel: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.xs },
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
