import { ImportService } from './import.service';

/**
 * Character-vote apply vs concurrent cast rewrites: a castId resolved up front can vanish
 * before the insert (a queued tvdb-rehydrate rewrites media_cast). The apply must degrade
 * to PENDING_MATCH instead of failing with an FK violation.
 */
describe('ImportService.applyCharacterVotes — stale castId race', () => {
  const voteItem = {
    id: 'it1',
    sourceEntityType: 'EPISODE_CHARACTER_VOTE',
    status: 'MATCHED',
    matchedMediaId: 'm1',
    matchedEpisodeId: 'e1',
    normalizedData: {
      showCharacterId: 42,
      externalEpisodeId: 1001,
      voteKey: 'episode:1001:char:42',
    },
  };

  function makeService(opts: { validateReturns: string[]; firstInsertFails?: boolean }) {
    let castFindCalls = 0;
    const inserted: any[][] = [];
    const statusUpdates: any[] = [];
    const prisma: any = {
      mediaCast: {
        findMany: jest.fn(async () => {
          castFindCalls++;
          // 1st call = loadCastRows (cast exists), later = in-tx validation
          if (castFindCalls === 1) {
            return [{ id: 'cast1', mediaId: 'm1', characterExternalId: 42 }];
          }
          return opts.validateReturns.map((id) => ({ id }));
        }),
      },
      characterVote: { findMany: jest.fn(async () => []) },
      importItem: {
        updateMany: jest.fn(async (args: any) => {
          statusUpdates.push(args);
          return {};
        }),
      },
      import: { update: jest.fn(async () => ({})) },
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    const service = new ImportService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { enqueueTvdbRehydrate: jest.fn(async () => undefined) } as any,
    );
    let inserts = 0;
    (service as any).chunkedCreateMany = jest.fn(async (_tx: any, model: string, rows: any[]) => {
      if (model === 'characterVote') {
        inserts++;
        if (opts.firstInsertFails && inserts === 1) {
          const err: any = new Error('FK violated');
          err.code = 'P2003';
          throw err;
        }
        inserted.push(rows);
      }
    });
    return { service, inserted, statusUpdates, prisma };
  }

  it('drops votes whose castId vanished before the insert (→ PENDING_MATCH, no crash)', async () => {
    const { service, inserted, statusUpdates } = makeService({ validateReturns: [] });

    const res = await (service as any).applyCharacterVotes('u1', 'imp1', [voteItem], 'TVTIME');

    expect(res.created).toBe(0);
    // The vote insert ran with an empty set (nothing crashed).
    expect(inserted.every((rows) => rows.length === 0)).toBe(true);
    // Item marked PENDING_MATCH for a later confirm.
    expect(
      statusUpdates.some((u) => u.data.status === 'PENDING_MATCH' && u.where.id.in.includes('it1')),
    ).toBe(true);
  });

  it('retries the insert after an FK error with re-validated rows', async () => {
    const { service, inserted } = makeService({
      validateReturns: ['cast1'],
      firstInsertFails: true,
    });

    const res = await (service as any).applyCharacterVotes('u1', 'imp1', [voteItem], 'TVTIME');

    expect(res.created).toBe(1);
    const voteInserts = inserted.filter((rows) => rows.length > 0);
    expect(voteInserts).toHaveLength(1);
    expect(voteInserts[0][0]).toEqual(
      expect.objectContaining({ castId: 'cast1', episodeId: 'e1' }),
    );
  });
});
