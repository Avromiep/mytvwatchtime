import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import type { PersonCreditDto } from '@tvwatch/shared';
import { Header } from '../../../components/Header';
import {
  Card,
  EmptyState,
  PosterImage,
  Screen,
  SectionHeader,
  Spinner,
  T,
} from '../../../components/primitives';
import { qk, usePerson } from '../../../api/hooks';
import { useAppearance } from '../../../context/PreferencesProvider';
import { useTranslation } from 'react-i18next';
import { radius, spacing } from '../../../theme/theme';
import { formatAirDate } from '../../../lib/format';

export const PERSON_CREDIT_WIDTH = 110;

/** Poster + title + character caption. Taps route to the internal media page when
 *  resolved, else to the numeric-TMDB-id path (hydrates on demand); credits with
 *  neither id render non-tappable. */
export function PersonCreditCard({
  credit,
  kind,
  width = PERSON_CREDIT_WIDTH,
  style,
}: {
  credit: PersonCreditDto;
  kind: 'shows' | 'movies';
  width?: number;
  style?: object;
}) {
  const target = credit.mediaId ?? (credit.tmdbId != null ? String(credit.tmdbId) : null);
  const open = () => {
    if (!target) return;
    router.push(`/${kind === 'shows' ? 'show' : 'movie'}/${target}` as any);
  };
  return (
    <Pressable
      onPress={open}
      disabled={!target}
      style={[{ width, marginRight: spacing.md }, style]}
    >
      <View style={{ borderRadius: radius.md, overflow: 'hidden' }}>
        <PosterImage uri={credit.posterUrl} style={{ width, height: width * 1.5 }} transition={0} />
      </View>
      <T variant="caption" numberOfLines={2} style={{ marginTop: 6 }}>
        {credit.title}
      </T>
      {credit.character ? (
        <T variant="micro" muted numberOfLines={1}>
          {credit.character}
        </T>
      ) : null}
      {credit.year ? (
        <T variant="micro" dim numberOfLines={1}>
          {credit.year}
        </T>
      ) : null}
    </Pressable>
  );
}

export default function PersonScreen() {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['person', 'common']);
  const { id } = useLocalSearchParams<{ id: string }>();
  const qc = useQueryClient();
  const { data, isLoading } = usePerson(id);
  const [bioExpanded, setBioExpanded] = useState(false);

  // Canonicalize to the surviving member id after a server-side duplicate merge,
  // mirroring the show screen's numeric-TMDB-id canonicalization.
  useEffect(() => {
    if (data && id && data.person.id !== id) {
      qc.setQueryData(qk.person(data.person.id), data);
      router.replace(`/person/${data.person.id}` as any);
    }
  }, [data?.person.id]);

  if (isLoading || !data || data.person.id !== id) {
    return (
      <Screen>
        <Header showBack />
        {isLoading || (data && data.person.id !== id) ? (
          <Spinner />
        ) : (
          <EmptyState title={t('person:failedToLoad')} icon="alert-circle-outline" />
        )}
      </Screen>
    );
  }
  const { person } = data;
  const born = person.birthDate ? formatAirDate(person.birthDate) : null;
  const died = person.deathDate ? formatAirDate(person.deathDate) : null;

  const rail = (
    credits: PersonCreditDto[],
    kind: 'shows' | 'movies',
    title: string,
    count: number,
  ) =>
    credits.length ? (
      <View style={{ marginTop: spacing.lg }}>
        <SectionHeader
          title={title}
          action={count > credits.length ? t('common:seeAll') : undefined}
          onAction={() =>
            router.push(`/person/${id}/credits?type=${kind === 'shows' ? 'SHOW' : 'MOVIE'}` as any)
          }
        />
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          {credits.map((c) => (
            <PersonCreditCard
              key={`${c.mediaId ?? c.tmdbId ?? c.title}-${c.character ?? ''}`}
              credit={c}
              kind={kind}
            />
          ))}
        </ScrollView>
      </View>
    ) : null;

  return (
    <Screen>
      <Header showBack title={person.name} />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingTop: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <PosterImage
            uri={person.profileUrl}
            style={{ width: 96, height: 96, borderRadius: 48 }}
          />
          <View style={{ flex: 1, marginLeft: spacing.lg }}>
            <T variant="title" numberOfLines={2}>
              {person.name}
            </T>
            {born ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: spacing.xs }}>
                <Ionicons name="calendar-outline" size={13} color={tokens.textMuted} />
                <T variant="caption" muted style={{ marginLeft: 4 }}>
                  {died
                    ? t('person:bornDied', { born: born ?? '', died })
                    : t('person:bornOn', { date: born })}
                </T>
              </View>
            ) : null}
            {person.birthPlace ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2 }}>
                <Ionicons name="location-outline" size={13} color={tokens.textMuted} />
                <T variant="caption" muted numberOfLines={2} style={{ marginLeft: 4, flex: 1 }}>
                  {person.birthPlace}
                </T>
              </View>
            ) : null}
          </View>
        </View>

        {person.biography ? (
          <Card style={{ marginTop: spacing.lg }}>
            <T variant="h2">{t('person:biography')}</T>
            <T
              variant="body"
              numberOfLines={bioExpanded ? undefined : 5}
              style={{ marginTop: spacing.sm }}
            >
              {person.biography}
            </T>
            <Pressable onPress={() => setBioExpanded((v) => !v)} hitSlop={6}>
              <T variant="caption" style={{ color: tokens.primary, marginTop: spacing.xs }}>
                {bioExpanded ? t('person:showLess') : t('person:showMore')}
              </T>
            </Pressable>
          </Card>
        ) : null}

        {rail(data.movies, 'movies', t('person:movies'), data.movieCount)}
        {rail(data.shows, 'shows', t('person:tvShows'), data.showCount)}

        {!data.movies.length && !data.shows.length ? (
          <T variant="body" muted style={{ marginTop: spacing.lg, textAlign: 'center' }}>
            {t('person:noCredits')}
          </T>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
