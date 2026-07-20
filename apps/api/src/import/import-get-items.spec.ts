import { ImportService } from './import.service';

/** getItems: entityCounts is a per-type breakdown under the ACTIVE STATUS filter only. */
describe('ImportService.getItems — entityCounts', () => {
  it('groups counts by entity type (status filter applied, entity filter ignored)', async () => {
    const prisma: any = {
      import: { findFirst: jest.fn(async () => ({ id: 'imp1', userId: 'u1' })) },
      importItem: {
        findMany: jest.fn(async () => []),
        count: jest.fn(async () => 7),
        groupBy: jest.fn(async () => [
          { sourceEntityType: 'WATCHED_EPISODE', _count: { _all: 5 } },
          { sourceEntityType: 'WATCHED_MOVIE', _count: { _all: 2 } },
        ]),
      },
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
      {} as any,
    );

    const res = await service.getItems('u1', 'imp1', {
      status: 'needs_review',
      entity: 'WATCHED_MOVIE',
    });

    expect(prisma.importItem.groupBy).toHaveBeenCalledWith({
      by: ['sourceEntityType'],
      where: { importId: 'imp1', status: 'NEEDS_REVIEW' },
      _count: { _all: true },
    });
    expect(res.entityCounts).toEqual({ WATCHED_EPISODE: 5, WATCHED_MOVIE: 2 });
    expect(res.total).toBe(7);
  });
});
