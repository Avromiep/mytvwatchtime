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
    episode: { delete: jest.fn().mockResolvedValue({}), update: jest.fn().mockResolvedValue({}) },
    season: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    userShowStatus: { upsert: jest.fn().mockResolvedValue({}) },
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(0),
  };
  // Transactions run against the same mock (tx exposes the same model API); array form
  // (used by the absoluteNumber backfill) just awaits all statements.
  p.$transaction = jest.fn((arg: any) => (Array.isArray(arg) ? Promise.all(arg) : arg(p)));
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
    // No transfer ran (only the absoluteNumber backfill touches the DB in this test).
    expect(prisma.userEpisodeStatus.update).not.toHaveBeenCalled();
    expect(prisma.watchHistory.updateMany).not.toHaveBeenCalled();
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

  it('remapEpisodesToMedia moves user data across entities (contamination split)', async () => {
    prisma.show.findUnique.mockImplementation(({ where: { mediaId } }: any) =>
      Promise.resolve(
        mediaId === 'movie-1'
          ? showWith([season('s1', 1, [ep({ id: 'old', number: 1, title: 'Pilot', airDate: D })])])
          : showWith([
              season('s2', 1, [
                ep({
                  id: 'new',
                  number: 1,
                  title: 'Pilot',
                  airDate: D,
                  externalIds: [{ provider: 'THE_TVDB' }],
                }),
              ]),
            ]),
      ),
    );
    prisma.userEpisodeStatus.findMany.mockResolvedValue([
      {
        id: 'ues1',
        userId: 'u1',
        episodeId: 'old',
        watched: true,
        watchedAt: D2,
        watchCount: 1,
        device: null,
      },
    ]);

    const res = await service.remapEpisodesToMedia('movie-1', 'show-new');

    expect(res).toMatchObject({ stale: 1, mapped: 1, statusesMoved: 1, episodesRemoved: 1 });
    expect(prisma.userEpisodeStatus.update).toHaveBeenCalledWith({
      where: { id: 'ues1' },
      data: { episodeId: 'new' },
    });
    expect(prisma.episode.delete).toHaveBeenCalledWith({ where: { id: 'old' } });
    // Progress cache recomputed on the TARGET show.
    expect(prisma.userShowStatus.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId_mediaId: { userId: 'u1', mediaId: 'show-new' } } }),
    );
  });

  // ---- Matching ladder v2 (absoluteNumber) — the Dragon Ball regression ----

  it('maps a flattened TMDB row onto the split TVDB structure via absoluteNumber', async () => {
    // Dragon Ball shape: TMDB S1 = 153 eps; TVDB S1 = 35, S2 = 15, … — stale TMDB
    // S1E36.. predate the absoluteNumber column (null); TVDB rows carry provider values.
    prisma.show.findUnique.mockResolvedValue(
      showWith([
        season('s1', 1, [
          // Fresh merged rows: TVDB S1E1..E3 (TVDB absolute 1..3) — have TMDB + TVDB ids.
          ...[1, 2, 3].map((n) =>
            ep({
              id: `fresh-s1e${n}`,
              number: n,
              title: `DB ep ${n}`,
              absoluteNumber: n,
              externalIds: [{ provider: 'TMDB' }, { provider: 'THE_TVDB' }],
            }),
          ),
          // Stale flattened TMDB rows S1E4.. (absoluteNumber unknown — backfilled).
          ep({ id: 'stale-e4', number: 4, title: 'DB ep 4 (tmdb title)', absoluteNumber: null }),
          ep({ id: 'stale-e5', number: 5, title: 'DB ep 5 (tmdb title)', absoluteNumber: null }),
        ]),
        season('s2', 2, [
          // TVDB S2E1/E2 = absolute 4/5.
          ep({
            id: 'fresh-s2e1',
            number: 1,
            title: 'DB ep 4 (tvdb title)',
            absoluteNumber: 4,
            externalIds: [{ provider: 'THE_TVDB' }],
          }),
          ep({
            id: 'fresh-s2e2',
            number: 2,
            title: 'DB ep 5 (tvdb title)',
            absoluteNumber: 5,
            externalIds: [{ provider: 'THE_TVDB' }],
          }),
        ]),
      ]),
    );

    const res = await service.remapShow('m1');

    expect(res.stale).toBe(2);
    expect(res.mapped).toBe(2);
    expect(res.unmapped).toBe(0);
    expect(res.matchRules).toEqual({ absolute: 2 });
    // Backfill assigned 4/5 to the stale rows (never overwrote provider values).
    expect(prisma.episode.update).toHaveBeenCalledWith({
      where: { id: 'stale-e4' },
      data: { absoluteNumber: 4 },
    });
    expect(prisma.episode.update).toHaveBeenCalledWith({
      where: { id: 'stale-e5' },
      data: { absoluteNumber: 5 },
    });
    // Stale rows deleted after their (empty) user-data transfer.
    expect(prisma.episode.delete).toHaveBeenCalledWith({ where: { id: 'stale-e4' } });
    expect(prisma.episode.delete).toHaveBeenCalledWith({ where: { id: 'stale-e5' } });
  });

  it('trusts a unique absolute match even when provider airDates conflict', async () => {
    // Real data: TMDB S1E36 "Major Metallitron" (1986-10-29) vs TVDB S3E8 (1987-06-10) —
    // same episode, provider dates months apart. Unique absolute correspondence wins.
    prisma.show.findUnique.mockResolvedValue(
      showWith([
        season('s1', 1, [ep({ id: 'stale', number: 7, title: 'X', absoluteNumber: 7, airDate: D })]),
        season('s2', 2, [
          ep({
            id: 'fresh-conflict',
            number: 1,
            title: 'Y',
            absoluteNumber: 7,
            airDate: D2,
            externalIds: [{ provider: 'THE_TVDB' }],
          }),
        ]),
      ]),
    );
    prisma.userEpisodeStatus.count.mockResolvedValue(1);

    const res = await service.remapShow('m1');
    expect(res).toMatchObject({ stale: 1, mapped: 1, unmapped: 0 });
    expect(res.matchRules).toEqual({ absolute: 1 });
    expect(prisma.episode.delete).toHaveBeenCalledWith({ where: { id: 'stale' } });
  });

  it('remaps stale rows that have NO provider ids at all (Dragon Ball: ids lost)', async () => {
    // Flattened S1 rows whose TMDB ids were lost entirely: externalIds = [].
    prisma.show.findUnique.mockResolvedValue(
      showWith([
        season('s1', 1, [
          ep({ id: 'fresh-e1', number: 1, title: 'Ep 1', absoluteNumber: 1, externalIds: [{ provider: 'THE_TVDB' }] }),
          ep({ id: 'stale-e2', number: 2, title: 'Ep 2', absoluteNumber: null, externalIds: [] }),
        ]),
        season('s2', 2, [
          ep({ id: 'fresh-e2', number: 1, title: 'Ep 2', absoluteNumber: 2, externalIds: [{ provider: 'THE_TVDB' }] }),
        ]),
      ]),
    );

    const res = await service.remapShow('m1');
    expect(res.stale).toBe(1);
    expect(res.mapped).toBe(1);
    expect(res.matchRules).toEqual({ absolute: 1 });
    expect(prisma.episode.delete).toHaveBeenCalledWith({ where: { id: 'stale-e2' } });
  });

  it('never deletes into the void when no TVDB-linked rows exist', async () => {
    prisma.show.findUnique.mockResolvedValue(
      showWith([
        season('s1', 1, [
          ep({ id: 'e1', number: 1, title: 'A' }),
          ep({ id: 'e2', number: 2, title: 'B' }),
        ]),
      ]),
    );
    const res = await service.remapShow('m1');
    expect(res).toMatchObject({ stale: 0, mapped: 0, episodesRemoved: 0 });
    expect(prisma.episode.delete).not.toHaveBeenCalled();
  });

  it('matches via absolute+date when both signals agree', async () => {
    prisma.show.findUnique.mockResolvedValue(
      showWith([
        season('s1', 1, [ep({ id: 'stale', number: 7, title: 'Old', absoluteNumber: 7, airDate: D })]),
        season('s2', 2, [
          ep({
            id: 'fresh',
            number: 1,
            title: 'New',
            absoluteNumber: 7,
            airDate: D,
            externalIds: [{ provider: 'THE_TVDB' }],
          }),
        ]),
      ]),
    );
    const res = await service.remapShow('m1');
    expect(res.mapped).toBe(1);
    expect(res.matchRules).toEqual({ 'absolute+date': 1 });
  });

  it('refuses to guess when two fresh rows share an absolute number', async () => {
    prisma.show.findUnique.mockResolvedValue(
      showWith([
        season('s1', 1, [ep({ id: 'stale', number: 7, title: 'Old', absoluteNumber: 7 })]),
        season('s2', 2, [
          ep({ id: 'f1', number: 1, title: 'A', absoluteNumber: 7, externalIds: [{ provider: 'THE_TVDB' }] }),
          ep({ id: 'f2', number: 2, title: 'B', absoluteNumber: 7, externalIds: [{ provider: 'THE_TVDB' }] }),
        ]),
      ]),
    );
    const res = await service.remapShow('m1');
    expect(res.mapped).toBe(0);
    expect(res.unmapped).toBe(0); // no user data → deleted, but never mis-mapped
    expect(res.episodesRemoved).toBe(1);
  });

  it('dry-run computes matches and kept/deleted counts without any writes', async () => {
    prisma.show.findUnique.mockResolvedValue(
      showWith([
        season('s1', 1, [
          ep({ id: 'stale-mapped', number: 4, title: 'M', absoluteNumber: 4 }),
          ep({ id: 'stale-unmapped', number: 99, title: 'U', absoluteNumber: 99 }),
        ]),
        season('s2', 2, [
          ep({ id: 'fresh', number: 1, title: 'M2', absoluteNumber: 4, externalIds: [{ provider: 'THE_TVDB' }] }),
        ]),
      ]),
    );

    const res = await service.remapShow('m1', { dryRun: true });

    expect(res.dryRun).toBe(true);
    expect(res.stale).toBe(2);
    expect(res.mapped).toBe(1);
    expect(res.matchRules).toEqual({ absolute: 1 });
    expect(res.episodesRemoved).toBe(1); // would-be deletion of the data-free unmapped row
    // No writes at all: no transferPair, no backfill persist, no deletes.
    expect(prisma.episode.delete).not.toHaveBeenCalled();
    expect(prisma.episode.update).not.toHaveBeenCalled();
    expect(prisma.watchHistory.updateMany).not.toHaveBeenCalled();
    expect(prisma.season.deleteMany).not.toHaveBeenCalled();
  });
});
