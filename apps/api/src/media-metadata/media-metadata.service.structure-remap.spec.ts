import { StructureProvider, StructureReason } from '@prisma/client';
import { MediaMetadataService } from './media-metadata.service';

describe('MediaMetadataService canonical provider switches', () => {
  it('routes a discovered TMDB-to-TVDB owner change through the locked remap workflow', async () => {
    const prisma: any = {
      externalId: {
        findFirst: jest.fn().mockResolvedValue({
          media: { id: 'media-1', metadataRefreshedAt: new Date() },
        }),
        findUnique: jest.fn().mockResolvedValue({ mediaId: 'media-1' }),
        create: jest.fn(),
      },
      mediaItem: { findUnique: jest.fn().mockResolvedValue({ metadataRefreshedAt: new Date() }) },
      show: { update: jest.fn() },
    };
    const decision = {
      provider: StructureProvider.TVDB,
      reason: StructureReason.ANIME_TVDB,
      ruleVersion: 1,
      decidedAt: new Date(),
      tmdbId: 10,
      tvdbId: 20,
      imdbId: 'tt10',
    };
    const authority = {
      forTmdb: jest.fn().mockResolvedValue(decision),
      persisted: jest.fn().mockResolvedValue({
        provider: StructureProvider.TMDB,
        reason: StructureReason.GENERAL_TMDB,
        ruleVersion: 1,
        decidedAt: new Date(0),
      }),
    };
    const remap = {
      remapShow: jest.fn().mockResolvedValue({ stale: 1 }),
    };
    const hydration = { enqueueClassifyCandidate: jest.fn().mockResolvedValue(undefined) };
    const service = new MediaMetadataService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      hydration as any,
      {} as any,
      undefined,
      undefined,
      authority as any,
      remap as any,
    );
    const tvdbHydration = jest.spyOn(service, 'ensureShowFullTvdb').mockResolvedValue('media-1');

    await expect(service.ensureShowFull(10)).resolves.toBe('media-1');

    expect(tvdbHydration).toHaveBeenCalledWith(
      20,
      undefined,
      expect.objectContaining({
        decision,
        writeScope: 'STRUCTURE_REMAP',
        forceRefresh: true,
        lockHeld: true,
      }),
    );
    expect(remap.remapShow).toHaveBeenCalledWith('media-1', {
      canonical: 'tvdb',
      reason: StructureReason.ANIME_TVDB,
    });
    expect(hydration.enqueueClassifyCandidate).toHaveBeenCalled();
  });
});
