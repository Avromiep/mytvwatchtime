import { ExternalProvider, MediaType } from '@tvwatch/shared';
import { MediaMetadataService } from './media-metadata.service';
import { runInLanguage } from '../common/language.context';

/**
 * Focused spec for cross-type protections:
 *  - findMediaByExternal resolves within the expected providerEntityKind (TMDB/TVDB ids
 *    live in separate movie/series namespaces).
 *  - persistShow refuses to merge series data into a MOVIE row (creates a new row).
 *  - upsertGenres keeps English slugs for non-English TVDB hydrations (index fallback).
 */

function makeShow(genres: { tmdbId?: number; name: string }[]) {
  return {
    type: MediaType.SHOW,
    tmdbId: 0,
    title: 'Sonic Boom',
    overview: null,
    posterUrl: null,
    backdropUrl: null,
    status: 'ENDED',
    yearStart: 2014,
    yearEnd: 2017,
    network: null,
    runtimeMinutes: 11,
    rating: 7,
    popularity: 10,
    trailerUrl: null,
    seasonsCount: 1,
    episodesCount: 1,
    inProduction: false,
    genres,
    externals: [{ provider: ExternalProvider.THE_TVDB, value: '280103' }],
    keywords: ['anime'],
    cast: [],
    providers: [],
    nextAirDate: null,
    seasons: [
      {
        number: 1,
        title: 'Season 1',
        overview: null,
        posterUrl: null,
        episodeCount: 1,
        isSpecial: false,
        episodes: [
          {
            number: 1,
            title: 'E1',
            overview: null,
            stillUrl: null,
            runtimeMinutes: 11,
            airDate: '2014-11-08',
            rating: 7,
            isFinale: false,
            tmdbId: 9001,
          },
        ],
      },
    ],
  } as any;
}

function fakeTx(over: Record<string, any> = {}) {
  const calls = {
    mediaItemUpdate: [] as any[],
    mediaItemCreate: [] as any[],
    genreUpsert: [] as any[],
    externalIdUpsert: [] as any[],
    showUpsert: [] as any[],
  };
  const tx: any = {
    mediaItem: {
      findUnique: async () => over.prev ?? null,
      create: async (a: any) => {
        calls.mediaItemCreate.push(a);
        return { id: 'new-row' };
      },
      update: async (a: any) => {
        calls.mediaItemUpdate.push(a);
        return {};
      },
    },
    externalId: {
      upsert: async (a: any) => {
        calls.externalIdUpsert.push(a);
        return {};
      },
    },
    show: {
      upsert: async (a: any) => {
        calls.showUpsert.push(a);
        return {};
      },
      findUnique: async () => ({ id: 'show-1' }),
    },
    genre: {
      findUnique: async () => null,
      upsert: async (a: any) => {
        calls.genreUpsert.push(a);
        return { id: `g-${a.where.slug}` };
      },
    },
    watchProvider: { upsert: async () => ({ id: 'p-1' }) },
    castMember: { upsert: async () => ({ id: 'c-1' }) },
    mediaGenre: { deleteMany: async () => ({}), createMany: async () => ({}) },
    mediaWatchProvider: { deleteMany: async () => ({}), createMany: async () => ({}) },
    mediaCast: {
      findMany: async () => [],
      deleteMany: async () => ({}),
      createMany: async () => ({}),
      create: async () => ({}),
    },
    season: { findMany: async () => [], upsert: async () => ({ id: 'se-1' }) },
    episode: { upsert: async () => ({ id: 'ep-1' }) },
    episodeExternalId: { upsert: async () => ({}) },
  };
  return { tx, calls };
}

function makeService(tx: any, externalFindFirst: jest.Mock, tvdbGetShow?: jest.Mock) {
  const prisma = {
    $transaction: async (fn: any) => fn(tx),
    mediaItem: { findUnique: async () => ({ metadataRefreshedAt: new Date() }) },
    externalId: { findFirst: externalFindFirst },
  };
  const tvdb = {
    enabled: true,
    getShow: tvdbGetShow ?? jest.fn(async () => makeShow([{ name: 'Animation' }])),
  };
  const svc = new MediaMetadataService(
    prisma as any,
    {} as any,
    tvdb as any,
    {} as any,
    {} as any,
    { enqueueClassifyCandidate: async () => undefined } as any,
    { get: async () => null, set: async () => undefined, del: async () => undefined } as any,
  );
  return svc;
}

describe('MediaMetadataService — cross-type protections', () => {
  it('resolves series identity within the SERIES kind only', async () => {
    const { tx } = fakeTx();
    const findFirst = jest.fn(async () => null);
    const svc = makeService(tx, findFirst);
    await runInLanguage('en', () => svc.ensureShowFullTvdb(280103));
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          provider: ExternalProvider.THE_TVDB,
          providerEntityKind: 'SERIES',
          value: '280103',
        },
      }),
    );
  });

  it('refuses to merge series data into a MOVIE row — creates a new show row instead', async () => {
    const { tx, calls } = fakeTx({
      prev: {
        type: 'MOVIE',
        titles: null,
        overviews: null,
        posterUrls: null,
        backdropUrls: null,
        titleLocale: 'en',
      },
    });
    // Kind-aware find resolves the SERIES id to the contaminated movie row.
    const findFirst = jest.fn(async () => ({
      mediaId: 'movie-1',
      media: { id: 'movie-1', type: 'MOVIE', metadataRefreshedAt: null },
    }));
    const svc = makeService(tx, findFirst);
    await runInLanguage('en', () => svc.ensureShowFullTvdb(280103));

    // The movie row is untouched; a NEW show row was created.
    expect(calls.mediaItemUpdate).toHaveLength(0);
    expect(calls.mediaItemCreate).toHaveLength(1);
    expect(calls.mediaItemCreate[0].data.type).toBe(MediaType.SHOW);
  });

  it('keeps the English genre slug for non-English TVDB hydrations (index fallback)', async () => {
    const { tx, calls } = fakeTx();
    const findFirst = jest.fn(async () => null);
    const tvdbGetShow = jest.fn(async (_id: number, lang?: string) =>
      makeShow([{ name: lang === 'en' ? 'Animation' : 'Animazione' }]),
    );
    const svc = makeService(tx, findFirst, tvdbGetShow);
    await runInLanguage('it', () => svc.ensureShowFullTvdb(280103));

    expect(calls.genreUpsert).toHaveLength(1);
    expect(calls.genreUpsert[0].where.slug).toBe('animation');
    expect(calls.genreUpsert[0].create.name).toBe('Animation');
  });

  it('attaches externals via conflict-safe upserts, never a nested create (no P2002 aborts)', async () => {
    const { tx, calls } = fakeTx();
    const findFirst = jest.fn(async () => null);
    const svc = makeService(tx, findFirst);
    await runInLanguage('en', () => svc.ensureShowFullTvdb(280103));

    // The create carries no nested externalIds…
    expect(calls.mediaItemCreate).toHaveLength(1);
    expect(calls.mediaItemCreate[0].data.externalIds).toBeUndefined();
    // …and every external attaches through the upsert loop (conflict → no-op, not abort).
    expect(calls.externalIdUpsert.length).toBeGreaterThan(0);
    for (const u of calls.externalIdUpsert) {
      expect(u.where.provider_providerEntityKind_value.providerEntityKind).toBe('SERIES');
      expect(u.update).toEqual({});
    }
  });
});

describe('MediaMetadataService — single-call TMDB hydration', () => {
  function makeTmdbService(tx: any, getShow: jest.Mock) {
    const prisma = {
      $transaction: async (fn: any) => fn(tx),
      mediaItem: { findUnique: async () => ({ metadataRefreshedAt: new Date() }) },
      externalId: { findFirst: async () => null },
    };
    return new MediaMetadataService(
      prisma as any,
      { enabled: true, getShow } as any, // tmdb provider
      {} as any, // tvdb
      {} as any, // tvmaze
      {} as any, // config
      { enqueueClassifyCandidate: async () => undefined } as any,
      { get: async () => null, set: async () => undefined, del: async () => undefined } as any,
    );
  }

  it('en request: ONE English call, no second fetch', async () => {
    const { tx, calls } = fakeTx();
    const getShow = jest.fn(async () => makeShow([{ name: 'Animation' }]));
    const svc = makeTmdbService(tx, getShow);
    await runInLanguage('en', () => svc.ensureShowFull(65942));
    expect(getShow).toHaveBeenCalledTimes(1);
    expect(getShow).toHaveBeenCalledWith(65942, 'en-US');
    expect(calls.mediaItemCreate).toHaveLength(1);
  });

  it('non-en request: English base once + request-locale overrides once (never two en fetches)', async () => {
    const { tx, calls } = fakeTx();
    const getShow = jest.fn(async (_id: number, lang?: string) =>
      lang === 'it'
        ? { ...makeShow([{ name: 'Animation' }]), title: 'Sonic Boom IT', seasons: [] }
        : {
            ...makeShow([{ name: 'Animation' }]),
            translations: { it: { title: 'Sonic Boom IT', overview: 'panoramica' } },
          },
    );
    const svc = makeTmdbService(tx, getShow);
    await runInLanguage('it', () => svc.ensureShowFull(65942));

    const langs = getShow.mock.calls.map((c) => c[1]);
    expect(langs).toEqual(['en-US', 'it']); // base in English, then one locale pass
    // Translations from the English payload are prestored as per-locale overrides.
    expect(calls.mediaItemCreate[0].data.titles).toMatchObject({ it: 'Sonic Boom IT' });
    expect(calls.mediaItemCreate[0].data.overviews).toMatchObject({ it: 'panoramica' });
    // Show-level keywords persisted for the classifier.
    expect(calls.showUpsert[0].create.keywords).toEqual(['anime']);
  });
});
