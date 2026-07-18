import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ExternalProvider } from '@tvwatch/shared';
import { ShowsService } from './shows.service';

type FnMap = Record<string, jest.Mock>;

function model(fns: string[]): FnMap {
  const m: FnMap = {};
  for (const f of fns) m[f] = jest.fn().mockResolvedValue(undefined);
  return m;
}

function mockPrisma() {
  return {
    userEpisodeStatus: model(['findUnique', 'update', 'groupBy']),
    rating: model(['findUnique', 'upsert', 'groupBy']),
    reaction: model(['findUnique', 'findMany', 'create', 'delete', 'groupBy']),
    characterVote: model(['findUnique', 'upsert', 'deleteMany', 'groupBy']),
    mediaCast: model(['findFirst']),
    episode: model(['findUnique']),
  } as any;
}

describe('ShowsService voting', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let service: ShowsService;

  beforeEach(() => {
    prisma = mockPrisma();
    service = new ShowsService(
      prisma,
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
    );
  });

  describe('voteDevice', () => {
    it('throws when the episode is not watched/tracked', async () => {
      prisma.userEpisodeStatus.findUnique.mockResolvedValue(null);
      await expect(service.voteDevice('u', 'e', 'TV')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects an invalid device value', async () => {
      prisma.userEpisodeStatus.findUnique.mockResolvedValue({ id: 's1' });
      await expect(service.voteDevice('u', 'e', 'WATCH')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.userEpisodeStatus.update).not.toHaveBeenCalled();
    });

    it('upserts the device and returns the recomputed section', async () => {
      prisma.userEpisodeStatus.findUnique.mockResolvedValue({ id: 's1', device: 'TV' });
      prisma.userEpisodeStatus.groupBy.mockResolvedValue([
        { device: 'TV', _count: { _all: 3 } },
        { device: 'PHONE', _count: { _all: 1 } },
      ]);
      const section = await service.voteDevice('u', 'e', 'TV');
      expect(prisma.userEpisodeStatus.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { device: 'TV' } }),
      );
      expect(section.userVote).toBe('TV');
      expect(section.total).toBe(4);
      const byValue = new Map(section.options.map((o: any) => [o.value, o.count]));
      expect(byValue.get('TV')).toBe(3);
      expect(byValue.get('PHONE')).toBe(1);
      expect(byValue.get('TABLET')).toBe(0);
    });
  });

  describe('voteRating', () => {
    it('rejects out-of-range ratings', async () => {
      prisma.userEpisodeStatus.findUnique.mockResolvedValue({ id: 's1' });
      await expect(service.voteRating('u', 'e', 0)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.voteRating('u', 'e', 6)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.rating.upsert).not.toHaveBeenCalled();
    });

    it('upserts the rating and returns the section with exact buckets', async () => {
      prisma.userEpisodeStatus.findUnique.mockResolvedValue({ id: 's1' });
      prisma.episode.findUnique.mockResolvedValue({ season: { show: { mediaId: 'm1' } } });
      prisma.rating.findUnique.mockResolvedValue({ rating: 4 });
      prisma.rating.groupBy.mockResolvedValue([
        { rating: 4, _count: { _all: 5 } },
        { rating: 5, _count: { _all: 2 } },
      ]);
      const section = await service.voteRating('u', 'e', 4);
      expect(prisma.rating.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: expect.objectContaining({ rating: 4 }) }),
      );
      expect(section.userVote).toBe('4');
      expect(section.total).toBe(7);
      const byValue = new Map(section.options.map((o: any) => [o.value, o.count]));
      expect(byValue.get('4')).toBe(5);
      expect(byValue.get('5')).toBe(2);
      expect(byValue.get('1')).toBe(0);
    });
  });

  describe('voteReaction', () => {
    it('rejects an invalid reaction', async () => {
      prisma.userEpisodeStatus.findUnique.mockResolvedValue({ id: 's1' });
      await expect(service.voteReaction('u', 'e', 'HAPPY')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.reaction.create).not.toHaveBeenCalled();
      expect(prisma.reaction.delete).not.toHaveBeenCalled();
    });

    it('toggles a reaction on (creates when absent)', async () => {
      prisma.userEpisodeStatus.findUnique.mockResolvedValue({ id: 's1' });
      prisma.reaction.findUnique.mockResolvedValue(null); // not yet present
      prisma.reaction.findMany.mockResolvedValue([{ reaction: 'SAD' }]);
      prisma.reaction.groupBy
        .mockResolvedValueOnce([{ userId: 'u' }]) // distinct users
        .mockResolvedValueOnce([{ reaction: 'SAD', _count: { _all: 1 } }]); // per-reaction counts
      const section: any = await service.voteReaction('u', 'e', 'SAD');
      expect(prisma.reaction.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ reaction: 'SAD' }) }),
      );
      expect(prisma.reaction.delete).not.toHaveBeenCalled();
      expect(section.userVotes).toEqual(['SAD']);
      expect(section.total).toBe(1);
      expect(new Map(section.options.map((o: any) => [o.value, o.count])).get('SAD')).toBe(1);
    });

    it('toggles a reaction off (deletes when present)', async () => {
      prisma.userEpisodeStatus.findUnique.mockResolvedValue({ id: 's1' });
      prisma.reaction.findUnique.mockResolvedValue({ id: 'r1' }); // already present
      prisma.reaction.findMany.mockResolvedValue([]);
      prisma.reaction.groupBy.mockResolvedValue([]); // no reactions left
      await service.voteReaction('u', 'e', 'SAD');
      expect(prisma.reaction.delete).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'r1' } }),
      );
      expect(prisma.reaction.create).not.toHaveBeenCalled();
    });
  });

  describe('voteFavoriteCharacter', () => {
    it('rejects a cast id that is not part of the show', async () => {
      prisma.userEpisodeStatus.findUnique.mockResolvedValue({ id: 's1' });
      prisma.episode.findUnique.mockResolvedValue({ season: { show: { mediaId: 'm1' } } });
      prisma.mediaCast.findFirst.mockResolvedValue(null);
      await expect(service.voteFavoriteCharacter('u', 'e', 'foreign')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.characterVote.upsert).not.toHaveBeenCalled();
    });

    it('upserts the favorite by stable cast id', async () => {
      prisma.userEpisodeStatus.findUnique.mockResolvedValue({ id: 's1' });
      prisma.episode.findUnique.mockResolvedValue({ season: { show: { mediaId: 'm1' } } });
      prisma.mediaCast.findFirst.mockResolvedValue({ id: 'c1' });
      prisma.characterVote.findUnique.mockResolvedValue({ castId: 'c1' });
      prisma.characterVote.groupBy.mockResolvedValue([{ castId: 'c1', _count: { _all: 1 } }]);
      const section = await service.voteFavoriteCharacter('u', 'e', 'c1');
      expect(prisma.characterVote.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: expect.objectContaining({ castId: 'c1' }) }),
      );
      expect(section.userVote).toBe('c1');
      expect(section.total).toBe(1);
    });

    it('deletes the vote when value is null', async () => {
      prisma.userEpisodeStatus.findUnique.mockResolvedValue({ id: 's1' });
      prisma.episode.findUnique.mockResolvedValue({ season: { show: { mediaId: 'm1' } } });
      prisma.characterVote.groupBy.mockResolvedValue([]);
      await service.voteFavoriteCharacter('u', 'e', null);
      expect(prisma.characterVote.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'u', episodeId: 'e' } }),
      );
    });
  });
});

describe('ShowsService.getShow (anime repair)', () => {
  let prisma: any;
  let meta: any;
  let backfill: any;
  let service: ShowsService;

  const stored = (over: Record<string, unknown> = {}) => ({
    id: 'm1',
    titles: { en: 'Naruto' },
    metadataRefreshedAt: null, // → needsHydration
    externalIds: [
      { provider: ExternalProvider.TMDB, value: '11' },
      { provider: ExternalProvider.THE_TVDB, value: '789' },
    ],
    genres: [{ genre: { slug: 'animation' } }],
    ...over,
  });

  beforeEach(() => {
    prisma = {
      mediaItem: { findUnique: jest.fn() },
      mediaGenre: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    meta = {
      ensureShowFull: jest.fn().mockResolvedValue('m1'),
      ensureShowFullTvdb: jest.fn().mockResolvedValue('m1'),
      ensureAirtimes: jest.fn().mockResolvedValue(undefined),
      scheduleClassification: jest.fn().mockResolvedValue(undefined),
      getShowDetail: jest.fn().mockResolvedValue('detail'),
      getShowSeasons: jest.fn().mockResolvedValue([]),
    };
    backfill = { fixAnimeShowFromTvdb: jest.fn() };
    service = new ShowsService(
      prisma,
      meta,
      { enabled: true } as any,
      { enabled: true } as any,
      backfill,
    );
  });

  it('repairs TMDB-structured anime on the fly (no provider refresh afterwards)', async () => {
    prisma.mediaItem.findUnique.mockResolvedValue(stored());
    backfill.fixAnimeShowFromTvdb.mockResolvedValue({ fixed: true, remapped: 50 });
    const res = await service.getShow('m1');
    expect(backfill.fixAnimeShowFromTvdb).toHaveBeenCalledWith('m1');
    expect(meta.ensureShowFull).not.toHaveBeenCalled();
    expect(meta.ensureShowFullTvdb).not.toHaveBeenCalled();
    expect(res).toBe('detail');
  });

  it('refreshes from TVDB when the repair no-ops and metadata is stale', async () => {
    prisma.mediaItem.findUnique.mockResolvedValue(stored());
    backfill.fixAnimeShowFromTvdb.mockResolvedValue({ fixed: false, remapped: 0 });
    await service.getShow('m1');
    expect(meta.ensureShowFullTvdb).toHaveBeenCalledWith(789);
    expect(meta.ensureShowFull).not.toHaveBeenCalled();
  });

  it('never re-poisons animation shows from TMDB when the fix fails and no TVDB id exists', async () => {
    prisma.mediaItem.findUnique.mockResolvedValue(
      stored({ externalIds: [{ provider: ExternalProvider.TMDB, value: '11' }] }),
    );
    backfill.fixAnimeShowFromTvdb.mockResolvedValue({ fixed: false, remapped: 0 });
    await service.getShow('m1');
    expect(meta.ensureShowFull).not.toHaveBeenCalled();
    expect(meta.ensureShowFullTvdb).not.toHaveBeenCalled();
  });

  it('keeps the TMDB-first refresh for non-animation shows', async () => {
    prisma.mediaItem.findUnique.mockResolvedValue(
      stored({ genres: [{ genre: { slug: 'drama' } }] }),
    );
    await service.getShow('m1');
    expect(backfill.fixAnimeShowFromTvdb).not.toHaveBeenCalled();
    expect(meta.ensureShowFull).toHaveBeenCalledWith(11);
  });

  it('repairs anime structure on the episodes path too (no pre-fix seasons)', async () => {
    prisma.mediaGenre.findFirst.mockResolvedValue({ mediaId: 'm1' });
    backfill.fixAnimeShowFromTvdb.mockResolvedValue({ fixed: true, remapped: 50 });
    await service.getSeasons('m1', 'u1');
    expect(backfill.fixAnimeShowFromTvdb).toHaveBeenCalledWith('m1');
    // Seasons are read AFTER the shared repair resolves.
    expect(meta.getShowSeasons).toHaveBeenCalledWith('m1', 'u1');
  });

  it('does not touch the repair on the episodes path for non-animation shows', async () => {
    prisma.mediaGenre.findFirst.mockResolvedValue(null);
    await service.getSeasons('m1');
    expect(backfill.fixAnimeShowFromTvdb).not.toHaveBeenCalled();
    expect(meta.getShowSeasons).toHaveBeenCalledWith('m1', undefined);
  });
});
