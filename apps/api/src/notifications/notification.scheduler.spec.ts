import { NotificationScheduler } from './notification.scheduler';

function createScheduler(prisma: any) {
  const notifications = { createForUser: jest.fn().mockResolvedValue(undefined) };
  const meta = { ensureAirtimes: jest.fn().mockResolvedValue(undefined) };
  const config = { get: jest.fn() };
  const settings = { getNumber: jest.fn().mockResolvedValue(30) };
  return new NotificationScheduler(
    prisma,
    notifications as any,
    meta as any,
    config as any,
    settings as any,
  );
}

describe('NotificationScheduler', () => {
  it('excludes dropped shows from episode notification tracking users', async () => {
    const prisma = {
      userShowStatus: {
        findMany: jest.fn().mockResolvedValue([
          { userId: 'active-user', lastWatchedAt: new Date('2026-07-01'), watchedCount: 2 },
        ]),
      },
      watchlistItem: { findMany: jest.fn().mockResolvedValue([]) },
      $queryRaw: jest.fn().mockResolvedValue([
        { userId: 'active-user', cnt: 2, lastAt: new Date('2026-07-01') },
        { userId: 'dropped-user', cnt: 5, lastAt: new Date('2026-06-01') },
      ]),
    };

    const scheduler = createScheduler(prisma);
    await (scheduler as any).trackingUsersWithStatus('media-1');

    expect(prisma.userShowStatus.findMany).toHaveBeenCalledWith({
      where: { mediaId: 'media-1', dropped: false },
      select: { userId: true, lastWatchedAt: true, watchedCount: true },
    });
  });

  it('excludes dropped shows from stale watchlist reminders', async () => {
    const prisma = {
      userShowStatus: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const scheduler = createScheduler(prisma);
    await scheduler.watchlistReminders();

    expect(prisma.userShowStatus.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ dropped: false, watchedCount: { gt: 0 } }),
      }),
    );
  });

  it('does not refresh airtimes for dropped-only shows', async () => {
    const prisma = {
      mediaItem: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const scheduler = createScheduler(prisma);
    await scheduler.refreshAirtimes();

    expect(prisma.mediaItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ showStatuses: { some: { dropped: false } } }, { watchlist: { some: {} } }],
        }),
      }),
    );
  });
});
