import { StructureRemapService } from './structure-remap.service';

const D = new Date('2024-01-05T00:00:00Z');
const D2 = new Date('2024-01-12T00:00:00Z');

function mockPrisma() {
  const p: any = {
    show: { findUnique: jest.fn() },
    userEpisodeStatus: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
    },
    watchHistory: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    rating: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
    },
    reaction: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
    },
    characterVote: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
    },
    comment: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      count: jest.fn().mockResolvedValue(0),
    },
    episode: { delete: jest.fn().mockResolvedValue({}) },
    season: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    userShowStatus: { upsert: jest.fn().mockResolvedValue({}) },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  // Transactions run against the same mock (tx exposes the same model API).
  p.$transaction = jest.fn((fn: any) => fn(p));
  return p;
}

const ep = (over: Record<string, unknown>) => ({
  id: 'e1',
  number: 1,
  title: 'Episode',
  airDate: null,
  externalIds: [{ provider: 'TMDB' }],
  ...over,
});

const showWith = (seasons: any[]) => ({ id: 'sh1', mediaId: 'm1', seasons });
const season = (id: string, number: number, episodes: any[], isSpecial = false) => ({
  id,
  number,
  isSpecial,
  episodes,
});

describe('StructureRemapService', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let service: StructureRemapService;

  beforeEach(() => {
    prisma = mockPrisma();
    service = new StructureRemapService(prisma);
  });

  it('is a no-op when no stale TMDB-only episodes exist', async () => {
    prisma.show.findUnique.mockResolvedValue(
      showWith([
        season('s1', 1, [ep({ externalIds: [{ provider: 'TMDB' }, { provider: 'THE_TVDB' }] })]),
      ]),
    );
    const res = await service.remapShow('m1');
    expect(res.stale).toBe(0);
    expect(prisma.episode.delete).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('transfers all user data from a stale row to the airDate-matched fresh row', async () => {
    prisma.show.findUnique.mockResolvedValue(
      showWith([
        season('s1', 1, [ep({ id: 'old', number: 30, title: 'The Forest', airDate: D })]),
        season('s2', 2, [
          ep({
            id: 'new',
            number: 5,
            title: 'The Forest',
            airDate: D,
            externalIds: [{ provider: 'TMDB' }, { provider: 'THE_TVDB' }],
          }),
        ]),
      ]),
    );
    prisma.userEpisodeStatus.findMany.mockResolvedValue([
      {
        id: 'ues1',
        userId: 'u1',
        episodeId: 'old',
        watched: true,
        watchedAt: D2,
        watchCount: 2,
        device: 'TV',
      },
    ]);
    prisma.watchHistory.updateMany.mockResolvedValue({ count: 3 });
    prisma.rating.findMany.mockResolvedValue([
      { id: 'r1', userId: 'u1', episodeId: 'old', rating: 5 },
    ]);
    prisma.rating.findFirst.mockResolvedValue({ id: 'r-target' }); // user already rated the target
    prisma.reaction.findMany.mockResolvedValue([
      { id: 're1', userId: 'u1', episodeId: 'old', reaction: 'HAPPY' },
    ]);
    prisma.characterVote.findMany.mockResolvedValue([
      { id: 'v1', userId: 'u1', episodeId: 'old', castId: 'c1' },
    ]);
    prisma.comment.updateMany.mockResolvedValue({ count: 2 });

    const res = await service.remapShow('m1');

    expect(res).toMatchObject({
      stale: 1,
      mapped: 1,
      unmapped: 0,
      statusesMoved: 1,
      historiesMoved: 3,
      ratingsMoved: 1,
      reactionsMoved: 1,
      votesMoved: 1,
      commentsMoved: 2,
      episodesRemoved: 1,
    });
    // Status re-pointed (no target row), watch history re-pointed with the new S/E numbers.
    expect(prisma.userEpisodeStatus.update).toHaveBeenCalledWith({
      where: { id: 'ues1' },
      data: { episodeId: 'new' },
    });
    expect(prisma.watchHistory.updateMany).toHaveBeenCalledWith({
      where: { episodeId: 'old' },
      data: { episodeId: 'new', seasonNumber: 2, episodeNumber: 5 },
    });
    // Target rating wins; stale rating deleted.
    expect(prisma.rating.delete).toHaveBeenCalledWith({ where: { id: 'r1' } });
    expect(prisma.rating.update).not.toHaveBeenCalled();
    // Reaction/vote re-pointed (no conflict).
    expect(prisma.reaction.update).toHaveBeenCalledWith({
      where: { id: 're1' },
      data: { episodeId: 'new' },
    });
    expect(prisma.characterVote.update).toHaveBeenCalledWith({
      where: { id: 'v1' },
      data: { episodeId: 'new' },
    });
    // Comments re-threaded, stale row gone, progress cache recomputed for the touched user.
    expect(prisma.comment.updateMany).toHaveBeenCalledWith({
      where: { threadType: 'EPISODE', threadId: 'old' },
      data: { threadId: 'new' },
    });
    expect(prisma.episode.delete).toHaveBeenCalledWith({ where: { id: 'old' } });
    expect(prisma.userShowStatus.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId_mediaId: { userId: 'u1', mediaId: 'm1' } } }),
    );
  });

  it('merges into the target status row when the user already has one', async () => {
    prisma.show.findUnique.mockResolvedValue(
      showWith([
        season('s1', 1, [ep({ id: 'old', number: 30, title: 'The Forest', airDate: D })]),
        season('s2', 2, [
          ep({
            id: 'new',
            number: 5,
            title: 'The Forest',
            airDate: D,
            externalIds: [{ provider: 'THE_TVDB' }],
          }),
        ]),
      ]),
    );
    prisma.userEpisodeStatus.findMany.mockResolvedValue([
      {
        id: 'ues-old',
        userId: 'u1',
        episodeId: 'old',
        watched: true,
        watchedAt: D2,
        watchCount: 2,
        device: 'TV',
      },
    ]);
    prisma.userEpisodeStatus.findUnique.mockResolvedValue({
      id: 'ues-new',
      userId: 'u1',
      episodeId: 'new',
      watched: false,
      watchedAt: null,
      watchCount: 1,
      device: null,
    });

    const res = await service.remapShow('m1');

    expect(res.mapped).toBe(1);
    expect(prisma.userEpisodeStatus.update).toHaveBeenCalledWith({
      where: { id: 'ues-new' },
      data: { watched: true, watchedAt: D2, watchCount: 2, device: 'TV' },
    });
    expect(prisma.userEpisodeStatus.delete).toHaveBeenCalledWith({ where: { id: 'ues-old' } });
  });

  it('falls back to exact-title matching when there is no airDate', async () => {
    prisma.show.findUnique.mockResolvedValue(
      showWith([
        season('s0', 0, [ep({ id: 'old', number: 3, title: 'OVA: Memory Snow' })], true),
        season(
          's0',
          0,
          [
            ep({
              id: 'new',
              number: 1,
              title: 'OVA: Memory Snow',
              externalIds: [{ provider: 'THE_TVDB' }],
            }),
          ],
          true,
        ),
      ]),
    );
    const res = await service.remapShow('m1');
    expect(res.mapped).toBe(1);
    expect(prisma.episode.delete).toHaveBeenCalledWith({ where: { id: 'old' } });
  });

  it('refuses ambiguous airDate groups and keeps rows that carry user data', async () => {
    prisma.show.findUnique.mockResolvedValue(
      showWith([
        season('s1', 1, [ep({ id: 'old', number: 30, title: 'Old Title', airDate: D })]),
        season('s2', 2, [
          ep({
            id: 'n1',
            number: 1,
            title: 'Other A',
            airDate: D,
            externalIds: [{ provider: 'THE_TVDB' }],
          }),
          ep({
            id: 'n2',
            number: 2,
            title: 'Other B',
            airDate: D,
            externalIds: [{ provider: 'THE_TVDB' }],
          }),
        ]),
      ]),
    );
    prisma.userEpisodeStatus.count.mockResolvedValue(1); // stale row has user data

    const res = await service.remapShow('m1');

    expect(res).toMatchObject({ stale: 1, mapped: 0, unmapped: 1, episodesRemoved: 0 });
    expect(prisma.episode.delete).not.toHaveBeenCalled(); // kept — never lose watch data
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('deletes unmapped stale rows that carry no user data and drops emptied seasons', async () => {
    prisma.show.findUnique.mockResolvedValue(
      showWith([
        season('s9', 9, [ep({ id: 'old', number: 1, title: 'Phantom' })]),
        season('s1', 1, [
          ep({ id: 'new', number: 1, title: 'Real', externalIds: [{ provider: 'THE_TVDB' }] }),
        ]),
      ]),
    );
    prisma.season.deleteMany.mockResolvedValue({ count: 1 });

    const res = await service.remapShow('m1');

    expect(res).toMatchObject({
      stale: 1,
      mapped: 0,
      unmapped: 0,
      episodesRemoved: 1,
      seasonsRemoved: 1,
    });
    expect(prisma.episode.delete).toHaveBeenCalledWith({ where: { id: 'old' } });
    expect(prisma.season.deleteMany).toHaveBeenCalledWith({
      where: { showId: 'sh1', episodes: { none: {} } },
    });
  });
});
