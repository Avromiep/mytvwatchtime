import { ProfileTasteService } from './profile-taste.service';

function makeService() {
  const prisma: any = {
    user: {
      findFirst: jest.fn(async () => ({ id: 'target', profile: { isPrivate: false } })),
    },
    follow: { findUnique: jest.fn() },
    block: { findFirst: jest.fn(async () => null) },
    favorite: {
      findMany: jest.fn(async (args: any) =>
        args.where.userId === 'target'
          ? [{ mediaId: 'm1', createdAt: new Date('2026-08-01') }]
          : [],
      ),
    },
    rating: {
      findMany: jest.fn(async (args: any) =>
        args.where.mediaId ? [{ mediaId: 'm2', rating: 5, updatedAt: new Date('2026-08-02') }] : [],
      ),
    },
    reaction: { findMany: jest.fn(async () => []) },
    watchlistItem: {
      findMany: jest.fn(async () => [{ mediaId: 'm2' }]),
    },
    watchHistory: { findMany: jest.fn(async () => []) },
    mediaItem: {
      findMany: jest.fn(async () => [
        {
          id: 'm1',
          type: 'MOVIE',
          genres: [{ genre: { id: 'g1', name: 'Drama', slug: 'drama' } }],
        },
        {
          id: 'm2',
          type: 'MOVIE',
          genres: [{ genre: { id: 'g1', name: 'Drama', slug: 'drama' } }],
        },
      ]),
    },
    genre: {
      findMany: jest.fn(async () => [{ id: 'g1', name: 'Drama', slug: 'drama' }]),
    },
  };
  const discovery: any = {
    fetchCardDtos: jest.fn(async (ids: string[]) =>
      ids.map((id) => ({
        id,
        type: 'MOVIE',
        title: id,
        images: {},
      })),
    ),
  };
  const stats: any = {
    getShowStats: jest.fn(async () => ({ topGenres: [] })),
    getMovieStats: jest.fn(async () => ({ topGenres: [{ name: 'Drama', count: 8 }] })),
  };
  return { service: new ProfileTasteService(prisma, discovery, stats), prisma };
}

describe('ProfileTasteService', () => {
  it('recommends strong endorsements that overlap viewer genres', async () => {
    const { service } = makeService();

    const result = await service.recommendations('target_user', 'viewer', 1, 30);

    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({
      id: 'm1',
      matchedGenres: [{ id: 'g1', slug: 'drama' }],
      signals: ['FAVORITE'],
    });
  });

  it('rejects private taste data for non-followers', async () => {
    const { service, prisma } = makeService();
    prisma.user.findFirst.mockResolvedValue({ id: 'target', profile: { isPrivate: true } });
    prisma.follow.findUnique.mockResolvedValue(null);

    await expect(service.recommendations('target_user', 'viewer')).rejects.toThrow(
      'This profile is private',
    );
  });
});
