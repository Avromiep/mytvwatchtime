import React, { useMemo } from 'react';
import { ActivityIndicator, FlatList, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import type { PersonCreditDto } from '@tvwatch/shared';
import { Header } from '../../../components/Header';
import { PosterCard } from '../../../components/cards';
import { EmptyState, PosterImage, Screen, Spinner, T } from '../../../components/primitives';
import { usePerson, usePersonCredits } from '../../../api/hooks';
import { useAppearance } from '../../../context/PreferencesProvider';
import { useContentWidth } from '../../../hooks/useContentWidth';
import { useTranslation } from 'react-i18next';
import { radius, spacing } from '../../../theme/theme';

/** Same responsive density as the explore/trending see-all grids (more.tsx). */
function useColumns() {
  const width = useContentWidth();
  if (width >= 1200) return 6;
  if (width >= 900) return 5;
  if (width >= 768) return 4;
  return 3;
}

/** PosterCard lookalike for the rare credit with no resolvable route id at all —
 *  renders the same dimensions, just non-tappable. */
function StaticCreditCard({ credit, width }: { credit: PersonCreditDto; width: number }) {
  const { tokens } = useAppearance();
  return (
    <View style={{ width, marginRight: spacing.md }}>
      <View style={{ borderRadius: radius.md, overflow: 'hidden' }}>
        <PosterImage uri={credit.posterUrl} style={{ width, height: width * 1.5 }} transition={0} />
        {/* Same star badge as PosterCard. */}
        {credit.rating != null && credit.rating > 0 ? (
          <View
            style={{
              position: 'absolute',
              top: 4,
              left: 4,
              flexDirection: 'row',
              alignItems: 'center',
              backgroundColor: tokens.mediaScrim,
              borderRadius: radius.sm,
              paddingHorizontal: 4,
              paddingVertical: 2,
            }}
          >
            <Ionicons name="star" size={10} color={tokens.warning} />
            <T variant="micro" style={{ color: tokens.mediaText, marginLeft: 2 }}>
              {credit.rating.toFixed(1)}
            </T>
          </View>
        ) : null}
      </View>
      <T variant="caption" numberOfLines={2} style={{ marginTop: 6 }}>
        {credit.title}
      </T>
      {credit.year ? (
        <T variant="micro" muted numberOfLines={1}>
          {credit.year}
        </T>
      ) : null}
    </View>
  );
}

/** "See all" grid for one filmography type — same chunked-row grid as more.tsx
 *  (never FlatList numColumns / flexWrap+gap, see AGENTS.md). */
export default function PersonCreditsScreen() {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['person', 'common']);
  const { id, type } = useLocalSearchParams<{ id: string; type: 'MOVIE' | 'SHOW' }>();
  const kind = type === 'SHOW' ? 'shows' : 'movies';
  const person = usePerson(id);
  const query = usePersonCredits(id, type === 'SHOW' ? 'SHOW' : 'MOVIE');
  const items = useMemo(() => (query.data?.pages ?? []).flatMap((p) => p.items), [query.data]);

  const cols = useColumns();
  const screenWidth = useContentWidth();
  const containerW = Math.min(screenWidth - spacing.lg * 2, 1200);
  const cardW = Math.floor((containerW - spacing.md * (cols - 1)) / cols);

  const rows = useMemo(() => {
    const out: { key: string; cards: PersonCreditDto[] }[] = [];
    for (let i = 0; i < items.length; i += cols) {
      out.push({ key: `row_${i}`, cards: items.slice(i, i + cols) });
    }
    return out;
  }, [items, cols]);

  const name = person.data?.person.name ?? '';
  const title = `${name} — ${type === 'SHOW' ? t('person:tvShows') : t('person:movies')}`;

  if (query.isLoading) {
    return (
      <Screen>
        <Header showBack title={title} />
        <Spinner />
      </Screen>
    );
  }

  return (
    <Screen>
      <Header showBack title={title} />
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
        ListEmptyComponent={<EmptyState title={t('person:noCredits')} icon="film-outline" />}
        onEndReachedThreshold={0.5}
        onEndReached={() => {
          if (query.hasNextPage && !query.isFetchingNextPage) query.fetchNextPage();
        }}
        ListFooterComponent={
          query.isFetchingNextPage ? (
            <ActivityIndicator color={tokens.primary} style={{ padding: spacing.lg }} />
          ) : null
        }
        renderItem={({ item: row }) => {
          const fillCount = cols - row.cards.length;
          return (
            <View style={{ flexDirection: 'row', marginBottom: spacing.md }}>
              {row.cards.map((credit) => {
                const target =
                  credit.mediaId ?? (credit.tmdbId != null ? String(credit.tmdbId) : null);
                const key = `${credit.mediaId ?? credit.tmdbId ?? credit.title}-${credit.character ?? ''}`;
                return target ? (
                  <PosterCard
                    key={key}
                    id={target}
                    kind={kind}
                    title={credit.title}
                    poster={credit.posterUrl}
                    rating={credit.rating}
                    year={credit.year}
                    width={cardW}
                    style={{ marginRight: spacing.md }}
                  />
                ) : (
                  <StaticCreditCard key={key} credit={credit} width={cardW} />
                );
              })}
              {Array.from({ length: fillCount }).map((_, i) => (
                <View key={`pad_${i}`} style={{ width: cardW, marginRight: spacing.md }} />
              ))}
            </View>
          );
        }}
      />
    </Screen>
  );
}
