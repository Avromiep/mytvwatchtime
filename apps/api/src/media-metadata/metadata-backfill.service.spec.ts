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
  const p = {
    mediaItem: model(['count', 'findMany', 'findUnique', 'groupBy', 'update']),
    episode: model(['count']),
    externalId: model(['findMany', 'findFirst', 'create', 'deleteMany']),
    show: model(['delete']),
    movie: model(['delete']),
    userEpisodeStatus: model(['count']),
    userMovieStatus: model(['deleteMany']),
    watchHistory: model(['deleteMany']),
    rating: model(['count']),
    reaction: model(['count']),
    characterVote: model(['count']),
    $queryRaw: jest.fn().mockResolvedValue([{ c: BigInt(0) }]),
    $transaction: jest.fn(async (arg: any) => (Array.isArray(arg) ? Promise.all(arg) : arg(p))),
  } as any;
  p.userEpisodeStatus.count.mockResolvedValue(0);
  p.rating.count.mockResolvedValue(0);
  p.reaction.count.mockResolvedValue(0);
  p.characterVote.count.mockResolvedValue(0);
  p.userMovieStatus.deleteMany.mockResolvedValue({ count: 0 });
  p.watchHistory.deleteMany.mockResolvedValue({ count: 0 });
  return p;
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
  let tmdbProvider: any;
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
    tmdbProvider = { getTvdbIdForShow: jest.fn().mockResolvedValue(null) };
    structureRemap = {
      remapShow: jest.fn().mockResolvedValue({ stale: 0, mapped: 0, unmapped: 0 }),
    };
    service = new MetadataBackfillService(
      prisma,
      meta,
      {} as any,
      redis,
      tmdb,
      tvdb,
      tmdbProvider,
      structureRemap,
    );
  });

  describe('rehydrateAnimeFromTvdb', () => {
    /** Candidates for the batch: findMany (selection) + findUnique (fix reload) + ≥1 stale row. */
    const mockCandidates = (list: any[]) => {
      prisma.mediaItem.findMany.mockResolvedValue(list);
      prisma.mediaItem.findUnique.mockImplementation(({ where: { id } }: any) =>
        Promise.resolve(list.find((c) => c.id === id) ?? null),
      );
      prisma.episode.count.mockResolvedValue(1); // ≥1 stale TMDB-only episode row
    };

    it('does nothing when TVDB is not configured', async () => {
      tvdb.enabled = false;
      const res = await service.rehydrateAnimeFromTvdb();
      expect(res.processed).toBe(0);
      expect(prisma.mediaItem.findMany).not.toHaveBeenCalled();
    });

    it('rehydrates TMDB-structured animation shows from their stored TVDB id', async () => {
      mockCandidates([animeShow()]);
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
      mockCandidates([
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
      mockCandidates([
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
      mockCandidates([
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
      mockCandidates([
        animeShow({ externalIds: [{ provider: ExternalProvider.TMDB, value: '65942' }] }),
      ]);
      tmdbProvider.getTvdbIdForShow.mockResolvedValue(305089);
      prisma.externalId.findFirst.mockResolvedValue(null);
      const res = await service.rehydrateAnimeFromTvdb();
      expect(tmdbProvider.getTvdbIdForShow).toHaveBeenCalledWith(65942);
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
      mockCandidates([
        animeShow({ externalIds: [{ provider: ExternalProvider.TMDB, value: '11' }] }),
      ]);
      tmdbProvider.getTvdbIdForShow.mockResolvedValue(null);
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
      mockCandidates([
        animeShow({ externalIds: [{ provider: ExternalProvider.TMDB, value: '11' }] }),
      ]);
      tmdbProvider.getTvdbIdForShow.mockResolvedValue(305089);
      prisma.externalId.findFirst.mockResolvedValue({ mediaId: 'the-real-rezero' });
      const res = await service.rehydrateAnimeFromTvdb();
      // Never title-search past TMDB's authoritative id — would merge structures.
      expect(tvdb.searchShows).not.toHaveBeenCalled();
      expect(res.noTvdbId).toBe(1);
      expect(meta.ensureShowFullTvdb).not.toHaveBeenCalled();
    });

    it('remaps stale TMDB episode rows onto the TVDB structure after a fix', async () => {
      mockCandidates([animeShow()]);
      structureRemap.remapShow.mockResolvedValue({ stale: 52, mapped: 50, unmapped: 2 });
      const res = await service.rehydrateAnimeFromTvdb();
      expect(structureRemap.remapShow).toHaveBeenCalledWith('m1');
      expect(res.remapped).toBe(50);
    });

    it('short-circuits without provider calls when no stale rows remain', async () => {
      mockCandidates([animeShow()]);
      prisma.episode.count.mockResolvedValue(0); // already fully TVDB-structured
      const res = await service.rehydrateAnimeFromTvdb();
      expect(tmdbProvider.getTvdbIdForShow).not.toHaveBeenCalled();
      expect(tvdb.searchShows).not.toHaveBeenCalled();
      expect(meta.ensureShowFullTvdb).not.toHaveBeenCalled();
      expect(res.succeeded).toBe(0);
      expect(res.noTvdbId).toBe(1); // counted as not-fixed
    });

    it('stops the batch early on a real TVDB 429', async () => {
      mockCandidates([animeShow(), animeShow({ id: 'm2', title: 'Bleach' })]);
      meta.ensureShowFullTvdb.mockRejectedValue(
        new ProviderError('rate_limited', '429', 429, 5000),
      );
      const res = await service.rehydrateAnimeFromTvdb();
      expect(meta.ensureShowFullTvdb).toHaveBeenCalledTimes(1); // second show never attempted
      expect(res).toMatchObject({ processed: 2, succeeded: 0, failed: 0, rateLimited: 1 });
    });

    it('stops the batch early on internal throttling', async () => {
      mockCandidates([animeShow(), animeShow({ id: 'm2', title: 'Bleach' })]);
      meta.ensureShowFullTvdb.mockRejectedValue(new ProviderThrottled('tvdb', 1000));
      const res = await service.rehydrateAnimeFromTvdb();
      expect(meta.ensureShowFullTvdb).toHaveBeenCalledTimes(1);
      expect(res.rateLimited).toBe(1);
    });

    it('counts ordinary failures and continues', async () => {
      mockCandidates([animeShow(), animeShow({ id: 'm2', title: 'Bleach' })]);
      meta.ensureShowFullTvdb.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('m2');
      const res = await service.rehydrateAnimeFromTvdb();
      expect(res).toMatchObject({ processed: 2, succeeded: 1, failed: 1, rateLimited: 0 });
    });
  });

  describe('fixAnimeShowFromTvdb', () => {
    it('forces TVDB hydration and remaps when stale rows exist', async () => {
      prisma.mediaItem.findUnique.mockResolvedValue(animeShow());
      prisma.episode.count.mockResolvedValue(52);
      structureRemap.remapShow.mockResolvedValue({ stale: 52, mapped: 50, unmapped: 2 });
      const res = await service.fixAnimeShowFromTvdb('m1');
      // Stale gate bypassed so ensureShowFullTvdb cannot skip a recently-refreshed show.
      expect(prisma.mediaItem.update).toHaveBeenCalledWith({
        where: { id: 'm1' },
        data: { metadataRefreshedAt: null },
      });
      expect(meta.ensureShowFullTvdb).toHaveBeenCalledWith(789);
      expect(structureRemap.remapShow).toHaveBeenCalledWith('m1');
      // Kept-unmapped count persisted so kept rows alone never re-arm the repair.
      expect(prisma.mediaItem.update).toHaveBeenCalledWith({
        where: { id: 'm1' },
        data: { metadataProvenance: { animeTvdbKeptUnmapped: 2 } },
      });
      expect(res).toEqual({ fixed: true, remapped: 50 });
    });

    it('returns fixed=false when the TVDB id cannot be resolved', async () => {
      prisma.mediaItem.findUnique.mockResolvedValue(
        animeShow({ externalIds: [{ provider: ExternalProvider.TMDB, value: '11' }] }),
      );
      prisma.episode.count.mockResolvedValue(1);
      tvdb.searchShows.mockResolvedValue({ items: [], total: 0 });
      const res = await service.fixAnimeShowFromTvdb('m1');
      expect(res.fixed).toBe(false);
      expect(meta.ensureShowFullTvdb).not.toHaveBeenCalled();
      expect(structureRemap.remapShow).not.toHaveBeenCalled();
    });

    it('skips when only previously-kept unmapped rows remain (no re-hydration loop)', async () => {
      prisma.mediaItem.findUnique.mockResolvedValue(
        animeShow({ metadataProvenance: { animeTvdbKeptUnmapped: 27 } }),
      );
      prisma.episode.count.mockResolvedValue(27); // == kept count → nothing new
      const res = await service.fixAnimeShowFromTvdb('m1');
      expect(res.fixed).toBe(false);
      expect(meta.ensureShowFullTvdb).not.toHaveBeenCalled();
      expect(tvdb.searchShows).not.toHaveBeenCalled();
    });

    it('re-arms the repair when new stale rows appear (count grew past kept count)', async () => {
      prisma.mediaItem.findUnique.mockResolvedValue(
        animeShow({ metadataProvenance: { animeTvdbKeptUnmapped: 27 } }),
      );
      prisma.episode.count.mockResolvedValue(28); // new contamination
      const res = await service.fixAnimeShowFromTvdb('m1');
      expect(meta.ensureShowFullTvdb).toHaveBeenCalledWith(789);
      expect(res.fixed).toBe(true);
    });

    it('coalesces concurrent repairs for the same show (detail + episodes race)', async () => {
      prisma.mediaItem.findUnique.mockResolvedValue(animeShow());
      prisma.episode.count.mockResolvedValue(52);
      let release!: (v: string) => void;
      meta.ensureShowFullTvdb.mockImplementation(
        () =>
          new Promise<string>((r) => {
            release = r;
          }),
      );
      const p1 = service.fixAnimeShowFromTvdb('m1');
      const p2 = service.fixAnimeShowFromTvdb('m1');
      // Let the shared repair reach the (pending) TVDB hydration before releasing it.
      await new Promise((r) => setImmediate(r));
      release('m1');
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(meta.ensureShowFullTvdb).toHaveBeenCalledTimes(1); // one shared repair
      expect(r1.fixed).toBe(true);
      expect(r2.fixed).toBe(true);
      // After completion the next call is free to repair again if needed.
      prisma.episode.count.mockResolvedValue(0);
      const r3 = await service.fixAnimeShowFromTvdb('m1');
      expect(r3.fixed).toBe(false);
    });
  });

  describe('backfillBatch (hydrateOne)', () => {
    it('rehydrates animation shows from TVDB even without existing structure', async () => {
      prisma.mediaItem.findMany.mockResolvedValue([
        { ...animeShow(), genres: [{ genre: { slug: 'animation', name: 'Animation' } }] },
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
          genres: [{ genre: { slug: 'drama', name: 'Drama' } }],
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

    it('uses the custom start date for one-off runs without moving the Redis cursor', async () => {
      const calls: any[] = [];
      tmdb.get.mockImplementation((path: string, params: any) => {
        calls.push({ path, params });
        return Promise.resolve({ results: [], total_pages: 1 });
      });
      redis.get.mockResolvedValue('2026-07-18T00:00:00.000Z'); // stored cursor (ignored for custom)

      await service.syncTmdbChanges('2026-07-01');

      const tvCall = calls.find((c) => c.path === '/tv/changes');
      expect(tvCall.params).toMatchObject({ start_date: '2026-07-01' });
      // The daily progression is never disturbed by one-off backfills.
      expect(redis.set).not.toHaveBeenCalledWith(
        'TMDB_CHANGES_LAST_RUN',
        expect.anything(),
        expect.anything(),
      );
    });

    it('stores the cursor for normal (non-custom) runs', async () => {
      tmdb.get.mockResolvedValue({ results: [], total_pages: 1 });
      await service.syncTmdbChanges();
      expect(redis.set).toHaveBeenCalledWith(
        'TMDB_CHANGES_LAST_RUN',
        expect.any(String),
        86400 * 30,
      );
    });
  });

  describe('backfillCharacterIds', () => {
    it('rehydrates shows whose cast lacks characterExternalId (one TVDB call per show)', async () => {
      prisma.mediaItem.findMany.mockResolvedValue([
        { id: 'm1', title: 'The Office', externalIds: [{ value: '73255' }] },
        { id: 'm2', title: 'Broadchurch', externalIds: [{ value: '73996' }] },
      ]);
      const res = await service.backfillCharacterIds();
      expect(prisma.mediaItem.update).toHaveBeenCalledWith({
        where: { id: 'm1' },
        data: { metadataRefreshedAt: null },
      });
      expect(meta.ensureShowFullTvdb).toHaveBeenCalledTimes(2);
      expect(meta.ensureShowFullTvdb).toHaveBeenCalledWith(73255);
      expect(meta.ensureShowFullTvdb).toHaveBeenCalledWith(73996);
      expect(res).toMatchObject({ processed: 2, succeeded: 2, failed: 0, rateLimited: 0 });
    });

    it('stops early on TVDB rate limits', async () => {
      prisma.mediaItem.findMany.mockResolvedValue([
        { id: 'm1', title: 'The Office', externalIds: [{ value: '73255' }] },
        { id: 'm2', title: 'Broadchurch', externalIds: [{ value: '73996' }] },
      ]);
      meta.ensureShowFullTvdb.mockRejectedValue(new ProviderThrottled('tvdb', 1000));
      const res = await service.backfillCharacterIds();
      expect(meta.ensureShowFullTvdb).toHaveBeenCalledTimes(1);
      expect(res.rateLimited).toBe(1);
    });

    it('does nothing when TVDB is not configured', async () => {
      tvdb.enabled = false;
      const res = await service.backfillCharacterIds();
      expect(res.processed).toBe(0);
      expect(prisma.mediaItem.findMany).not.toHaveBeenCalled();
    });
  });

  describe('repairTypeMismatches', () => {
    it('purges movie statuses/history on show rows before structural repairs', async () => {
      prisma.mediaItem.findMany.mockResolvedValue([]);
      prisma.userMovieStatus.deleteMany.mockResolvedValue({ count: 536 });
      prisma.watchHistory.deleteMany.mockResolvedValue({ count: 536 });

      const res = await service.repairTypeMismatches();

      expect(prisma.userMovieStatus.deleteMany).toHaveBeenCalledWith({
        where: { media: { type: 'SHOW' } },
      });
      expect(prisma.watchHistory.deleteMany).toHaveBeenCalledWith({
        where: { mediaType: 'MOVIE', media: { type: 'SHOW' } },
      });
      expect(res).toMatchObject({ processed: 0, repaired: 0, failed: 0 });
    });

    const mismatchRow = (over: Record<string, unknown> = {}) => ({
      id: 'movie-1',
      type: 'MOVIE',
      title: 'Sonic Boom',
      externalIds: [
        { provider: ExternalProvider.TMDB, providerEntityKind: 'MOVIE', value: '62211' },
        { provider: ExternalProvider.IMDB, providerEntityKind: 'MOVIE', value: 'tt3232262' },
        { provider: ExternalProvider.THE_TVDB, providerEntityKind: 'SERIES', value: '280103' },
      ],
      ...over,
    });

    it('splits a contaminated movie row: recreate show, remap, restore the movie', async () => {
      prisma.mediaItem.findMany.mockResolvedValue([mismatchRow()]);
      prisma.externalId.deleteMany.mockResolvedValue({ count: 1 });
      meta.ensureShowFullTvdb.mockResolvedValue('show-new');
      structureRemap.remapEpisodesToMedia = jest
        .fn()
        .mockResolvedValue({ mapped: 52, unmapped: 0 });

      const res = await service.repairTypeMismatches();

      // Stray-kind id detached globally → correct show created from TVDB → watch data remapped.
      expect(prisma.externalId.deleteMany).toHaveBeenCalledWith({
        where: {
          provider: ExternalProvider.THE_TVDB,
          providerEntityKind: 'SERIES',
          value: '280103',
        },
      });
      expect(meta.ensureShowFullTvdb).toHaveBeenCalledWith(280103);
      expect(structureRemap.remapEpisodesToMedia).toHaveBeenCalledWith('movie-1', 'show-new');
      // Stray structure removed and the movie rehydrated from its own provider.
      expect(prisma.show.delete).toHaveBeenCalledWith({ where: { mediaId: 'movie-1' } });
      expect(prisma.mediaItem.update).toHaveBeenCalledWith({
        where: { id: 'movie-1' },
        data: { metadataRefreshedAt: null },
      });
      expect(meta.ensureMovieFull).toHaveBeenCalledWith(62211);
      expect(res).toMatchObject({ processed: 1, repaired: 1, skipped: 0, failed: 0 });
    });

    it('skips the split when unmapped user data would be stranded', async () => {
      prisma.mediaItem.findMany.mockResolvedValue([mismatchRow()]);
      prisma.externalId.deleteMany.mockResolvedValue({ count: 1 });
      meta.ensureShowFullTvdb.mockResolvedValue('show-new');
      structureRemap.remapEpisodesToMedia = jest
        .fn()
        .mockResolvedValue({ mapped: 50, unmapped: 2 });

      const res = await service.repairTypeMismatches();

      expect(res.skipped).toBe(1);
      expect(prisma.show.delete).not.toHaveBeenCalled(); // stray row holds user data
      expect(meta.ensureMovieFull).not.toHaveBeenCalled();
    });

    it('never deletes the stray structure when the new entity came back empty (partial fetch)', async () => {
      prisma.mediaItem.findMany.mockResolvedValue([mismatchRow()]);
      prisma.externalId.deleteMany.mockResolvedValue({ count: 1 });
      meta.ensureShowFullTvdb.mockResolvedValue('show-new');
      // Remap early-exits (target has 0 episodes): mapped=0 AND unmapped=0 — the explicit
      // remaining-user-data check is the only thing standing between us and data loss.
      structureRemap.remapEpisodesToMedia = jest.fn().mockResolvedValue({ mapped: 0, unmapped: 0 });
      prisma.userEpisodeStatus.count.mockResolvedValue(1);

      const res = await service.repairTypeMismatches();

      expect(res.skipped).toBe(1);
      expect(prisma.show.delete).not.toHaveBeenCalled();
      expect(meta.ensureMovieFull).not.toHaveBeenCalled();
    });

    it('drops the stray structure when there is no cross-type id and no user data', async () => {
      prisma.mediaItem.findMany.mockResolvedValue([
        mismatchRow({
          externalIds: [
            { provider: ExternalProvider.TMDB, providerEntityKind: 'MOVIE', value: '62211' },
          ],
        }),
      ]);
      prisma.userEpisodeStatus.count.mockResolvedValue(0);

      const res = await service.repairTypeMismatches();

      expect(prisma.show.delete).toHaveBeenCalledWith({ where: { mediaId: 'movie-1' } });
      expect(meta.ensureShowFullTvdb).not.toHaveBeenCalled();
      expect(res.repaired).toBe(1);
    });

    it('keeps the row when user data exists but no cross-type id can be resolved', async () => {
      prisma.mediaItem.findMany.mockResolvedValue([
        mismatchRow({
          externalIds: [
            { provider: ExternalProvider.TMDB, providerEntityKind: 'MOVIE', value: '62211' },
          ],
        }),
      ]);
      prisma.userEpisodeStatus.count.mockResolvedValue(3);

      const res = await service.repairTypeMismatches();

      expect(res.skipped).toBe(1);
      expect(prisma.show.delete).not.toHaveBeenCalled();
    });
  });
});
