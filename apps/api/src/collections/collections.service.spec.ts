import { MediaType } from '@tvwatch/shared';
import { CollectionsService } from './collections.service';

describe('CollectionsService bounded movie library', () => {
  it('filters watched movies before paging the watchlist', async () => {
    const prisma = {
      watchlistItem: {
        findMany: jest.fn().mockResolvedValue([{ mediaId: 'movie1' }]),
        count: jest.fn().mockResolvedValue(1),
      },
    };
    const discovery = {
      fetchCardDtos: jest.fn().mockResolvedValue([{ id: 'movie1', title: 'Movie' }]),
    };
    const service = new CollectionsService(
      prisma as any,
      { emit: jest.fn() } as any,
      {} as any,
      discovery as any,
    );

    const result = await service.watchlist('u1', MediaType.MOVIE, 1, 60, undefined, true);

    expect(prisma.watchlistItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 60,
        where: expect.objectContaining({
          userId: 'u1',
          media: expect.objectContaining({
            type: MediaType.MOVIE,
            movieStatuses: { none: { userId: 'u1', watched: true } },
          }),
        }),
      }),
    );
    expect(result.total).toBe(1);
  });
});
