import { normalizeTvTimeOutSeries } from './series';

const show = (over: Record<string, unknown> = {}) => ({
  uuid: 'u1',
  id: { tvdb: 100, imdb: null },
  created_at: '2024-01-01T00:00:00Z',
  title: 'Some Show',
  status: 'continuing',
  is_favorite: false,
  seasons: [],
  ...over,
});

const ep = (over: Record<string, unknown> = {}) => ({
  id: { tvdb: 9000, imdb: null },
  number: 1,
  name: 'Pilot',
  special: false,
  is_watched: true,
  watched_at: '2024-02-01T00:00:00Z',
  rewatch_count: 0,
  watched_count: 1,
  ...over,
});

describe('normalizeTvTimeOutSeries', () => {
  it('returns empty results for non-array input', () => {
    const res = normalizeTvTimeOutSeries({ nope: true });
    expect(res.episodes).toHaveLength(0);
    expect(res.watchlist).toHaveLength(0);
    expect(res.favorites).toHaveLength(0);
    expect(res.invalid).toBe(0);
  });

  it('stages only watched episodes with watchCount from watched_count/rewatch_count', () => {
    const res = normalizeTvTimeOutSeries([
      show({
        seasons: [
          {
            number: 1,
            is_specials: false,
            episodes: [
              ep({ number: 1, watched_count: 3, rewatch_count: 0 }),
              ep({ number: 2, watched_count: 1, rewatch_count: 2 }),
              ep({ number: 3, is_watched: false, watched_at: null, watched_count: 0 }),
            ],
          },
        ],
      }),
    ]);
    expect(res.episodes).toHaveLength(2);
    expect(res.episodes[0]).toMatchObject({ season: 1, episode: 1, watchCount: 3 });
    expect(res.episodes[1]).toMatchObject({ season: 1, episode: 2, watchCount: 3 });
    expect(res.episodes[0].watchedAt).toBeInstanceOf(Date);
    expect(res.watchlist).toHaveLength(0);
  });

  it('marks specials from the episode flag AND is_specials seasons; footprint excludes them', () => {
    const res = normalizeTvTimeOutSeries([
      show({
        seasons: [
          {
            number: 1,
            is_specials: false,
            episodes: [
              ep({ number: 1 }),
              ep({ number: 2 }),
              ep({ number: 9, special: true }),
            ],
          },
          {
            number: 0,
            is_specials: true,
            episodes: [ep({ number: 1 })],
          },
        ],
      }),
    ]);
    const specials = res.episodes.filter((e) => e.special);
    expect(specials).toHaveLength(2); // s1e9 flagged + s0 via is_specials season
    const fp = res.footprints.get('tvdb:100')!;
    expect(fp.maxSeason).toBe(1);
    expect(fp.seasonEpisodes).toEqual([{ season: 1, maxEpisode: 2 }]);
  });

  it('puts fully-unwatched shows on the watchlist and favorites independently', () => {
    const res = normalizeTvTimeOutSeries([
      show({ title: 'Unwatched Fav', is_favorite: true }),
      show({ id: { tvdb: 200, imdb: null }, title: 'Unwatched' }),
      show({
        id: { tvdb: 300, imdb: null },
        title: 'Watched',
        seasons: [{ number: 1, is_specials: false, episodes: [ep()] }],
      }),
    ]);
    expect(res.watchlist.map((c) => c.title)).toEqual(['Unwatched Fav', 'Unwatched']);
    expect(res.watchlist.every((c) => c.type === 'show')).toBe(true);
    expect(res.favorites.map((c) => c.title)).toEqual(['Unwatched Fav']);
    expect(res.watchlist[0].listedAt).toBeInstanceOf(Date);
  });

  it('counts invalid rows without throwing', () => {
    const res = normalizeTvTimeOutSeries([
      { id: { tvdb: 1 } }, // no title
      show({
        title: 'Broken',
        seasons: [{ number: 1, is_specials: false, episodes: [{ id: { tvdb: 5 } }] }],
      }),
    ]);
    expect(res.invalid).toBe(2);
    expect(res.episodes).toHaveLength(0);
  });

  it('does not import the show-level status', () => {
    const res = normalizeTvTimeOutSeries([show({ status: 'up_to_date' })]);
    expect(res.watchlist[0]).not.toHaveProperty('status');
  });
});
