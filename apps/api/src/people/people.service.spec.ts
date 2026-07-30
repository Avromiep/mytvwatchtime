import { MediaType } from '@tvwatch/shared';
import { ProviderError } from '../media-metadata/providers/shared/provider-errors';
import { runInLanguage } from '../common/language.context';
import { PeopleService } from './people.service';
import {
  isSelfAppearance,
  mergeLocaleTitles,
  normalizeTmdbCredits,
  normalizeTvdbCredits,
  tvdbBiography,
} from './normalized-person';

/** PeopleService — id resolution (legacy heal), duplicate merge, sync + serve. */

const DAY = 24 * 60 * 60 * 1000;

function memberRow(over: Record<string, any> = {}) {
  return {
    id: 'cm-1',
    name: 'Robert Pattinson',
    profileUrl: null,
    externalId: null,
    tmdbId: null,
    tvdbId: null,
    imdbId: null,
    birthDate: null,
    deathDate: null,
    birthPlace: null,
    biography: null,
    names: null,
    biographies: null,
    detailsLocales: null,
    detailsSyncedAt: null,
    credits: null,
    creditsSyncedAt: null,
    ...over,
  };
}

function makeService(
  over: {
    prisma?: Record<string, any>;
    tmdb?: Record<string, any>;
    tvdb?: Record<string, any>;
  } = {},
) {
  const updateCalls: any[] = [];
  const prisma: Record<string, any> = {
    castMember: {
      findUnique: jest.fn(async () => null),
      findMany: jest.fn(async () => []),
      update: jest.fn(async (a: any) => {
        updateCalls.push(a);
        return { ...a._current, ...a.data };
      }),
      delete: jest.fn(async () => ({})),
    },
    mediaCast: {
      findMany: jest.fn(async () => []),
    },
    externalId: { findMany: jest.fn(async () => []) },
    mediaItem: { findMany: jest.fn(async () => []) },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
    ...over.prisma,
  };
  // update returns the row with data applied — track the "current" row per call site
  const svc = new PeopleService(
    prisma as any,
    { enabled: true, getPerson: jest.fn(), ...over.tmdb } as any,
    { img: (p?: string | null, size = 'w185') => (p ? `tmdb-img:${size}:${p}` : null) } as any,
    { enabled: true, getPersonExtended: jest.fn(async () => null), ...over.tvdb } as any,
    { artwork: (p?: string | null) => (p ? `tvdb-img:${p}` : null) } as any,
    { mergeCastGroupTx: jest.fn(async () => ({})) } as any,
  );
  return { svc, prisma, updateCalls };
}

describe('normalized-person', () => {
  it('filters self appearances but keeps real roles', () => {
    expect(isSelfAppearance('Himself')).toBe(true);
    expect(isSelfAppearance('Self - Guest')).toBe(true);
    expect(isSelfAppearance('herself')).toBe(true);
    expect(isSelfAppearance('Edward Cullen')).toBe(false);
    expect(isSelfAppearance(null)).toBe(false);
  });

  it('normalizes TMDB combined credits: acting only, deduped, year desc', () => {
    const items = normalizeTmdbCredits(
      {
        id: 11288,
        name: 'Robert Pattinson',
        combined_credits: {
          cast: [
            {
              id: 1,
              media_type: 'movie',
              title: 'The Batman',
              character: 'Bruce Wayne',
              poster_path: '/p.jpg',
              release_date: '2022-03-04',
            },
            {
              id: 2,
              media_type: 'tv',
              name: 'Jimmy Kimmel Live!',
              character: 'Himself',
              first_air_date: '2010-01-01',
            },
            {
              id: 3,
              media_type: 'movie',
              title: 'Twilight',
              character: 'Edward Cullen',
              release_date: '2008-11-21',
            },
            {
              id: 1,
              media_type: 'movie',
              title: 'The Batman',
              character: 'Bruce Wayne',
              release_date: '2022-03-04',
            }, // dup
            { id: 4, media_type: 'tv', name: 'The Unknown Show' },
          ],
        },
      } as any,
      (p, s) => (p ? `img:${s}:${p}` : null),
    );
    expect(items.map((i) => i.key)).toEqual(['tmdb:1:MOVIE', 'tmdb:3:MOVIE', 'tmdb:4:SHOW']);
    expect(items[0]).toMatchObject({
      tmdbId: 1,
      type: MediaType.MOVIE,
      year: 2022,
      character: 'Bruce Wayne',
      posterUrl: 'img:w185:/p.jpg',
    });
    expect(items[2].year).toBeNull();
  });

  it('normalizes TVDB characters: Actor only (drops Guest Star), both kinds', () => {
    const items = normalizeTvdbCredits(
      {
        id: 310910,
        name: 'Robert Pattinson',
        characters: [
          {
            id: 1,
            name: 'Edward Cullen',
            peopleType: 'Actor',
            movieId: 122,
            movie: { name: 'Twilight', image: '/m.jpg', year: '2008' },
          },
          {
            id: 2,
            name: null,
            peopleType: 'Guest Star',
            seriesId: 71998,
            series: { name: 'Jimmy Kimmel Live!', year: '2003' },
          },
          {
            id: 3,
            name: 'Some Role',
            peopleType: 'Actor',
            seriesId: 55,
            series: { name: 'A Show', image: '/s.jpg', year: '2020' },
          },
          {
            id: 4,
            name: null,
            peopleType: 'Writer',
            movieId: 999,
            movie: { name: 'Written Film' },
          },
        ],
      } as any,
      (p) => (p ? `tvdb:${p}` : null),
    );
    expect(items.map((i) => i.key)).toEqual(['tvdb:55:SHOW', 'tvdb:122:MOVIE']);
    expect(items[1]).toMatchObject({
      tvdbId: 122,
      type: MediaType.MOVIE,
      title: 'Twilight',
      year: 2008,
    });
  });

  it('picks TVDB biography by locale with eng fallback', () => {
    const p = {
      translations: {
        nameTranslations: [
          { name: 'RP', overview: 'english bio', language: 'eng' },
          { name: 'RP', overview: 'bio en español', language: 'spa' },
        ],
      },
    } as any;
    expect(tvdbBiography(p, 'es')).toBe('bio en español');
    expect(tvdbBiography(p, 'fr')).toBe('english bio');
    expect(
      tvdbBiography({ biographies: [{ biography: 'plain', language: 'eng' }] } as any, 'en'),
    ).toBe('plain');
  });

  it('merges locale titles only when they differ from the base', () => {
    const snapshot = {
      items: [
        { key: 'tmdb:1:MOVIE', tmdbId: 1, type: MediaType.MOVIE, title: 'The Batman' },
        { key: 'tmdb:2:MOVIE', tmdbId: 2, type: MediaType.MOVIE, title: 'Tenet' },
      ],
      locales: {},
    };
    const locales = mergeLocaleTitles(snapshot as any, 'fr', [
      { key: 'tmdb:1:MOVIE', tmdbId: 1, type: MediaType.MOVIE, title: 'The Batman' }, // same → skipped
      { key: 'tmdb:2:MOVIE', tmdbId: 2, type: MediaType.MOVIE, title: 'Tenet FR' },
    ] as any);
    expect(locales.fr).toEqual({ 'tmdb:2:MOVIE': 'Tenet FR' });
  });
});

describe('PeopleService.resolveIds (legacy mis-prefix heal)', () => {
  it('TMDB_<tvdbId> + thetvdb image → resolves real TMDB id via TVDB remoteIds', async () => {
    const row = memberRow({
      externalId: 'TMDB_310910',
      profileUrl: 'https://artworks.thetvdb.com/banners/person/310910/x.jpg',
    });
    const { svc, prisma } = makeService({
      tvdb: {
        getPersonExtended: jest.fn(async () => ({
          id: 310910,
          remoteIds: [
            { id: '11288', type: 15, sourceName: 'TheMovieDB.com' },
            { id: 'nm1500155', type: 16, sourceName: 'IMDB' },
          ],
        })),
      },
    });
    (prisma.castMember.update as jest.Mock).mockImplementation(async (a: any) => ({
      ...row,
      ...a.data,
    }));
    const out = await (svc as any).resolveIds(row);
    expect(out.tmdbId).toBe(11288);
    expect(out.tvdbId).toBe(310910);
    expect(out.imdbId).toBe('nm1500155');
  });

  it('TMDB_<id> verified against TMDB stays a TMDB id (no TVDB call)', async () => {
    const row = memberRow({
      externalId: 'TMDB_11288',
      profileUrl: 'https://image.tmdb.org/t/p/w185/x.jpg',
    });
    const getPerson = jest.fn(async () => ({ id: 11288 }));
    const getPersonExtended = jest.fn(async () => null);
    const { svc, prisma } = makeService({ tmdb: { getPerson }, tvdb: { getPersonExtended } });
    (prisma.castMember.update as jest.Mock).mockImplementation(async (a: any) => ({
      ...row,
      ...a.data,
    }));
    const out = await (svc as any).resolveIds(row);
    expect(out.tmdbId).toBe(11288);
    expect(out.tvdbId).toBeNull();
    expect(getPersonExtended).not.toHaveBeenCalled();
  });

  it('TMDB 404 + no image tell → falls back to TVDB with the same digits', async () => {
    const row = memberRow({ externalId: 'TMDB_310910' });
    const getPerson = jest.fn(async () => {
      throw new ProviderError('not_found', 'tmdb 404');
    });
    const getPersonExtended = jest.fn(async () => ({
      id: 310910,
      remoteIds: [{ id: '11288', type: 15, sourceName: 'TheMovieDB.com' }],
    }));
    const { svc, prisma } = makeService({ tmdb: { getPerson }, tvdb: { getPersonExtended } });
    (prisma.castMember.update as jest.Mock).mockImplementation(async (a: any) => ({
      ...row,
      ...a.data,
    }));
    const out = await (svc as any).resolveIds(row);
    expect(getPersonExtended).toHaveBeenCalledWith(310910);
    expect(out.tvdbId).toBe(310910);
    expect(out.tmdbId).toBe(11288);
  });

  it('already-resolved members skip provider calls', async () => {
    const row = memberRow({ externalId: 'TMDB_11288', tmdbId: 11288, tvdbId: 310910 });
    const getPerson = jest.fn();
    const getPersonExtended = jest.fn();
    const { svc } = makeService({ tmdb: { getPerson }, tvdb: { getPersonExtended } });
    const out = await (svc as any).resolveIds(row);
    expect(out).toBe(row);
    expect(getPerson).not.toHaveBeenCalled();
    expect(getPersonExtended).not.toHaveBeenCalled();
  });
});

describe('PeopleService.mergeDuplicates', () => {
  it('repoints media_cast to the canonical TMDB_-keyed member and deletes the dup', async () => {
    const legacy = memberRow({
      id: 'cm-legacy',
      externalId: 'TMDB_310910',
      tmdbId: 11288,
      tvdbId: 310910,
    });
    const canonical = memberRow({ id: 'cm-real', externalId: 'TMDB_11288', tmdbId: 11288 });
    const { svc, prisma } = makeService({
      prisma: {
        castMember: {
          findMany: jest.fn(async () => [{ ...canonical, _count: { mediaCast: 3 } }]),
          findUnique: jest.fn(async (a: any) =>
            a.where.id === 'cm-legacy' ? { ...legacy, _count: { mediaCast: 1 } } : { ...canonical },
          ),
          update: jest.fn(async (a: any) => a.data),
          delete: jest.fn(async () => ({})),
        },
        mediaCast: {
          findMany: jest.fn(async () => [{ id: 'mc-1', mediaId: 'media-1' }]),
        },
        $transaction: jest.fn(async (fn: any) =>
          fn({
            mediaCast: {
              findUnique: jest.fn(async () => null), // no canonical row on that media
              update: jest.fn(async () => ({})),
            },
          }),
        ),
      },
    });
    const txUpdate = jest.fn(async () => ({}));
    (prisma.$transaction as jest.Mock).mockImplementation(async (fn: any) =>
      fn({
        mediaCast: {
          findUnique: jest.fn(async () => null),
          update: txUpdate,
        },
      }),
    );
    const out = await (svc as any).mergeDuplicates(legacy);
    expect(out.id).toBe('cm-real');
    expect(txUpdate).toHaveBeenCalledWith({
      where: { id: 'mc-1' },
      data: { castMemberId: 'cm-real' },
    });
    expect(prisma.castMember.delete).toHaveBeenCalledWith({ where: { id: 'cm-legacy' } });
  });
});

describe('PeopleService sync + serve', () => {
  const tmdbPayload = {
    id: 11288,
    name: 'Robert Pattinson',
    biography: 'English bio',
    birthday: '1986-05-13',
    deathday: null,
    place_of_birth: 'London, England, UK',
    profile_path: '/rp.jpg',
    external_ids: { imdb_id: 'nm1500155' },
    combined_credits: {
      cast: [
        {
          id: 414906,
          media_type: 'movie',
          title: 'The Batman',
          character: 'Bruce Wayne',
          poster_path: '/b.jpg',
          release_date: '2022-03-04',
        },
        {
          id: 71998,
          media_type: 'tv',
          name: 'Some Show',
          character: 'Guest Role',
          first_air_date: '2015-01-01',
        },
      ],
    },
  };

  it('first view syncs TMDB: base columns, credits snapshot, stamps', async () => {
    const row = memberRow({ externalId: 'TMDB_11288', tmdbId: 11288, tvdbId: 310910 });
    const getPerson = jest.fn(async () => tmdbPayload);
    const { svc, prisma } = makeService({ tmdb: { getPerson } });
    (prisma.castMember.update as jest.Mock).mockImplementation(async (a: any) => ({
      ...row,
      ...a.data,
    }));
    const out = await (svc as any).syncPerson(row, 'en');
    expect(getPerson).toHaveBeenCalledTimes(1);
    expect(getPerson).toHaveBeenCalledWith(11288, 'en-US');
    expect(out.biography).toBe('English bio');
    expect(out.birthDate).toEqual(new Date('1986-05-13'));
    expect(out.birthPlace).toBe('London, England, UK');
    expect(out.imdbId).toBe('nm1500155');
    expect(out.credits.items.map((i: any) => i.key)).toEqual([
      'tmdb:414906:MOVIE',
      'tmdb:71998:SHOW',
    ]);
    expect(out.detailsSyncedAt).toBeTruthy();
    expect(out.detailsLocales).toContain('en');
  });

  it('locale view stores overrides, keeps the English base', async () => {
    const row = memberRow({
      externalId: 'TMDB_11288',
      tmdbId: 11288,
      biography: 'English bio',
      detailsLocales: ['en'],
      detailsSyncedAt: new Date(),
      credits: {
        items: [{ key: 'tmdb:414906:MOVIE', tmdbId: 414906, type: 'MOVIE', title: 'The Batman' }],
        locales: {},
      },
      creditsSyncedAt: new Date(),
    });
    const getPerson = jest.fn(async (_id: number, lang?: string) =>
      lang === 'fr-FR'
        ? {
            ...tmdbPayload,
            biography: 'Bio française',
            combined_credits: {
              cast: [
                { id: 414906, media_type: 'movie', title: 'The Batman', character: 'Bruce Wayne' },
              ],
            },
          }
        : tmdbPayload,
    );
    const { svc, prisma } = makeService({ tmdb: { getPerson } });
    (prisma.castMember.update as jest.Mock).mockImplementation(async (a: any) => ({
      ...row,
      ...a.data,
    }));
    const out = await runInLanguage('fr', () => (svc as any).syncPerson(row, 'fr'));
    // base NOT refetched (fresh) — only the locale call
    expect(getPerson).toHaveBeenCalledTimes(1);
    expect(getPerson).toHaveBeenCalledWith(11288, 'fr-FR');
    expect(out.biography).toBe('English bio');
    expect(out.biographies.fr).toBe('Bio française');
    expect(out.detailsLocales).toContain('fr');
  });

  it('fresh member with attempted locale → no provider calls', async () => {
    const row = memberRow({
      tmdbId: 11288,
      detailsLocales: ['en', 'fr'],
      detailsSyncedAt: new Date(Date.now() - DAY),
      creditsSyncedAt: new Date(Date.now() - DAY),
    });
    const getPerson = jest.fn();
    const { svc } = makeService({ tmdb: { getPerson } });
    const out = await (svc as any).syncPerson(row, 'fr');
    expect(out).toBe(row);
    expect(getPerson).not.toHaveBeenCalled();
  });

  it('resolves credits to internal media via ExternalId; wrong-kind links are dropped', async () => {
    const row = memberRow({
      tmdbId: 11288,
      credits: {
        items: [
          {
            key: 'tmdb:414906:MOVIE',
            tmdbId: 414906,
            type: 'MOVIE',
            title: 'The Batman',
            posterUrl: 'snap.jpg',
            year: 2022,
          },
          { key: 'tmdb:50:SHOW', tmdbId: 50, type: 'SHOW', title: 'Kind-Guard Show' },
        ],
        locales: { fr: { 'tmdb:414906:MOVIE': 'Le Batman' } },
      },
    });
    const { svc, prisma } = makeService();
    (prisma.externalId.findMany as jest.Mock).mockResolvedValue([
      { provider: 'TMDB', value: '414906', mediaId: 'media-batman' },
      { provider: 'TMDB', value: '50', mediaId: 'media-wrong-kind' },
    ]);
    (prisma.mediaItem.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'media-batman',
        type: 'MOVIE',
        posterUrl: 'media-poster.jpg',
        posterUrls: null,
        titles: { fr: 'The Batman (film)' },
      },
      { id: 'media-wrong-kind', type: 'MOVIE', posterUrl: null, posterUrls: null, titles: null }, // credit says SHOW
    ]);
    const credits = await runInLanguage('fr', () => (svc as any).resolveCredits(row, 'fr'));
    expect(credits).toHaveLength(2);
    // Media row wins for title/poster (its own locale overlay), mediaId attached
    expect(credits[0]).toMatchObject({
      mediaId: 'media-batman',
      tmdbId: 414906,
      title: 'The Batman (film)',
      posterUrl: 'media-poster.jpg',
    });
    // Wrong-kind link: NOT resolved — falls back to the snapshot locale title
    expect(credits[1]).toMatchObject({ mediaId: null, tmdbId: 50, title: 'Kind-Guard Show' });
  });

  it('unresolved credits keep snapshot locale titles and null mediaId', async () => {
    const row = memberRow({
      tmdbId: 11288,
      credits: {
        items: [{ key: 'tmdb:1:MOVIE', tmdbId: 1, type: 'MOVIE', title: 'Cosmopolis' }],
        locales: { fr: { 'tmdb:1:MOVIE': 'Cosmopolis FR' } },
      },
    });
    const { svc } = makeService();
    const credits = await runInLanguage('fr', () => (svc as any).resolveCredits(row, 'fr'));
    expect(credits[0]).toMatchObject({ mediaId: null, tmdbId: 1, title: 'Cosmopolis FR' });
  });

  it('provider failure serves the cached row (no throw)', async () => {
    const row = memberRow({ tmdbId: 11288 });
    const getPerson = jest.fn(async () => {
      throw new ProviderError('rate_limited', 'tmdb 429');
    });
    const { svc, prisma } = makeService({ tmdb: { getPerson } });
    (prisma.castMember.findUnique as jest.Mock).mockResolvedValue(row);
    await expect(svc.getPerson('cm-1')).resolves.toMatchObject({
      person: { id: 'cm-1', detailsAvailable: false },
      movies: [],
      shows: [],
    });
  });
});
