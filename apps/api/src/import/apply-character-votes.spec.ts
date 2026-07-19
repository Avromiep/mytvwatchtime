import { ImportService } from './import.service';

/**
 * applyCharacterVotes: fully local character resolution via media_cast.characterExternalId,
 * one bounded TVDB re-hydration per show for stale cast rows, ratings-style conflicts.
 */

type FnMap = Record<string, jest.Mock>;
function model(fns: string[]): FnMap {
  const m: FnMap = {};
  for (const f of fns) m[f] = jest.fn().mockResolvedValue(undefined);
  return m;
}

function makeService(castRows: any[], existingVotes: any[]) {
  const prisma: any = {
    mediaCast: model(['findMany']),
    characterVote: model(['findMany']),
    import: model(['update']),
    importItem: model(['updateMany']),
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
  };
  prisma.mediaCast.findMany.mockResolvedValue(castRows);
  prisma.characterVote.findMany.mockResolvedValue(existingVotes);
  const chunked: any[] = [];
  prisma.chunkedCapture = chunked;
  const service = new ImportService(
    prisma,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    { rehydrateWithTvdb: jest.fn().mockResolvedValue(true) } as any,
    {} as any,
  );
  // Spy the chunk writer so we can assert created rows without a real DB.
  (service as any).chunkedCreateMany = jest.fn(async (_tx: any, _model: string, rows: any[]) => {
    chunked.push(...rows);
  });
  return { service: service as any, prisma, chunked };
}

const item = (over: Record<string, unknown> = {}) => ({
  id: 'it1',
  sourceEntityType: 'EPISODE_CHARACTER_VOTE',
  status: 'MATCHED',
  matchedMediaId: 'media-1',
  matchedEpisodeId: 'ep-1',
  normalizedData: {
    showCharacterId: 64771402,
    externalEpisodeId: 75834,
    voteKey: 'episode:75834:char:64771402',
    sourceCreatedAt: '2019-08-17T09:45:00.000Z',
  },
  ...over,
});

describe('ImportService.applyCharacterVotes', () => {
  it('creates votes from local characterExternalId matches — zero provider calls', async () => {
    const { service, chunked, prisma } = makeService(
      [{ id: 'cast-1', mediaId: 'media-1', characterExternalId: 64771402 }],
      [],
    );
    const res = await service.applyCharacterVotes('u1', 'imp1', [item()]);
    expect(res).toEqual({ created: 1, skipped: 0 });
    expect(chunked[0]).toMatchObject({
      userId: 'u1',
      episodeId: 'ep-1',
      castId: 'cast-1',
      source: 'TVTIME',
      sourceKey: 'episode:75834:char:64771402',
    });
    expect(new Date(chunked[0].createdAt).toISOString()).toBe('2019-08-17T09:45:00.000Z');
    expect(prisma.import.update).toHaveBeenCalledWith({
      where: { id: 'imp1' },
      data: expect.objectContaining({ characterVotesImported: { increment: 1 } }),
    });
  });

  it('re-hydrates a show ONCE when its cast rows predate characterExternalId, then retries', async () => {
    const { service, chunked, prisma } = makeService([], []);
    // First loadCastRows → empty; after the single rehydrate → the character is there.
    prisma.mediaCast.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'cast-1', mediaId: 'media-1', characterExternalId: 64771402 }]);
    const res = await service.applyCharacterVotes('u1', 'imp1', [item()]);
    expect(res.created).toBe(1);
    expect(chunked[0]).toMatchObject({ castId: 'cast-1' });
    const rehydrate = (service as any).matcher.rehydrateWithTvdb as jest.Mock;
    expect(rehydrate).toHaveBeenCalledTimes(1);
    expect(rehydrate).toHaveBeenCalledWith('media-1');
  });

  it('leaves the item MATCHED and counts unresolved when the character cannot be resolved', async () => {
    const { service, prisma } = makeService([], []);
    const res = await service.applyCharacterVotes('u1', 'imp1', [item()]);
    expect(res).toEqual({ created: 0, skipped: 0 });
    expect(prisma.importItem.updateMany).not.toHaveBeenCalled(); // not marked APPLIED — retried later
    expect(prisma.import.update).toHaveBeenCalledWith({
      where: { id: 'imp1' },
      data: expect.objectContaining({ characterVotesSkippedUnresolved: { increment: 1 } }),
    });
  });

  it('never overwrites an existing vote (manual or different character)', async () => {
    const { service, chunked } = makeService(
      [{ id: 'cast-1', mediaId: 'media-1', characterExternalId: 64771402 }],
      [
        {
          id: 'v1',
          userId: 'u1',
          episodeId: 'ep-1',
          castId: 'other',
          source: null,
          sourceKey: null,
        },
      ],
    );
    const res = await service.applyCharacterVotes('u1', 'imp1', [item()]);
    expect(res).toEqual({ created: 0, skipped: 1 });
    expect(chunked).toHaveLength(0);
  });

  it('is idempotent for the same import sourceKey (skip, no duplicate)', async () => {
    const { service, chunked } = makeService(
      [{ id: 'cast-1', mediaId: 'media-1', characterExternalId: 64771402 }],
      [
        {
          id: 'v1',
          userId: 'u1',
          episodeId: 'ep-1',
          castId: 'cast-1',
          source: 'TVTIME',
          sourceKey: 'episode:75834:char:64771402',
        },
      ],
    );
    const res = await service.applyCharacterVotes('u1', 'imp1', [item()]);
    expect(res).toEqual({ created: 0, skipped: 1 });
    expect(chunked).toHaveLength(0);
  });
});
