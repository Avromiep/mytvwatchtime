import { StructureProvider, StructureReason } from '@prisma/client';
import {
  isStrictTmdbAnime,
  STRUCTURE_RULE_VERSION,
  StructureAuthorityService,
} from './structure-authority.service';

describe('isStrictTmdbAnime', () => {
  it.each([
    [[16], ['anime'], true],
    [[16], [], false],
    [[18], ['anime'], false],
    [[18], [], false],
  ])('classifies genres=%j keywords=%j as %s', (genres, keywords, expected) => {
    expect(isStrictTmdbAnime(genres as number[], keywords as string[])).toBe(expected);
  });
});

describe('StructureAuthorityService', () => {
  const prisma = {
    mediaItem: { findUnique: jest.fn() },
    externalId: { findFirst: jest.fn() },
  };
  const tmdb = {
    enabled: true,
    getShowRoutingProfile: jest.fn(),
    findByExternalId: jest.fn(),
  };
  const service = new StructureAuthorityService(prisma as any, tmdb as any);

  beforeEach(() => jest.clearAllMocks());

  it('routes strict TMDB anime to the verified TVDB series', async () => {
    tmdb.getShowRoutingProfile.mockResolvedValue({
      tmdbId: 20,
      title: 'Anime',
      yearStart: 2020,
      genreIds: [16, 18],
      keywords: ['anime'],
      tvdbId: 200,
      imdbId: 'tt20',
    });
    await expect(service.forTmdb(20)).resolves.toEqual(
      expect.objectContaining({
        provider: StructureProvider.TVDB,
        reason: StructureReason.ANIME_TVDB,
        ruleVersion: STRUCTURE_RULE_VERSION,
        tvdbId: 200,
      }),
    );
  });

  it('routes Animation without the keyword to TMDB', async () => {
    tmdb.getShowRoutingProfile.mockResolvedValue({
      tmdbId: 21,
      title: 'Animation',
      yearStart: 2020,
      genreIds: [16],
      keywords: ['family'],
      tvdbId: 201,
      imdbId: null,
    });
    await expect(service.forTmdb(21)).resolves.toEqual(
      expect.objectContaining({
        provider: StructureProvider.TMDB,
        reason: StructureReason.GENERAL_TMDB,
      }),
    );
  });

  it('uses a locked TVDB fallback when TMDB cannot resolve the TVDB series id', async () => {
    tmdb.findByExternalId.mockResolvedValue(null);
    await expect(service.forTvdb(300)).resolves.toEqual(
      expect.objectContaining({
        provider: StructureProvider.TVDB,
        reason: StructureReason.TVDB_ONLY_FALLBACK,
        tvdbId: 300,
      }),
    );
  });
});
