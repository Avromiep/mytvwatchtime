import { UsersService } from './users.service';
import { anonymizeAndDeleteUser } from './lib/deleted-user';

jest.mock('./lib/deleted-user', () => ({
  anonymizeAndDeleteUser: jest.fn(async () => undefined),
  AccountDeletionInProgressError: class AccountDeletionInProgressError extends Error {},
  RESERVED_USERNAMES: new Set(['deleted-user']),
}));

describe('UsersService Apple deletion revocation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (anonymizeAndDeleteUser as jest.Mock).mockResolvedValue(undefined);
  });

  it('revokes Apple authorization before deleting the account', async () => {
    const calls: string[] = [];
    const prisma: any = {
      user: {
        findUnique: jest.fn(async () => ({
          email: 'person@example.com',
          username: 'person',
        })),
      },
      userAuthProvider: {
        findMany: jest.fn(async () => [
          { id: 'provider-1', refreshToken: 'encrypted-refresh-token' },
        ]),
      },
    };
    const redis: any = { del: jest.fn(async () => undefined) };
    const apple: any = {
      revokeEncryptedRefreshToken: jest.fn(async (token: string) => {
        calls.push(token);
      }),
    };
    const exports = { deleteForUser: jest.fn().mockResolvedValue(0) } as any;
    const service = new UsersService(prisma, redis, apple, exports);

    await service.deleteMe('user-1');

    expect(apple.revokeEncryptedRefreshToken).toHaveBeenCalledWith(
      'encrypted-refresh-token',
      'provider-1',
    );
    expect(calls).toEqual(['encrypted-refresh-token']);
    expect(redis.del).toHaveBeenCalledWith('auth:user:user-1');
    expect(anonymizeAndDeleteUser).toHaveBeenCalledWith(prisma, 'user-1');
    expect(exports.deleteForUser).toHaveBeenCalledWith('user-1');
  });

  it('does not report an already-committed account deletion as failed when export cleanup defers', async () => {
    const prisma: any = {
      user: {
        findUnique: jest.fn(async () => ({
          email: 'person@example.com',
          username: 'person',
        })),
      },
      userAuthProvider: { findMany: jest.fn(async () => []) },
    };
    const redis: any = { del: jest.fn(async () => undefined) };
    const apple: any = { revokeEncryptedRefreshToken: jest.fn() };
    const exports = { deleteForUser: jest.fn().mockRejectedValue(new Error('disk unavailable')) };
    const service = new UsersService(prisma, redis, apple, exports as any);

    await expect(service.deleteMe('user-1')).resolves.toEqual({ ok: true });
  });

  it('captures the original address and emails only after deletion commits', async () => {
    const order: string[] = [];
    const prisma: any = {
      user: {
        findUnique: jest.fn(async () => ({
          email: 'person@example.com',
          username: '<Person>',
        })),
      },
      userAuthProvider: { findMany: jest.fn(async () => []) },
    };
    const redis: any = { del: jest.fn(async () => undefined) };
    const apple: any = { revokeEncryptedRefreshToken: jest.fn() };
    const exports = { deleteForUser: jest.fn().mockResolvedValue(0) } as any;
    const email = {
      send: jest.fn(async () => {
        order.push('email');
      }),
    } as any;
    (anonymizeAndDeleteUser as jest.Mock).mockImplementationOnce(async () => {
      order.push('deleted');
      return { ghostUserId: 'ghost' };
    });
    const service = new UsersService(prisma, redis, apple, exports, email);

    await service.deleteMe('user-1');

    expect(order).toEqual(['deleted', 'email']);
    expect(email.send).toHaveBeenCalledWith(
      'person@example.com',
      'Your TV Watch Time Account Has Been Deleted',
      expect.stringContaining('&lt;Person&gt;'),
    );
  });

  it('does not send a completion email when deletion rolls back', async () => {
    const prisma: any = {
      user: {
        findUnique: jest.fn(async () => ({
          email: 'person@example.com',
          username: 'person',
        })),
      },
      userAuthProvider: { findMany: jest.fn(async () => []) },
    };
    const redis: any = { del: jest.fn(async () => undefined) };
    const apple: any = { revokeEncryptedRefreshToken: jest.fn() };
    const exports = { deleteForUser: jest.fn().mockResolvedValue(0) } as any;
    const email = { send: jest.fn() } as any;
    (anonymizeAndDeleteUser as jest.Mock).mockRejectedValueOnce(new Error('rolled back'));
    const service = new UsersService(prisma, redis, apple, exports, email);

    await expect(service.deleteMe('user-1')).rejects.toThrow('rolled back');
    expect(email.send).not.toHaveBeenCalled();
  });

  it('does not report a committed deletion as failed when confirmation email delivery fails', async () => {
    const prisma: any = {
      user: {
        findUnique: jest.fn(async () => ({
          email: 'person@example.com',
          username: 'person',
        })),
      },
      userAuthProvider: { findMany: jest.fn(async () => []) },
    };
    const redis: any = { del: jest.fn(async () => undefined) };
    const apple: any = { revokeEncryptedRefreshToken: jest.fn() };
    const exports = { deleteForUser: jest.fn().mockResolvedValue(0) } as any;
    const email = { send: jest.fn().mockRejectedValue(new Error('smtp unavailable')) } as any;
    (anonymizeAndDeleteUser as jest.Mock).mockResolvedValueOnce({ ghostUserId: 'ghost' });
    const service = new UsersService(prisma, redis, apple, exports, email);

    await expect(service.deleteMe('user-1')).resolves.toEqual({ ok: true });
    expect(email.send).toHaveBeenCalledTimes(1);
  });
});
