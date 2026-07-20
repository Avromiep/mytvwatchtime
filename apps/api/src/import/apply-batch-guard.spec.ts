import { ImportService } from './import.service';

/**
 * applyBatch cross-type guard: user data must never land on a media row of the wrong
 * entity type (a mis-tagged import item or a bad external-id cross-link).
 */
describe('ImportService.applyBatch — cross-type guard', () => {
  function makeService(mediaTypes: Record<string, string>) {
    const prisma: any = {
      mediaItem: {
        findMany: jest.fn(async () =>
          Object.entries(mediaTypes).map(([id, type]) => ({ id, type })),
        ),
      },
      movie: { findMany: jest.fn().mockResolvedValue([]) },
      userMovieStatus: { findMany: jest.fn().mockResolvedValue([]) },
      customList: { findMany: jest.fn().mockResolvedValue([]) },
      import: { update: jest.fn().mockResolvedValue({}) },
      importItem: { updateMany: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    const chunked: any[] = [];
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
    (service as any).chunkedCreateMany = jest.fn(async (_tx: any, _model: string, rows: any[]) => {
      chunked.push(...rows);
    });
    return { service: service as any, chunked };
  }

  const movieItem = (mediaId: string) => ({
    id: 'it1',
    sourceEntityType: 'WATCHED_MOVIE',
    status: 'MATCHED',
    matchedMediaId: mediaId,
    matchedEpisodeId: null,
    normalizedData: { watchedAt: '2017-03-12T12:51:53.000Z', watchCount: 1 },
  });

  it('drops a WATCHED_MOVIE item whose matched media is a SHOW (no movie status written)', async () => {
    const { service, chunked } = makeService({ 'show-1': 'SHOW' });
    const res = await service.applyBatch('u1', 'imp1', [movieItem('show-1')], 'TVTIME');
    expect(res.created).toBe(0);
    expect(res.skipped).toBe(1);
    expect(chunked.find((r) => r.mediaId === 'show-1')).toBeUndefined();
  });

  it('still applies a WATCHED_MOVIE item to a real MOVIE row', async () => {
    const { service, chunked } = makeService({ 'movie-1': 'MOVIE' });
    const res = await service.applyBatch('u1', 'imp1', [movieItem('movie-1')], 'TVTIME');
    expect(res.created).toBe(1);
    expect(chunked.some((r) => r.mediaId === 'movie-1' && r.watched === true)).toBe(true);
  });
});
