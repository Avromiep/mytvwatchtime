import { NotificationCategory, NotificationTiming } from '@prisma/client';
import { NotificationService } from './notification.service';

function preferenceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pref-1',
    userId: 'user-1',
    preferences: {},
    quietHoursEnabled: false,
    quietHoursStart: null,
    quietHoursEnd: null,
    timezone: null,
    timing: NotificationTiming.AT_RELEASE,
    createdAt: new Date('2026-08-03T00:00:00.000Z'),
    updatedAt: new Date('2026-08-03T00:00:00.000Z'),
    ...overrides,
  };
}

describe('NotificationService preferences', () => {
  let prisma: any;
  let service: NotificationService;

  beforeEach(() => {
    prisma = {
      notificationPreference: {
        upsert: jest.fn(),
      },
    };
    service = new NotificationService(prisma, {} as any, {} as any, {} as any);
  });

  it('atomically creates default preferences on first access', async () => {
    prisma.notificationPreference.upsert.mockImplementation(async ({ create }: any) =>
      preferenceRow({ userId: create.userId, preferences: create.preferences }),
    );

    const result = await service.getPreferences('user-1');

    expect(prisma.notificationPreference.upsert).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      create: {
        userId: 'user-1',
        preferences: expect.any(Object),
      },
      update: {},
    });
    expect(Object.keys(result.preferences).sort()).toEqual(
      Object.values(NotificationCategory).sort(),
    );
    expect(
      Object.values(result.preferences).every((preference) =>
        Boolean(preference.push && preference.inApp),
      ),
    ).toBe(true);
  });

  it('returns existing custom preferences without overwriting them', async () => {
    const custom = {
      [NotificationCategory.BADGE]: { push: false, inApp: true },
    };
    prisma.notificationPreference.upsert.mockResolvedValue(
      preferenceRow({
        preferences: custom,
        quietHoursEnabled: true,
        quietHoursStart: '22:00',
        quietHoursEnd: '07:00',
        timezone: 'America/Toronto',
      }),
    );

    const result = await service.getPreferences('user-1');

    expect(prisma.notificationPreference.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: {} }),
    );
    expect(result).toEqual({
      preferences: custom,
      quietHoursEnabled: true,
      quietHoursStart: '22:00',
      quietHoursEnd: '07:00',
      timezone: 'America/Toronto',
      timing: NotificationTiming.AT_RELEASE,
    });
  });

  it('allows concurrent first-access callers to use the same atomic path', async () => {
    prisma.notificationPreference.upsert.mockImplementation(async ({ create }: any) =>
      preferenceRow({ userId: create.userId, preferences: create.preferences }),
    );

    await expect(
      Promise.all([service.getPreferences('user-1'), service.getPreferences('user-1')]),
    ).resolves.toHaveLength(2);
    expect(prisma.notificationPreference.upsert).toHaveBeenCalledTimes(2);
  });
});
