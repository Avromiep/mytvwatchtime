import { ImportService } from './import.service';

/**
 * resolveAllForShow safety: bulk title resolution must NEVER span unrelated titles.
 * Regression tests for the incident where resolving "승리호" matched every non-Latin
 * item in the import (all normalized to the same empty string).
 */
describe('ImportService.resolveAllForShow — title identity safety', () => {
  function makeService(items: any[]) {
    const prisma: any = {
      import: {
        findFirst: jest.fn(async () => ({ id: 'imp1', userId: 'u1' })),
        update: jest.fn(async () => ({})),
      },
      importItem: {
        findMany: jest.fn(async () => items),
        update: jest.fn(async () => ({})),
        groupBy: jest.fn(async () => []),
      },
    };
    const matcher = {
      ensureShowHydrated: jest.fn(async () => undefined),
      resolveEpisode: jest.fn(async () => 'ep-1'),
    };
    const service = new ImportService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      matcher as any,
      {} as any,
      {} as any,
    );
    return { service, prisma };
  }

  it('refuses to bulk-resolve a title with no letters/digits (empty identity)', async () => {
    const { service, prisma } = makeService([
      {
        id: 'it1',
        sourceEntityType: 'LIST_ITEM',
        status: 'NEEDS_REVIEW',
        normalizedData: { title: '승리호' },
      },
    ]);

    const res = await service.resolveAllForShow('u1', 'imp1', 'm-yatterman', '???', null);

    expect(res).toEqual({ resolved: 0, matched: 0, needsReview: 0 });
    expect(prisma.importItem.update).not.toHaveBeenCalled();
  });

  it('matches only the SAME non-Latin title (승리호 ≠ 소울메이트)', async () => {
    const items = [
      {
        id: 'it-target',
        sourceEntityType: 'LIST_ITEM',
        status: 'NEEDS_REVIEW',
        normalizedData: { title: '승리호' },
      },
      {
        id: 'it-other',
        sourceEntityType: 'LIST_ITEM',
        status: 'NEEDS_REVIEW',
        normalizedData: { title: '소울메이트' },
      },
    ];
    const { service, prisma } = makeService(items);

    const res = await service.resolveAllForShow('u1', 'imp1', 'm-space-sweepers', '승리호', null);

    expect(res.resolved).toBe(1);
    const updatedIds = prisma.importItem.update.mock.calls.map((c: any[]) => c[0].where.id);
    expect(updatedIds).toEqual(['it-target']);
  });
});
