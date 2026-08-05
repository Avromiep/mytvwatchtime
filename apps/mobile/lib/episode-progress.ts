export interface EpisodeProgressItem {
  id: string;
  number: number;
  watched?: boolean;
  airDate?: string | Date | null;
}

export interface SeasonProgressItem {
  number: number;
  isSpecial?: boolean;
  episodes?: EpisodeProgressItem[];
}

/** Count earlier aired, non-special episodes that are not yet watched. */
export function countUnwatchedPreviousEpisodes(
  seasons: SeasonProgressItem[] | undefined,
  seasonNumber: number,
  episodeNumber: number,
  now = new Date(),
): number {
  if (!seasons || seasonNumber === 0) return 0;

  return seasons.reduce((count, season) => {
    if (season.isSpecial || season.number === 0 || season.number > seasonNumber) return count;
    return (
      count +
      (season.episodes ?? []).filter((episode) => {
        const earlier =
          season.number < seasonNumber ||
          (season.number === seasonNumber && episode.number < episodeNumber);
        if (!earlier || episode.watched || !episode.airDate) return false;
        const airTime = new Date(episode.airDate).getTime();
        return Number.isFinite(airTime) && airTime <= now.getTime();
      }).length
    );
  }, 0);
}
