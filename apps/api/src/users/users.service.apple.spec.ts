import { UsersService } from './users.service';
import { anonymizeAndDeleteUser } from './lib/deleted-user';

jest.mock('./lib/deleted-user', () => ({
  anonymizeAndDeleteUser: jest.fn(async () => undefined),
  RESERVED_USERNAMES: new Set(['deleted-user']),
}));

describe('UsersService Apple deletion revocation', () => {
  it('revokes Apple authorization before deleting the account', async () => {
    const calls: string[] = [];
    const prisma: any = {
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
    const prisma: any = { userAuthProvider: { findMany: jest.fn(async () => []) } };
    const redis: any = { del: jest.fn(async () => undefined) };
    const apple: any = { revokeEncryptedRefreshToken: jest.fn() };
    const exports = { deleteForUser: jest.fn().mockRejectedValue(new Error('disk unavailable')) };
    const service = new UsersService(prisma, redis, apple, exports as any);

    await expect(service.deleteMe('user-1')).resolves.toEqual({ ok: true });
  });
});
