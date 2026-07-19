import { ExternalProvider } from '@tvwatch/shared';
import { TmdbProvider } from './tmdb.provider';

/** getShow/getMovie: appended seasons/keywords/translations in one call + fallbacks. */

function makeClient(responses: Record<string, any>) {
  return {
    enabled: true,
    img: (p?: string | null, size = 'w500') => (p ? `img:${size}:${p}` : null),
    get: jest.fn(async (path: string, _params?: any, _lang?: string) => {
      if (responses[path]) return responses[path];
      throw new Error(`unexpected TMDB call: ${path}`);
    }),
  } as any;
}

const showPayload = (over: Record<string, any> = {}) => ({
  id: 65942,
  name: 'Re:ZERO',
  overview: 'en overview',
  seasons: [
    { id: 76465, season_number: 0, name: 'Specials', episode_count: 77 },
    { id: 75470, season_number: 1, name: 'Season 1', episode_count: 85 },
  ],
  keywords: { results: [{ name: 'anime' }, { name: 'isekai' }] },
  translations: {
    translations: [
      { iso_639_1: 'it', data: { name: 'Re:ZERO IT', overview: 'panoramica' } },
      { iso_639_1: 'ja', data: { name: '', overview: 'ja overview only' } },
    ],
  },
  external_ids: { imdb_id: 'tt5607616', tvdb_id: 305089 },
  ...over,
});

const seasonPayload = (count: number) => ({
  episodes: Array.from({ length: count }, (_, i) => ({
    id: 9000 + i,
    episode_number: i + 1,
    name: `E${i + 1}`,
    air_date: '2016-04-04',
  })),
});

describe('TmdbProvider.getShow', () => {
  it('reads appended seasons, keywords and translations from ONE call', async () => {
    const client = makeClient({
      '/tv/65942': showPayload({ 'season/0': seasonPayload(77), 'season/1': seasonPayload(85) }),
    });
    const provider = new TmdbProvider(client);
    const show = await provider.getShow(65942, 'en-US');

    expect(client.get).toHaveBeenCalledTimes(1);
    expect(show.seasons).toHaveLength(2);
    expect(show.seasons[0].episodes).toHaveLength(77);
    expect(show.seasons[0].isSpecial).toBe(true);
    expect(show.seasons[1].episodes).toHaveLength(85);
    expect(show.keywords).toEqual(['anime', 'isekai']);
    expect(show.translations?.it).toEqual({ title: 'Re:ZERO IT', overview: 'panoramica' });
    expect(show.translations?.ja).toEqual({ title: undefined, overview: 'ja overview only' });
    expect(show.externals).toContainEqual({ provider: ExternalProvider.THE_TVDB, value: '305089' });
  });

  it('falls back to the per-season endpoint when an appended season is missing', async () => {
    const client = makeClient({
      '/tv/65942': showPayload({ 'season/0': seasonPayload(2) }), // season/1 NOT appended
      '/tv/65942/season/1': seasonPayload(85),
    });
    const provider = new TmdbProvider(client);
    const show = await provider.getShow(65942, 'en-US');

    expect(show.seasons[1].episodes).toHaveLength(85);
    expect(client.get).toHaveBeenCalledWith('/tv/65942/season/1', {}, 'en-US');
  });

  it('ignores an appended season with an empty episode list and falls back', async () => {
    const client = makeClient({
      '/tv/65942': showPayload({ 'season/0': seasonPayload(2), 'season/1': { episodes: [] } }),
      '/tv/65942/season/1': seasonPayload(85),
    });
    const provider = new TmdbProvider(client);
    const show = await provider.getShow(65942, 'en-US');

    expect(show.seasons[1].episodes).toHaveLength(85);
  });

  it('joins up to two TMDB networks into the single network string', async () => {
    const client = makeClient({
      '/tv/65942': showPayload({
        networks: [
          { id: 98, name: 'TV Tokyo' },
          { id: 173, name: 'AT-X' },
          { id: 999, name: 'Third' },
        ],
        'season/0': seasonPayload(77),
        'season/1': seasonPayload(85),
      }),
    });
    const provider = new TmdbProvider(client);
    const show = await provider.getShow(65942, 'en-US');

    expect(show.network).toBe('TV Tokyo · AT-X');
  });

  it('keeps network null when the show has none', async () => {
    const client = makeClient({
      '/tv/65942': showPayload({ 'season/0': seasonPayload(77), 'season/1': seasonPayload(85) }),
    });
    const provider = new TmdbProvider(client);
    const show = await provider.getShow(65942, 'en-US');

    expect(show.network).toBeNull();
  });
});

describe('TmdbProvider.getMovie', () => {
  it('parses movie-shaped keywords and translations in one call', async () => {
    const client = makeClient({
      '/movie/62211': {
        id: 62211,
        title: 'Monsters University',
        keywords: { keywords: [{ name: 'anime' }] },
        translations: { translations: [{ iso_639_1: 'fr', data: { name: 'Monstres Academy' } }] },
        external_ids: { imdb_id: 'tt3232262' },
      },
    });
    const provider = new TmdbProvider(client);
    const movie = await provider.getMovie(62211, 'en-US');

    expect(client.get).toHaveBeenCalledTimes(1);
    expect(movie.keywords).toEqual(['anime']);
    expect(movie.translations?.fr).toEqual({ title: 'Monstres Academy', overview: undefined });
  });
});
