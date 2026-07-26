import { MediaType } from '@prisma/client';
import { DiscoveryService } from './discovery.service';
import { TmdbProvider } from './providers/tmdb.provider';

/** posterLast: stable poster-last ordering for merged search result windows. */
describe('DiscoveryService.posterLast', () => {
  const make = (rows: { id: string; posterUrl: string | null }[]) => {
    const prisma = {
      mediaItem: { findMany: jest.fn().mockResolvedValue(rows) },
    };
    const svc = new DiscoveryService(
      {} as any,
      {} as any,
      {} as any,
      prisma as any,
      {} as any,
      {} as any,
    );
    return { svc, prisma };
  };

  it('pushes posterless media to the bottom, preserving order within each group', async () => {
    const { svc } = make([
      { id: 'b', posterUrl: 'p.jpg' },
      { id: 'd', posterUrl: 'p.jpg' },
    ]);
    const out = await svc.posterLast(['a', 'b', 'c', 'd', 'e']);
    expect(out).toEqual(['b', 'd', 'a', 'c', 'e']);
  });

  it('keeps everything when all have posters', async () => {
    const { svc } = make([
      { id: 'a', posterUrl: 'p.jpg' },
      { id: 'b', posterUrl: 'p.jpg' },
      { id: 'c', posterUrl: 'p.jpg' },
    ]);
    expect(await svc.posterLast(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('keeps everything when none have posters', async () => {
    const { svc } = make([]);
    expect(await svc.posterLast(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('is a no-op for an empty window', async () => {
    const { svc, prisma } = make([]);
    expect(await svc.posterLast([])).toEqual([]);
    expect(prisma.mediaItem.findMany).not.toHaveBeenCalled();
  });
});

/** "Hide anime in explore": flag resolution + candidate-pool filtering. */
describe('DiscoveryService hideAnimeInExplore', () => {
  const make = (profile: { hideAnimeInExplore: boolean } | null) => {
    const prisma = {
      userProfile: { findUnique: jest.fn().mockResolvedValue(profile) },
      mediaItem: { findMany: jest.fn().mockResolvedValue([]) },
      $queryRaw: jest.fn(),
    };
    const redis = { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue(null) };
    const svc = new DiscoveryService(
      {} as any,
      {} as any,
      {} as any,
      prisma as any,
      redis as any,
      {} as any,
    );
    return { svc, prisma, redis };
  };

  /** Drive rankForYouIds past the early returns with one affinity genre. */
  const mockRankingQueries = (prisma: any) => {
    prisma.$queryRaw
      .mockResolvedValueOnce([{ name: 'Drama', c: 1 }]) // history genres
      .mockResolvedValueOnce([]) // favorite genres
      .mockResolvedValueOnce([]) // keywords
      .mockResolvedValueOnce([]); // excluded ids
  };

  it('resolveHideAnime reads the profile flag (false when absent/anonymous)', async () => {
    const { svc, prisma } = make({ hideAnimeInExplore: true });
    await expect((svc as any).resolveHideAnime('u1')).resolves.toBe(true);
    expect(prisma.userProfile.findUnique).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      select: { hideAnimeInExplore: true },
    });

    const noProfile = make(null);
    await expect((noProfile.svc as any).resolveHideAnime('u1')).resolves.toBe(false);

    const anon = make(null);
    await expect((anon.svc as any).resolveHideAnime(undefined)).resolves.toBe(false);
    expect(anon.prisma.userProfile.findUnique).not.toHaveBeenCalled();
  });

  it('excludes ANIME-classified rows from the for-you candidate pool when the flag is set', async () => {
    const { svc, prisma } = make({ hideAnimeInExplore: true });
    mockRankingQueries(prisma);
    await (svc as any).rankForYouIds('u1', undefined, true);
    expect(prisma.mediaItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ contentClassification: { not: 'ANIME' } }),
      }),
    );
  });

  it('leaves the for-you candidate where clause unchanged when the flag is off', async () => {
    const { svc, prisma } = make(null);
    mockRankingQueries(prisma);
    await (svc as any).rankForYouIds('u1');
    const where = prisma.mediaItem.findMany.mock.calls[0][0].where;
    expect(where).not.toHaveProperty('contentClassification');
  });

  it('forYou resolves the flag from the profile and scopes the cache key by it', async () => {
    const { svc, prisma, redis } = make({ hideAnimeInExplore: true });
    mockRankingQueries(prisma);
    jest.spyOn(svc as any, 'fetchListDtos').mockResolvedValue([]);
    await svc.forYou('u1', 1, 10);
    const key = redis.set.mock.calls[0][0] as string;
    expect(key).toContain('foryou:v1:u1:');
    expect(key).toContain('noanime');
    expect(redis.get).toHaveBeenCalledWith(key);
  });

  it('forYou keeps the unfiltered cache key when the flag is off', async () => {
    const { svc, prisma, redis } = make({ hideAnimeInExplore: false });
    mockRankingQueries(prisma);
    jest.spyOn(svc as any, 'fetchListDtos').mockResolvedValue([]);
    await svc.forYou('u1', 1, 10);
    const key = redis.set.mock.calls[0][0] as string;
    expect(key).toContain('foryou:v1:u1:');
    expect(key).not.toContain('noanime');
  });
});

/** Explore filters on the DB browse paths: exclusion, country, sort, hideAnime toggle. */
describe('DiscoveryService explore filters (DB paths)', () => {
  const make = () => {
    const prisma = {
      userProfile: { findUnique: jest.fn().mockResolvedValue(null) },
      mediaItem: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      genre: { findMany: jest.fn().mockResolvedValue([]) },
      $queryRaw: jest.fn(),
    };
    const redis = { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue(null) };
    const svc = new DiscoveryService(
      {} as any,
      {} as any,
      {} as any,
      prisma as any,
      redis as any,
      {} as any,
    );
    jest.spyOn(svc as any, 'fetchListDtos').mockResolvedValue([]);
    return { svc, prisma };
  };

  it('searchViaDb excludes genres via a none on the genres relation (normalized slugs)', async () => {
    const { svc, prisma } = make();
    await (svc as any).searchViaDb('term', { q: 'term', excludeGenres: ' Horror, anime ' });
    const where = prisma.mediaItem.findMany.mock.calls[0][0].where;
    expect(where.genres.none).toEqual({
      genre: { slug: { in: ['horror', 'anime'], mode: 'insensitive' } },
    });
  });

  it('searchViaDb keeps the inclusion some alongside the exclusion none', async () => {
    const { svc, prisma } = make();
    await (svc as any).searchViaDb('term', { q: 'term', genre: 'drama', excludeGenres: 'horror' });
    const where = prisma.mediaItem.findMany.mock.calls[0][0].where;
    expect(where.genres.some).toEqual({
      genre: { slug: { equals: 'drama', mode: 'insensitive' } },
    });
    expect(where.genres.none).toEqual({
      genre: { slug: { in: ['horror'], mode: 'insensitive' } },
    });
  });

  it('searchViaDb maps country to originCountries for shows', async () => {
    const { svc, prisma } = make();
    await (svc as any).searchViaDb('term', { q: 'term', type: MediaType.SHOW, country: 'jp' });
    const where = prisma.mediaItem.findMany.mock.calls[0][0].where;
    expect(where.show).toEqual({ is: { originCountries: { has: 'JP' } } });
    expect(where).not.toHaveProperty('movie');
  });

  it('searchViaDb maps country to the production country for movies', async () => {
    const { svc, prisma } = make();
    await (svc as any).searchViaDb('term', { q: 'term', type: MediaType.MOVIE, country: 'us' });
    const where = prisma.mediaItem.findMany.mock.calls[0][0].where;
    expect(where.movie).toEqual({ is: { country: { equals: 'US', mode: 'insensitive' } } });
    expect(where).not.toHaveProperty('show');
  });

  it('searchViaDb sorts shows by yearStart and movies by releaseDate (default popularity)', async () => {
    const s = make();
    await (s.svc as any).searchViaDb('term', { q: 'term', type: MediaType.SHOW, sort: 'releaseDate' });
    expect(s.prisma.mediaItem.findMany.mock.calls[0][0].orderBy).toEqual({
      show: { yearStart: 'desc' },
    });

    const m = make();
    await (m.svc as any).searchViaDb('term', { q: 'term', type: MediaType.MOVIE, sort: 'releaseDate' });
    expect(m.prisma.mediaItem.findMany.mock.calls[0][0].orderBy).toEqual({
      movie: { releaseDate: 'desc' },
    });

    const d = make();
    await (d.svc as any).searchViaDb('term', { q: 'term', type: MediaType.MOVIE });
    expect(d.prisma.mediaItem.findMany.mock.calls[0][0].orderBy).toEqual({ popularity: 'desc' });
  });

  it('searchViaDb ORs the explicit hideAnime toggle with the (off) profile flag', async () => {
    const { svc, prisma } = make();
    await (svc as any).searchViaDb('term', { q: 'term', hideAnime: true });
    expect(prisma.mediaItem.findMany.mock.calls[0][0].where.contentClassification).toEqual({
      not: 'ANIME',
    });
  });

  it('topDb applies exclusion + country + releaseDate sort for movies', async () => {
    const { svc, prisma } = make();
    await (svc as any).topDb(MediaType.MOVIE, 20, 'u1', {
      excludeGenres: 'horror',
      country: 'us',
      sort: 'releaseDate',
    });
    const call = prisma.mediaItem.findMany.mock.calls[0][0];
    expect(call.where.genres.none).toEqual({
      genre: { slug: { in: ['horror'], mode: 'insensitive' } },
    });
    expect(call.where.movie).toEqual({ is: { country: { equals: 'US', mode: 'insensitive' } } });
    expect(call.orderBy).toEqual({ movie: { releaseDate: 'desc' } });
  });

  it('topDb applies country via originCountries + yearStart sort for shows', async () => {
    const { svc, prisma } = make();
    await (svc as any).topDb(MediaType.SHOW, 20, 'u1', { country: 'KR', sort: 'releaseDate' });
    const call = prisma.mediaItem.findMany.mock.calls[0][0];
    expect(call.where.show).toEqual({ is: { originCountries: { has: 'KR' } } });
    expect(call.orderBy).toEqual({ show: { yearStart: 'desc' } });
  });

  it('topDb leaves where/orderBy untouched without filters', async () => {
    const { svc, prisma } = make();
    await (svc as any).topDb(MediaType.SHOW, 20, 'u1');
    const call = prisma.mediaItem.findMany.mock.calls[0][0];
    expect(call.where).not.toHaveProperty('genres');
    expect(call.where).not.toHaveProperty('show');
    expect(call.orderBy).toEqual({ popularity: 'desc' });
  });

  it('rankForYouIds applies exclusion and country to the candidate pool', async () => {
    const { svc, prisma } = make();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ name: 'Drama', c: 1 }]) // history genres
      .mockResolvedValueOnce([]) // favorite genres
      .mockResolvedValueOnce([]) // keywords
      .mockResolvedValueOnce([]); // excluded ids
    await (svc as any).rankForYouIds('u1', undefined, false, {
      excludeGenres: 'anime,horror',
      country: 'kr',
    });
    const where = prisma.mediaItem.findMany.mock.calls[0][0].where;
    expect(where.genres.none).toEqual({
      genre: { slug: { in: ['anime', 'horror'], mode: 'insensitive' } },
    });
    expect(where.show).toEqual({ is: { originCountries: { has: 'KR' } } });
  });

  it('forYou adds the filter fingerprint to the cache key', async () => {
    const { svc, prisma } = make();
    const redis = (svc as any).redis;
    prisma.$queryRaw
      .mockResolvedValueOnce([{ name: 'Drama', c: 1 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    await svc.forYou('u1', 1, 10, undefined, { excludeGenres: 'horror', country: 'JP' });
    const key = redis.set.mock.calls[0][0] as string;
    expect(key).toContain('foryou:v1:u1:');
    expect(key).toContain('horror');
    expect(key).toContain('JP');
  });
});

/** TMDB discover: exclusion/country params + app-level sort mapping. */
describe('TmdbProvider discover filters', () => {
  const make = () => {
    const client = {
      enabled: true,
      img: jest.fn(() => null),
      get: jest.fn().mockResolvedValue({ results: [], total_results: 0 }),
    };
    return { provider: new TmdbProvider(client as any), client };
  };

  it('discoverShows passes without_genres + with_origin_country and maps releaseDate sort', async () => {
    const { provider, client } = make();
    await provider.discoverShows({ excludeGenres: [27, 16], country: 'JP', sort: 'releaseDate' });
    expect(client.get).toHaveBeenCalledWith(
      '/discover/tv',
      expect.objectContaining({
        without_genres: '27,16',
        with_origin_country: 'JP',
        sort_by: 'first_air_date.desc',
      }),
    );
  });

  it('discoverMovies passes without_genres + with_origin_country and maps releaseDate sort', async () => {
    const { provider, client } = make();
    await provider.discoverMovies({ excludeGenres: [27], country: 'US', sort: 'releaseDate' });
    expect(client.get).toHaveBeenCalledWith(
      '/discover/movie',
      expect.objectContaining({
        without_genres: '27',
        with_origin_country: 'US',
        sort_by: 'primary_release_date.desc',
      }),
    );
  });

  it('keeps popularity.desc as the default and passes raw TMDB sort strings through', async () => {
    const d = make();
    await d.provider.discoverMovies({});
    expect(d.client.get).toHaveBeenCalledWith(
      '/discover/movie',
      expect.objectContaining({ sort_by: 'popularity.desc', without_genres: undefined }),
    );

    const r = make();
    await r.provider.discoverShows({ sort: 'vote_average.desc' });
    expect(r.client.get).toHaveBeenCalledWith(
      '/discover/tv',
      expect.objectContaining({ sort_by: 'vote_average.desc' }),
    );
  });
});
