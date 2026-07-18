import { ExternalProvider } from '@tvwatch/shared';
import { MetadataBackfillService } from './metadata-backfill.service';
import { ProviderError } from './providers/shared/provider-errors';
import { ProviderThrottled } from './providers/shared/provider-http';

type FnMap = Record<string, jest.Mock>;

function model(fns: string[]): FnMap {
  const m: FnMap = {};
  for (const f of fns) m[f] = jest.fn().mockResolvedValue(undefined);
  return m;
}

function mockPrisma() {
  return {
    mediaItem: model(['count', 'findMany', 'groupBy', 'update']),
    episode: model(['count']),
    externalId: model(['findMany', 'findFirst', 'create']),
    $queryRaw: jest.fn().mockResolvedValue([{ c: BigInt(0) }]),
  } as any;
}

function mockMeta() {
  return {
    ensureShowFull: jest.fn().mockResolvedValue('m1'),
    ensureShowFullTvdb: jest.fn().mockResolvedValue('m1'),
    ensureMovieFull: jest.fn().mockResolvedValue('m1'),
    ensureMovieFullTvdb: jest.fn().mockResolvedValue('m1'),
    scheduleClassification: jest.fn().mockResolvedValue(undefined),
  } as any;
}

const animeShow = (over: Record<string, unknown> = {}) => ({
  id: 'm1',
  title: 'Naruto',
  type: 'SHOW',
  externalIds: [
    { provider: ExternalProvider.TMDB, value: '11' },
    { provider: ExternalProvider.THE_TVDB, value: '789' },
  ],
  show: { yearStart: 2002 },
  ...over,
});

describe('MetadataBackfillService', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let meta: ReturnType<typeof mockMeta>;
  let redis: any;
  let tmdb: any;
  let tvdb: any;
  let structureRemap: any;
  let service: MetadataBackfillService;

  beforeEach(() => {
    prisma = mockPrisma();
    meta = mockMeta();
    redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      client: { scan: jest.fn().mockResolvedValue(['0', []]), del: jest.fn() },
    };
    tmdb = { enabled: true, get: jest.fn().mockResolvedValue(undefined) };
    tvdb = { enabled: true, searchShows: jest.fn() };
    structureRemap = { remapShow: jest.fn().mockResolvedValue({ stale: 0, mapped: 0, unmapped: 0 }) };
    service = new MetadataBackfillService(prisma, meta, {} as any, redis, tmdb, tvdb, structureRemap);
  });

  describe('rehydrateAnimeFromTvdb', () => {
    it('does nothing when TVDB is not configured', async () => {
      tvdb.enabled = false;
      const res = await service.rehydrateAnimeFromTvdb();
      expect(res.processed).toBe(0);
      expect(prisma.mediaItem.findMany).not.toHaveBeenCalled();
    });

    it('rehydrates TMDB-structured animation shows from their stored TVDB id', async () => {
      prisma.mediaItem.findMany.mockResolvedValue([animeShow()]);
      const res = await service.rehydrateAnimeFromTvdb();
      // Stale gate bypassed so ensureShowFullTvdb cannot skip a recently-refreshed show.
      expect(prisma.mediaItem.update).toHaveBeenCalledWith({
        where: { id: 'm1' },
        data: { metadataRefreshedAt: null },
      });
      expect(meta.ensureShowFullTvdb).toHaveBeenCalledWith(789);
      expect(res).toMatchObject({
        processed: 1,
        succeeded: 1,
        failed: 0,
        rateLimited: 0,
        noTvdbId: 0,
      });
    });

    it('falls back to a strict exact-title+year TVDB search when no TVDB id is stored', async () => {
      prisma.mediaItem.findMany.mockResolvedValue([
        animeShow({ externalIds: [{ provider: ExternalProvider.TMDB, value: '11' }] }),
      ]);
      tvdb.searchShows.mockResolvedValue({
        items: [{ tvdbId: 555, title: 'Naruto', year: 2002 }],
        total: 1,
      });
      prisma.externalId.findFirst.mockResolvedValue(null);
      const res = await service.rehydrateAnimeFromTvdb();
      expect(prisma.externalId.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          mediaId: 'm1',
          provider: ExternalProvider.THE_TVDB,
          value: '555',
        }),
      });
      expect(meta.ensureShowFullTvdb).toHaveBeenCalledWith(555);
      expect(res.succeeded).toBe(1);
    });

    it('rejects search hits whose title or year does not match', async () => {
      prisma.mediaItem.findMany.mockResolvedValue([
        animeShow({ externalIds: [{ provider: ExternalProvider.TMDB, value: '11' }] }),
      ]);
      tvdb.searchShows.mockResolvedValue({
        items: [
          { tvdbId: 555, title: 'Naruto', year: 1990 }, // year mismatch
          { tvdbId: 556, title: 'Naruto Shippuden', year: 2002 }, // title mismatch
        ],
        total: 2,
      });
      const res = await service.rehydrateAnimeFromTvdb();
      expect(res.noTvdbId).toBe(1);
      expect(prisma.externalId.create).not.toHaveBeenCalled();
      expect(meta.ensureShowFullTvdb).not.toHaveBeenCalled();
    });

    it('never hijacks a TVDB id already linked to a different media row', async () => {
      prisma.mediaItem.findMany.mockResolvedValue([
        animeShow({ externalIds: [{ provider: ExternalProvider.TMDB, value: '11' }] }),
      ]);
      tvdb.searchShows.mockResolvedValue({
        items: [{ tvdbId: 555, title: 'Naruto', year: 2002 }],
        total: 1,
      });
      prisma.externalId.findFirst.mockResolvedValue({ mediaId: 'someone-else' });
      const res = await service.rehydrateAnimeFromTvdb();
      expect(res.noTvdbId).toBe(1);
      expect(prisma.externalId.create).not.toHaveBeenCalled();
      expect(meta.ensureShowFullTvdb).not.toHaveBeenCalled();
    });

    it('resolves a missing TVDB id via TMDB /external_ids before any title search', async () => {
      prisma.mediaItem.findMany.mockResolvedValue([
        animeShow({ externalIds: [{ provider: ExternalProvider.TMDB, value: '65942' }] }),
      ]);
      tmdb.get.mockResolvedValue({ id: 65942, tvdb_id: 305089 });
      prisma.externalId.findFirst.mockResolvedValue(null);
      const res = await service.rehydrateAnimeFromTvdb();
      expect(tmdb.get).toHaveBeenCalledWith('/tv/65942/external_ids', {});
      expect(tvdb.searchShows).not.toHaveBeenCalled();
      expect(prisma.externalId.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          mediaId: 'm1',
          provider: ExternalProvider.THE_TVDB,
          value: '305089',
        }),
      });
      expect(meta.ensureShowFullTvdb).toHaveBeenCalledWith(305089);
      expect(res.succeeded).toBe(1);
    });

    it('falls back to title search when TMDB /external_ids has no tvdb_id', async () => {
      prisma.mediaItem.findMany.mockResolvedValue([
        animeShow({ externalIds: [{ provider: ExternalProvider.TMDB, value: '11' }] }),
      ]);
      tmdb.get.mockResolvedValue({ id: 11, tvdb_id: null });
      tvdb.searchShows.mockResolvedValue({
        items: [{ tvdbId: 555, title: 'Naruto', year: 2002 }],
        total: 1,
      });
      prisma.externalId.findFirst.mockResolvedValue(null);
      const res = await service.rehydrateAnimeFromTvdb();
      expect(tvdb.searchShows).toHaveBeenCalledWith('Naruto', 1);
      expect(meta.ensureShowFullTvdb).toHaveBeenCalledWith(555);
      expect(res.succeeded).toBe(1);
    });

    it('skips the show when TMDB’s tvdb_id is claimed by another media row (duplicate)', async () => {
      prisma.mediaItem.findMany.mockResolvedValue([
        animeShow({ externalIds: [{ provider: ExternalProvider.TMDB, value: '11' }] }),
      ]);
      tmdb.get.mockResolvedValue({ id: 11, tvdb_id: 305089 });
      prisma.externalId.findFirst.mockResolvedValue({ mediaId: 'the-real-rezero' });
      const res = await service.rehydrateAnimeFromTvdb();
      // Never title-search past TMDB's authoritative id — would merge structures.
      expect(tvdb.searchShows).not.toHaveBeenCalled();
      expect(res.noTvdbId).toBe(1);
      expect(meta.ensureShowFullTvdb).not.toHaveBeenCalled();
    });

    it('remaps stale TMDB episode rows onto the TVDB structure after a fix', async () => {
      prisma.mediaItem.findMany.mockResolvedValue([animeShow()]);
      structureRemap.remapShow.mockResolvedValue({ stale: 52, mapped: 50, unmapped: 2 });
      const res = await service.rehydrateAnimeFromTvdb();
      expect(structureRemap.remapShow).toHaveBeenCalledWith('m1');
      expect(res.remapped).toBe(50);
    });

    it('stops the batch early on a real TVDB 429', async () => {
      prisma.mediaItem.findMany.mockResolvedValue([
        animeShow(),
        animeShow({ id: 'm2', title: 'Bleach' }),
      ]);
      meta.ensureShowFullTvdb.mockRejectedValue(
        new ProviderError('rate_limited', '429', 429, 5000),
      );
      const res = await service.rehydrateAnimeFromTvdb();
      expect(meta.ensureShowFullTvdb).toHaveBeenCalledTimes(1); // second show never attempted
      expect(res).toMatchObject({ processed: 2, succeeded: 0, failed: 0, rateLimited: 1 });
    });

    it('stops the batch early on internal throttling', async () => {
      prisma.mediaItem.findMany.mockResolvedValue([
        animeShow(),
        animeShow({ id: 'm2', title: 'Bleach' }),
      ]);
      meta.ensureShowFullTvdb.mockRejectedValue(new ProviderThrottled('tvdb', 1000));
      const res = await service.rehydrateAnimeFromTvdb();
      expect(meta.ensureShowFullTvdb).toHaveBeenCalledTimes(1);
      expect(res.rateLimited).toBe(1);
    });

    it('counts ordinary failures and continues', async () => {
      prisma.mediaItem.findMany.mockResolvedValue([
        animeShow(),
        animeShow({ id: 'm2', title: 'Bleach' }),
      ]);
      meta.ensureShowFullTvdb.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('m2');
      const res = await service.rehydrateAnimeFromTvdb();
      expect(res).toMatchObject({ processed: 2, succeeded: 1, failed: 1, rateLimited: 0 });
    });
  });

  describe('backfillBatch (hydrateOne)', () => {
    it('rehydrates animation shows from TVDB even without existing structure', async () => {
      prisma.mediaItem.findMany.mockResolvedValue([
        { ...animeShow(), genres: [{ genre: { slug: 'animation' } }] },
      ]);
      prisma.episode.count.mockResolvedValue(0); // no existing structure → would normally go TMDB
      await service.backfillBatch(10);
      expect(meta.ensureShowFullTvdb).toHaveBeenCalledWith(789);
      expect(meta.ensureShowFull).not.toHaveBeenCalled();
    });

    it('still hydrates non-animation stubs from TMDB', async () => {
      prisma.mediaItem.findMany.mockResolvedValue([
        {
          id: 'm9',
          title: 'House',
          type: 'SHOW',
          externalIds: [{ provider: ExternalProvider.TMDB, value: '11' }],
          genres: [{ genre: { slug: 'drama' } }],
        },
      ]);
      prisma.episode.count.mockResolvedValue(0);
      await service.backfillBatch(10);
      expect(meta.ensureShowFull).toHaveBeenCalledWith(11);
      expect(meta.ensureShowFullTvdb).not.toHaveBeenCalled();
    });
  });

  describe('syncTmdbChanges', () => {
    it('skips animation-genre shows (TVDB-authoritative)', async () => {
      tmdb.get.mockImplementation((path: string) =>
        Promise.resolve(
          path === '/tv/changes'
            ? { results: [{ id: 42 }], total_pages: 1 }
            : { results: [], total_pages: 1 },
        ),
      );
      prisma.externalId.findMany.mockResolvedValue([
        { mediaId: 'm1', value: '42', media: { type: 'SHOW', externalIds: [] } },
        { mediaId: 'm2', value: '42', media: { type: 'SHOW', externalIds: [] } },
      ]);
      prisma.mediaItem.findMany.mockResolvedValue([{ id: 'm1' }]); // animation set
      const res = await service.syncTmdbChanges();
      expect(meta.ensureShowFull).toHaveBeenCalledTimes(1); // only the non-animation show
      expect(res).toMatchObject({ matched: 2, hydrated: 1, skippedAnime: 1 });
    });
  });
});
