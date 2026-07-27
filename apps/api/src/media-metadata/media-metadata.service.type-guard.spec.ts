import { ExternalProvider, MediaType } from '@tvwatch/shared';
import { MediaMetadataService } from './media-metadata.service';
import { runInLanguage } from '../common/language.context';
import { EN_CONTENT_VERIFIER_VERSION } from './util/en-content-verifier';

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
    movie: { findUnique: async () => null, upsert: async () => ({}) },
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

function makeTmdbService(tx: any, getShow: jest.Mock, externalFindFirst?: jest.Mock) {
  const prisma = {
    $transaction: async (fn: any) => fn(tx),
    mediaItem: { findUnique: async () => ({ metadataRefreshedAt: new Date() }) },
    externalId: { findFirst: externalFindFirst ?? (async () => null) },
    // Read by airedSeasonSkipper on re-hydration — no stored seasons here.
    season: { findMany: async () => [] },
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
  it('en request: ONE English call, no second fetch', async () => {
    const { tx, calls } = fakeTx();
    const getShow = jest.fn(async () => makeShow([{ name: 'Animation' }]));
    const svc = makeTmdbService(tx, getShow);
    await runInLanguage('en', () => svc.ensureShowFull(65942));
    expect(getShow).toHaveBeenCalledTimes(1);
    // Third arg = skipSeasonDetail opts — absent on the create path (nothing stored yet).
    expect(getShow).toHaveBeenCalledWith(65942, 'en-US', undefined);
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

describe('MediaMetadataService — titleLocale marker', () => {
  // The marker must describe the base JUST WRITTEN — never inherit a stale one.
  // Regression: persistShow/persistMovie used `prev?.titleLocale ?? lang`, so an English
  // re-hydration (enData === undefined on the TMDB path) kept a non-en marker forever and
  // the "Non-English base" health stat never dropped after a successful repair.

  const staleShowPrev = {
    type: 'SHOW',
    titles: null,
    overviews: null,
    posterUrls: null,
    backdropUrls: null,
    titleLocale: 'it', // stale marker from an old contaminated write
  };
  const staleShowExternal = {
    mediaId: 'show-1',
    media: { id: 'show-1', type: 'SHOW', metadataRefreshedAt: null },
  };

  it('English TMDB re-hydration flips a stale non-en marker to en', async () => {
    const { tx, calls } = fakeTx({ prev: staleShowPrev });
    const getShow = jest.fn(async () => makeShow([{ name: 'Animation' }]));
    const svc = makeTmdbService(
      tx,
      getShow,
      jest.fn(async () => staleShowExternal),
    );

    await runInLanguage('en', () => svc.ensureShowFull(65942));

    expect(calls.mediaItemUpdate).toHaveLength(1);
    expect(calls.mediaItemUpdate[0].data.titleLocale).toBe('en');
  });

  it('non-en TMDB request still marks en (base is always the English payload)', async () => {
    const { tx, calls } = fakeTx({ prev: staleShowPrev });
    const getShow = jest.fn(async (_id: number, lang?: string) =>
      lang === 'it'
        ? { ...makeShow([{ name: 'Animation' }]), seasons: [] }
        : makeShow([{ name: 'Animation' }]),
    );
    const svc = makeTmdbService(
      tx,
      getShow,
      jest.fn(async () => staleShowExternal),
    );

    await runInLanguage('it', () => svc.ensureShowFull(65942));

    // First update = base write (persistShow); a second one may follow from
    // applyLocaleOverrides — it must never touch the marker.
    expect(calls.mediaItemUpdate[0].data.titleLocale).toBe('en');
    for (const u of calls.mediaItemUpdate.slice(1)) {
      expect(u.data.titleLocale).toBeUndefined();
    }
  });

  it('non-en TVDB hydration marks en via the English enData payload', async () => {
    const { tx, calls } = fakeTx({ prev: staleShowPrev });
    const findFirst = jest.fn(async () => staleShowExternal);
    const svc = makeService(tx, findFirst);

    await runInLanguage('it', () => svc.ensureShowFullTvdb(280103));

    expect(calls.mediaItemUpdate).toHaveLength(1);
    expect(calls.mediaItemUpdate[0].data.titleLocale).toBe('en');
  });

  it('TVDB movie hydrated in a non-en context (single localized payload) marks the real locale', async () => {
    const { tx, calls } = fakeTx(); // no prev → create path
    const prisma = {
      $transaction: async (fn: any) => fn(tx),
      mediaItem: { findUnique: async () => null },
      externalId: { findFirst: async () => null },
    };
    const tvdb = {
      enabled: true,
      getMovie: jest.fn(async () => ({
        type: MediaType.MOVIE,
        tmdbId: 0,
        title: 'Sonic Boom',
        overview: null,
        posterUrl: null,
        backdropUrl: null,
        releaseDate: '2013-06-19',
        releaseYear: 2013,
        runtimeMinutes: 104,
        country: 'IT',
        language: 'it',
        rating: 7,
        popularity: 10,
        trailerUrl: null,
        genres: [{ name: 'Animazione' }],
        externals: [{ provider: ExternalProvider.THE_TVDB, value: '12345' }],
        keywords: [],
        cast: [],
        providers: [],
        translations: { en: { title: 'Sonic Boom', overview: 'English overview' } },
      })),
    };
    const svc = new MediaMetadataService(
      prisma as any,
      {} as any, // tmdb
      tvdb as any,
      {} as any, // tvmaze
      {} as any, // config
      { enqueueClassifyCandidate: async () => undefined } as any,
      { get: async () => null, set: async () => undefined, del: async () => undefined } as any,
    );

    await runInLanguage('it', () => svc.ensureMovieFullTvdb(12345));

    // No separate English payload → the base really IS Italian → marker stays truthful,
    // so the row remains eligible for the English-base repair.
    expect(calls.mediaItemCreate).toHaveLength(1);
    expect(calls.mediaItemCreate[0].data.titleLocale).toBe('it');
  });
});

describe('MediaMetadataService — TMDB sparse light upserts verify English titles', () => {
  function make(
    existing?: any,
    enShowTitle: string | null = 'The X-Files',
    enMovieTitle: string | null = 'Fight Club',
  ) {
    const created: any[] = [];
    const updated: any[] = [];
    const prisma = {
      mediaItem: {
        create: async (a: any) => {
          created.push(a);
          return { id: 'new-1' };
        },
        update: async (a: any) => {
          updated.push(a);
          return {};
        },
      },
      externalId: { findFirst: async () => (existing ? { media: existing } : null) },
      show: { updateMany: async () => ({ count: 0 }) },
      movie: { updateMany: async () => ({ count: 0 }) },
    };
    const tmdb = {
      enabled: true,
      localizedShowBase: jest.fn(async () => ({
        title: enShowTitle ?? '',
        overview: enShowTitle ? 'English overview' : null,
      })),
      localizedMovieBase: jest.fn(async () => ({
        title: enMovieTitle ?? '',
        overview: enMovieTitle ? 'English movie overview' : null,
      })),
    };
    const svc = new MediaMetadataService(
      prisma as any,
      tmdb as any,
      {} as any, // tvdb
      {} as any, // tvmaze
      {} as any, // config
      { enqueueClassifyCandidate: async () => undefined } as any,
      { get: async () => null, set: async () => undefined, del: async () => undefined } as any,
    );
    return { svc, created, updated, tmdb };
  }

  const sparseShow = { tmdbId: 4087, title: 'Akta X', year: 1993 };
  const sparseMovie = { tmdbId: 550, title: 'El club de la pelea', year: 1999 };

  it('existing en sparse-ID show upsert writes verified TMDB English, not the supplied title', async () => {
    const existing = {
      id: 'm1',
      titles: { en: 'Old title' },
      overviews: null,
      posterUrls: null,
      backdropUrls: null,
    };
    const { svc, updated, tmdb } = make(existing);

    await runInLanguage('en', () => svc.lightUpsertShow(sparseShow));

    expect(tmdb.localizedShowBase).toHaveBeenCalledWith(4087, 'en-US');
    expect(updated).toHaveLength(1);
    expect(updated[0].data.titles.en).toBe('The X-Files');
    expect(updated[0].data.titles.en).not.toBe('Akta X');
  });

  it('existing en sparse-ID movie upsert writes verified TMDB English, not the supplied title', async () => {
    const existing = {
      id: 'm1',
      titles: { en: 'Old title' },
      overviews: null,
      posterUrls: null,
      backdropUrls: null,
    };
    const { svc, updated, tmdb } = make(existing);

    await runInLanguage('en', () => svc.lightUpsertMovie(sparseMovie));

    expect(tmdb.localizedMovieBase).toHaveBeenCalledWith(550, 'en-US');
    expect(updated).toHaveLength(1);
    expect(updated[0].data.titles.en).toBe('Fight Club');
    expect(updated[0].data.titles.en).not.toBe('El club de la pelea');
  });

  it('existing en sparse-ID show upsert skips the title write when English is unavailable', async () => {
    const existing = {
      id: 'm1',
      titles: { en: 'The X-Files' },
      overviews: null,
      posterUrls: null,
      backdropUrls: null,
    };
    const { svc, updated } = make(existing, null);

    await runInLanguage('en', () => svc.lightUpsertShow(sparseShow));

    expect(updated).toHaveLength(0);
  });

  it('new en sparse-ID show without English is marked untrusted for repair', async () => {
    const { svc, created } = make(undefined, null);

    await runInLanguage('en', () => svc.lightUpsertShow(sparseShow));

    expect(created).toHaveLength(1);
    expect(created[0].data.title).toBe('Akta X');
    expect(created[0].data.titleLocale).toBe('und');
    expect(created[0].data.titles.en).toBeUndefined();
  });

  it('new rows born with a provider English base are birth-stamped enContentVerified', async () => {
    const { svc, created } = make(undefined);

    await runInLanguage('en', () => svc.lightUpsertShow(sparseShow));

    expect(created).toHaveLength(1);
    const provenance = created[0].data.metadataProvenance;
    expect(provenance.enContentVerifiedTitle).toBe('The X-Files');
    expect(provenance.enContentVerifiedOverview).toBe('English overview');
    expect(provenance.enContentVerifiedVersion).toBe(EN_CONTENT_VERIFIER_VERSION);
    expect(provenance.enContentVerifiedAt).toBeDefined();
  });

  it('new rows born WITHOUT a provider English base get no birth stamp', async () => {
    const { svc, created } = make(undefined, null);

    await runInLanguage('en', () => svc.lightUpsertShow(sparseShow));

    expect(created).toHaveLength(1);
    expect(created[0].data.metadataProvenance).toBeUndefined();
  });

  it('provider-sourced English list items stay cheap and do not re-fetch the English base', async () => {
    const existing = {
      id: 'm1',
      titles: null,
      overviews: null,
      posterUrls: null,
      backdropUrls: null,
    };
    const { svc, updated, tmdb } = make(existing);

    await runInLanguage('en', () =>
      svc.lightUpsertShow({
        tmdbId: 4087,
        title: 'The X-Files',
        overview: 'English overview',
        posterUrl: 'p.jpg',
        backdropUrl: 'b.jpg',
        rating: 8.4,
        popularity: 20,
        year: 1993,
      }),
    );

    expect(tmdb.localizedShowBase).not.toHaveBeenCalled();
    expect(updated[0].data.titles.en).toBe('The X-Files');
  });
});

describe('MediaMetadataService — recommendations persistence', () => {
  const recs = [
    { tmdbId: 1, type: 'SHOW', title: 'Steins;Gate', posterUrl: null, year: 2011, rating: 8.8 },
  ];

  it('TMDB persist writes recommendations + the synced stamp', async () => {
    const { tx, calls } = fakeTx();
    const getShow = jest.fn(async () => ({ ...makeShow([{ name: 'Animation' }]), recommendations: recs }));
    const svc = makeTmdbService(tx, getShow);

    await runInLanguage('en', () => svc.ensureShowFull(65942));

    expect(calls.mediaItemCreate).toHaveLength(1);
    expect(calls.mediaItemCreate[0].data.recommendations).toEqual(recs);
    expect(calls.mediaItemCreate[0].data.recommendationsSyncedAt).toBeInstanceOf(Date);
  });

  it('TVDB persist (no recommendations) never writes/clobbers the TMDB snapshot', async () => {
    const { tx, calls } = fakeTx({
      prev: {
        type: 'SHOW',
        titles: null,
        overviews: null,
        posterUrls: null,
        backdropUrls: null,
        titleLocale: 'en',
      },
    });
    // Stale existing show row → update path in persistShow.
    const findFirst = jest.fn(async () => ({
      mediaId: 'show-1',
      media: { id: 'show-1', type: 'SHOW', metadataRefreshedAt: null },
    }));
    const svc = makeService(tx, findFirst); // TVDB getShow payload has no recommendations

    await runInLanguage('en', () => svc.ensureShowFullTvdb(280103));

    expect(calls.mediaItemUpdate).toHaveLength(1);
    expect(calls.mediaItemUpdate[0].data).not.toHaveProperty('recommendations');
    expect(calls.mediaItemUpdate[0].data).not.toHaveProperty('recommendationsSyncedAt');
  });
});

describe('MediaMetadataService — TVDB light upserts are born with an English base', () => {
  function make(enTitle: string | null, existing?: any) {
    const created: any[] = [];
    const updated: any[] = [];
    const prisma = {
      mediaItem: {
        create: async (a: any) => {
          created.push(a);
          return { id: 'new-1' };
        },
        update: async (a: any) => {
          updated.push(a);
          return {};
        },
      },
      externalId: { findFirst: async () => (existing ? { media: existing } : null) },
      show: { updateMany: async () => ({ count: 0 }) },
    };
    const tvdb = {
      enabled: true,
      localizedShowBase: jest.fn(async () => ({
        title: enTitle ?? undefined,
        overview: enTitle ? 'English overview' : null,
      })),
    };
    const svc = new MediaMetadataService(
      prisma as any,
      {} as any, // tmdb
      tvdb as any,
      {} as any, // tvmaze
      {} as any, // config
      { enqueueClassifyCandidate: async () => undefined } as any,
      { get: async () => null, set: async () => undefined, del: async () => undefined } as any,
    );
    return { svc, created, updated, tvdb };
  }

  const item = {
    tvdbId: 95491,
    title: 'Diari di vampiri',
    overview: 'descrizione italiana',
    posterUrl: 'p.jpg',
    backdropUrl: 'b.jpg',
    year: 2009,
  };

  it('non-en creation: English base + request-locale overrides + titleLocale en', async () => {
    const { svc, created } = make('The Vampire Diaries');

    await runInLanguage('it', () => svc.lightUpsertShowTvdb(item));

    expect(created).toHaveLength(1);
    const data = created[0].data;
    expect(data.title).toBe('The Vampire Diaries');
    expect(data.titleLocale).toBe('en');
    expect(data.titles).toMatchObject({ en: 'The Vampire Diaries', it: 'Diari di vampiri' });
    // Images come from the (language-independent) search item.
    expect(data.posterUrl).toBe('p.jpg');
  });

  it('keeps the localized base + honest marker when TVDB has no English title', async () => {
    const { svc, created } = make(null);

    await runInLanguage('it', () => svc.lightUpsertShowTvdb(item));

    const data = created[0].data;
    expect(data.title).toBe('Diari di vampiri');
    expect(data.titleLocale).toBe('it');
  });

  it('en creation: uses the trusted TVDB English title, not the localized search result', async () => {
    const { svc, created, tvdb } = make('The Vampire Diaries');

    await runInLanguage('en', () => svc.lightUpsertShowTvdb(item));

    expect(tvdb.localizedShowBase).toHaveBeenCalledWith(95491, 'eng');
    expect(created[0].data.title).toBe('The Vampire Diaries');
    expect(created[0].data.titleLocale).toBe('en');
    expect(created[0].data.titles).toMatchObject({ en: 'The Vampire Diaries' });
    expect(created[0].data.titles.en).not.toBe('Diari di vampiri');
  });

  it('en creation without an English TVDB title is marked untrusted for repair', async () => {
    const { svc, created } = make(null);

    await runInLanguage('en', () => svc.lightUpsertShowTvdb(item));

    expect(created[0].data.title).toBe('Diari di vampiri');
    expect(created[0].data.titleLocale).toBe('und');
    expect(created[0].data.titles.en).toBeUndefined();
  });

  it('create race (P2002) falls back to the concurrently created row', async () => {
    // Prod race: the synchronous discovery fallback AND a background tvdb-search
    // hydration job both find nothing for the same TVDB id, both create — the loser
    // hits the unique (provider, kind, value) constraint and must recover the winner.
    const winner = {
      id: 'winner-1',
      titles: { en: 'The Vampire Diaries' },
      overviews: null,
      posterUrls: null,
      backdropUrls: null,
    };
    const findFirst = jest
      .fn()
      .mockResolvedValueOnce(null) // initial existence check
      .mockResolvedValue({ media: winner }); // post-P2002 recovery lookup
    const prisma = {
      mediaItem: {
        create: async () => {
          const e: any = new Error('Unique constraint failed');
          e.code = 'P2002';
          throw e;
        },
        update: async () => ({}),
      },
      externalId: { findFirst },
      show: { updateMany: async () => ({ count: 0 }) },
    };
    const tvdb = {
      enabled: true,
      localizedShowBase: jest.fn(async () => ({ title: 'The Vampire Diaries', overview: null })),
    };
    const svc = new MediaMetadataService(
      prisma as any,
      {} as any, // tmdb
      tvdb as any,
      {} as any, // tvmaze
      {} as any, // config
      { enqueueClassifyCandidate: async () => undefined } as any,
      { get: async () => null, set: async () => undefined, del: async () => undefined } as any,
    );

    const id = await runInLanguage('en', () => svc.lightUpsertShowTvdb(item));

    expect(id).toBe('winner-1');
    expect(findFirst).toHaveBeenCalledTimes(2);
  });

  it('existing en upsert writes the trusted TVDB English title, not a localized match name', async () => {
    const existing = {
      id: 'm1',
      titles: { en: 'Old title' },
      overviews: null,
      posterUrls: null,
      backdropUrls: null,
    };
    const { svc, updated } = make('How I Met Your Mother', existing);

    await runInLanguage('en', () =>
      svc.lightUpsertShowTvdb({ ...item, tvdbId: 75760, title: 'Jak jsem poznal vaši matku' }),
    );

    expect(updated).toHaveLength(1);
    expect(updated[0].data.titles.en).toBe('How I Met Your Mother');
  });

  it('existing en upsert skips the write when English could not be verified', async () => {
    const existing = {
      id: 'm1',
      titles: { en: 'How I Met Your Mother' },
      overviews: null,
      posterUrls: null,
      backdropUrls: null,
    };
    const { svc, updated } = make(null, existing);

    await runInLanguage('en', () =>
      svc.lightUpsertShowTvdb({ ...item, tvdbId: 75760, title: 'Jak jsem poznal vaši matku' }),
    );

    expect(updated).toHaveLength(0);
  });
});
