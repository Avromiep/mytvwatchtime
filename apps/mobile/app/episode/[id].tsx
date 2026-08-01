import React, { useMemo } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { Header } from '../../components/Header';
import { Screen, Spinner } from '../../components/primitives';
import { EpisodeDetailContent } from '../../components/EpisodeDetailContent';
import { EpisodePager } from '../../components/EpisodePager';
import { useEpisode, useEpisodeSiblings } from '../../api/hooks';

export default function EpisodeDetailScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  // EpisodePager keeps swipe navigation local and does not rewrite the route. When the
  // app navigates to a different /episode/:id screen in the same mounted web route,
  // the URL param must therefore become the new entry id immediately.
  const initialId = params.id;

  // Bootstrap: load the entry episode + the lightweight season-sibling ids (no full
  // show-structure download just to page within the season).
  const { data: ep, isLoading } = useEpisode(initialId);
  const { data: siblings } = useEpisodeSiblings(initialId);

  // Ordered episode ids within the same season.
  const episodeIds = useMemo(() => {
    if (!siblings || siblings.episodeIds.length === 0) return null;
    return siblings.episodeIds;
  }, [siblings]);

  if (isLoading) {
    return (
      <Screen>
        <Header showBack />
        <Spinner />
      </Screen>
    );
  }
  if (!ep) {
    return <EpisodeDetailContent episodeId={initialId} />;
  }

  // No season siblings (or still resolving): show a single detail without paging.
  if (!episodeIds || episodeIds.length <= 1 || !episodeIds.includes(initialId)) {
    return <EpisodeDetailContent episodeId={initialId} />;
  }

  // Remount the pager when a new route id is opened so its index cannot remain parked
  // on the episode from the previous URL.
  return <EpisodePager key={initialId} episodeIds={episodeIds} initialId={initialId} />;
}
