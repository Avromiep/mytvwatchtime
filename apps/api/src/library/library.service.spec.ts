import { LibraryService } from './library.service';

/** Minimal card factory — bucket rails only need a few fields for these tests. */
const card = (showId: string, bucket: string) => ({ showId, bucket, episode: { id: `ep_${showId}` } });

const makeSvc = () => {
  const prisma = {
    userShowStatus: { findMany: jest.fn() },
    watchlistItem: { findMany: jest.fn() },
    mediaItem: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn(),
  };
  const redis = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(null),
    del: jest.fn(),
    delByPattern: jest.fn(),
  };
  const meta = { ensureListLocaleOverrides: jest.fn().mockResolvedValue(undefined) };
  const svc = new LibraryService(prisma as any, redis as any, meta as any);
  return { svc, prisma, redis };
};

describe('LibraryService watchNext capped rails + bucket pagination', () => {
  it('caps NOT_RECENTLY/START_WATCHING at 10 and exposes uncapped bucketTotals', async () => {
    const { svc } = makeSvc();
    const notRecently = Array.from({ length: 23 }, (_, i) => card(`nr${i}`, 'NOT_RECENTLY'));
    const startWatching = Array.from({ length: 14 }, (_, i) => card(`sw${i}`, 'START_WATCHING'));
    jest.spyOn(svc as any, 'computeWatchNext').mockResolvedValue({
      history: [card('h1', 'HISTORY')],
      historyHasMore: false,
      watchNext: [card('wn1', 'WATCH_NEXT')],
      startWatching,
      notRecently,
    });

    const res = await svc.watchNext('u1');
    expect(res.items).toHaveLength(1 + 1 + 10 + 10);
    expect(res.bucketTotals).toEqual({ notRecently: 23, startWatching: 14 });
    // "Haven't watched for a while" ships before "Start watching" in the payload.
    const firstSw = res.items.findIndex((i) => i.bucket === 'START_WATCHING');
    const lastNr = res.items.map((i) => i.bucket).lastIndexOf('NOT_RECENTLY');
    expect(firstSw).toBeGreaterThan(lastNr);
  });

  it('watchNextBucket slices the uncapped rail with offset/hasMore/nextOffset', async () => {
    const { svc } = makeSvc();
    const notRecently = Array.from({ length: 23 }, (_, i) => card(`nr${i}`, 'NOT_RECENTLY'));
    jest.spyOn(svc as any, 'computeWatchNext').mockResolvedValue({
      history: [],
      historyHasMore: false,
      watchNext: [],
      startWatching: [],
      notRecently,
    });

    const page2 = await svc.watchNextBucket('u1', 'NOT_RECENTLY', 10, 10);
    expect(page2.items.map((i: any) => i.showId)).toEqual(notRecently.slice(10, 20).map((c) => c.showId));
    expect(page2.hasMore).toBe(true);
    expect(page2.nextOffset).toBe(20);

    const page3 = await svc.watchNextBucket('u1', 'NOT_RECENTLY', 20, 10);
    expect(page3.items).toHaveLength(3);
    expect(page3.hasMore).toBe(false);
    expect(page3.total).toBe(23);
  });
});

describe('LibraryService showsByStatus paused bucket', () => {
  const statusRow = (mediaId: string, opts: { watchedCount?: number; pausedAt?: Date | null; dropped?: boolean }) => ({
    userId: 'u1',
    mediaId,
    watchedCount: opts.watchedCount ?? 0,
    pausedAt: opts.pausedAt ?? null,
    dropped: opts.dropped ?? false,
    lastWatchedAt: null,
    media: {
      id: mediaId,
      title: `Show ${mediaId}`,
      posterUrl: null,
      backdropUrl: null,
      rating: null,
      show: { yearStart: 2020 },
    },
  });

  it('routes paused shows to their own rail and out of watching/finished/notStarted', async () => {
    const { svc, prisma, redis } = makeSvc();
    prisma.userShowStatus.findMany.mockResolvedValue([
      statusRow('watching1', { watchedCount: 3 }),
      statusRow('paused1', { watchedCount: 5, pausedAt: new Date('2026-07-01') }),
      statusRow('paused2', { watchedCount: 0, pausedAt: new Date('2026-07-02') }),
      statusRow('finished1', { watchedCount: 10 }),
    ]);
    prisma.watchlistItem.findMany.mockResolvedValue([
      // paused2 is also watchlisted — it must NOT surface in notStarted.
      { userId: 'u1', mediaId: 'paused2', createdAt: new Date(), media: statusRow('paused2', {}).media },
      { userId: 'u1', mediaId: 'fresh1', createdAt: new Date(), media: statusRow('fresh1', {}).media },
    ]);
    // AIRED episode counts: watching1 3/10, paused1 5/10, finished1 10/10.
    prisma.$queryRaw.mockResolvedValue([
      { mediaId: 'watching1', airedCount: 10 },
      { mediaId: 'paused1', airedCount: 10 },
      { mediaId: 'finished1', airedCount: 10 },
    ]);

    const res = await svc.showsByStatus('u1');
    expect(res.watching.map((i: any) => i.id)).toEqual(['watching1']);
    expect(res.finished.map((i: any) => i.id)).toEqual(['finished1']);
    expect(res.paused.map((i: any) => i.id)).toEqual(['paused2', 'paused1']); // pausedAt desc
    expect(res.notStarted.map((i: any) => i.id)).toEqual(['fresh1']);
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringContaining('showsprogress:v3:u1:'),
      expect.anything(),
      30,
    );
  });
});
