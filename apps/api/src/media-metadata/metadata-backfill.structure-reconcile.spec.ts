import { MetadataBackfillService } from './metadata-backfill.service';
import { CastDedupService } from './cast-dedup.service';
import { StructureRemapService } from './structure-remap.service';

// repairTmdbStructureShow: the reverse (TMDB-canonical) structure repair — gating,
// rehydration, remap direction, and provenance stamps.

const REMAP_ZERO = {
  stale: 0,
  mapped: 0,
  unmapped: 0,
  statusesMoved: 0,
  historiesMoved: 0,
  ratingsMoved: 0,
  reactionsMoved: 0,
  votesMoved: 0,
  commentsMoved: 0,
  episodesRemoved: 0,
  seasonsRemoved: 0,
  matchRules: {},
  dryRun: false,
};

function make(opts: {
  staleRows: number;
  provenance?: any;
  externalIds?: any[];
  remap?: Partial<typeof REMAP_ZERO>;
}) {
  const prisma: any = {
    $queryRaw: jest.fn().mockResolvedValue([{ c: BigInt(opts.staleRows) }]),
    mediaItem: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'm1',
        metadataProvenance: opts.provenance ?? null,
        externalIds: opts.externalIds ?? [
          { provider: 'TMDB', providerEntityKind: 'SERIES', value: '1416' },
        ],
      }),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const meta: any = { ensureShowFull: jest.fn().mockResolvedValue('m1') };
  const structureRemap: any = {
    remapShow: jest.fn().mockResolvedValue({ ...REMAP_ZERO, ...opts.remap }),
  };
  const redis: any = {
    client: {
      set: jest.fn().mockResolvedValue('OK'),
      eval: jest.fn().mockResolvedValue(1),
    },
  };
  const svc = new MetadataBackfillService(
    prisma,
    meta,
    {} as any,
    redis,
    {} as any,
    {} as any,
    {} as any,
    structureRemap,
    new CastDedupService(),
  );
  return { svc, prisma, meta, structureRemap };
}

describe('repairTmdbStructureShow', () => {
  it('does nothing when no TMDB-unlinked rows exist', async () => {
    const { svc, meta, structureRemap } = make({ staleRows: 0 });
    const res = await (svc as any).repairTmdbStructureShow('m1');
    expect(res.fixed).toBe(false);
    expect(meta.ensureShowFull).not.toHaveBeenCalled();
    expect(structureRemap.remapShow).not.toHaveBeenCalled();
  });

  it('skips when kept-unmapped rows cover the stale count at the current matcher version', async () => {
    const { svc, meta, structureRemap } = make({
      staleRows: 3,
      provenance: {
        structureKeptUnmapped: 3,
        structureRemapVersion: StructureRemapService.MATCHER_VERSION,
      },
    });
    const res = await (svc as any).repairTmdbStructureShow('m1');
    expect(res.fixed).toBe(false);
    expect(meta.ensureShowFull).not.toHaveBeenCalled();
    expect(structureRemap.remapShow).not.toHaveBeenCalled();
  });

  it('rehydrates from TMDB and remaps with canonical=tmdb, then stamps provenance', async () => {
    const { svc, prisma, meta, structureRemap } = make({
      staleRows: 5,
      remap: { stale: 5, mapped: 5, unmapped: 0 },
    });
    const res = await (svc as any).repairTmdbStructureShow('m1');

    expect(res).toEqual({ fixed: true, remapped: 5 });
    // Stale gate bypassed so ensureShowFull cannot skip a recently-refreshed show.
    expect(prisma.mediaItem.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { metadataRefreshedAt: null },
    });
    expect(meta.ensureShowFull).toHaveBeenCalledWith(1416);
    expect(structureRemap.remapShow).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({ canonical: 'tmdb', onProgress: expect.any(Function) }),
    );
    expect(prisma.mediaItem.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: {
        metadataProvenance: {
          structureProvider: 'tmdb',
          structureKeptUnmapped: 0,
          structureRemapVersion: StructureRemapService.MATCHER_VERSION,
        },
      },
    });
  });

  it('re-arms when the kept count predates the current matcher version', async () => {
    const { svc, meta, structureRemap } = make({
      staleRows: 3,
      provenance: { structureKeptUnmapped: 3, structureRemapVersion: 1 },
      remap: { stale: 3, mapped: 3, unmapped: 0 },
    });
    const res = await (svc as any).repairTmdbStructureShow('m1');
    expect(res.fixed).toBe(true);
    expect(meta.ensureShowFull).toHaveBeenCalled();
    expect(structureRemap.remapShow).toHaveBeenCalled();
  });

  it('returns notFixed when nothing was stale and no TMDB id anchors the show', async () => {
    const { svc } = make({ staleRows: 1, externalIds: [], remap: { stale: 0 } });
    const res = await (svc as any).repairTmdbStructureShow('m1');
    expect(res.fixed).toBe(false);
  });
});
