import { DiscoveryService } from './discovery.service';

/** posterLast: stable poster-last ordering for merged search result windows. */
describe('DiscoveryService.posterLast', () => {
  const make = (rows: { id: string; posterUrl: string | null }[]) => {
    const prisma = {
      mediaItem: { findMany: jest.fn().mockResolvedValue(rows) },
    };
    const svc = new DiscoveryService(
      {} as any,
      {} as any,
      {} as any,
      prisma as any,
      {} as any,
      {} as any,
    );
    return { svc, prisma };
  };

  it('pushes posterless media to the bottom, preserving order within each group', async () => {
    const { svc } = make([
      { id: 'b', posterUrl: 'p.jpg' },
      { id: 'd', posterUrl: 'p.jpg' },
    ]);
    const out = await svc.posterLast(['a', 'b', 'c', 'd', 'e']);
    expect(out).toEqual(['b', 'd', 'a', 'c', 'e']);
  });

  it('keeps everything when all have posters', async () => {
    const { svc } = make([
      { id: 'a', posterUrl: 'p.jpg' },
      { id: 'b', posterUrl: 'p.jpg' },
      { id: 'c', posterUrl: 'p.jpg' },
    ]);
    expect(await svc.posterLast(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('keeps everything when none have posters', async () => {
    const { svc } = make([]);
    expect(await svc.posterLast(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('is a no-op for an empty window', async () => {
    const { svc, prisma } = make([]);
    expect(await svc.posterLast([])).toEqual([]);
    expect(prisma.mediaItem.findMany).not.toHaveBeenCalled();
  });
});
