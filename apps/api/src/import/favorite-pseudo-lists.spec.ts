import { ImportService } from './import.service';

/**
 * Legacy favorite-* pseudo-list migration: old imports created CustomLists with
 * sourceKey favorite-series/favorite-movies. On confirm, their items become real
 * favorites (deduped by mediaId) and the pseudo-lists are deleted.
 */
describe('ImportService.migrateFavoritePseudoLists', () => {
  function makeService(opts: {
    lists: { id: string; sourceKey: string; items: { mediaId: string }[] }[];
    existingFavorites?: string[];
  }) {
    const prisma: any = {
      customList: {
        findMany: jest.fn(async () => opts.lists),
        deleteMany: jest.fn(async () => ({ count: opts.lists.length })),
      },
      favorite: {
        findMany: jest.fn(async () =>
          (opts.existingFavorites ?? []).map((mediaId) => ({ mediaId })),
        ),
      },
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    const chunked: { model: string; rows: any[] }[] = [];
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
    (service as any).chunkedCreateMany = jest.fn(async (_tx: any, model: string, rows: any[]) => {
      chunked.push({ model, rows });
    });
    return { service: service as any, prisma, chunked };
  }

  it('moves pseudo-list items into favorites (deduped) and deletes the lists', async () => {
    const { service, prisma, chunked } = makeService({
      lists: [
        { id: 'l1', sourceKey: 'favorite-series', items: [{ mediaId: 's1' }, { mediaId: 's2' }] },
        { id: 'l2', sourceKey: 'favorite-movies', items: [{ mediaId: 'm1' }, { mediaId: 's1' }] },
      ],
      existingFavorites: ['s2'],
    });

    await service.migrateFavoritePseudoLists('u1', 'imp1');

    const favRows = chunked.filter((c) => c.model === 'favorite').flatMap((c) => c.rows);
    expect(favRows.map((r) => r.mediaId).sort()).toEqual(['m1', 's1']); // s2 already a favorite, s1 deduped
    expect(favRows.every((r) => r.userId === 'u1')).toBe(true);
    expect(prisma.customList.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['l1', 'l2'] } },
    });
  });

  it('still deletes the pseudo-lists when every item is already a favorite', async () => {
    const { service, prisma, chunked } = makeService({
      lists: [{ id: 'l1', sourceKey: 'favorite-series', items: [{ mediaId: 's1' }] }],
      existingFavorites: ['s1'],
    });

    await service.migrateFavoritePseudoLists('u1', 'imp1');

    expect(chunked.filter((c) => c.model === 'favorite')).toEqual([]);
    expect(prisma.customList.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['l1'] } } });
  });

  it('is a no-op when the user has no pseudo-lists', async () => {
    const { service, prisma } = makeService({ lists: [] });

    await service.migrateFavoritePseudoLists('u1', 'imp1');

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.customList.deleteMany).not.toHaveBeenCalled();
  });
});
