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
    const service = new UsersService(prisma, redis, apple);

    await service.deleteMe('user-1');

    expect(apple.revokeEncryptedRefreshToken).toHaveBeenCalledWith(
      'encrypted-refresh-token',
      'provider-1',
    );
    expect(calls).toEqual(['encrypted-refresh-token']);
    expect(redis.del).toHaveBeenCalledWith('auth:user:user-1');
    expect(anonymizeAndDeleteUser).toHaveBeenCalledWith(prisma, 'user-1');
  });
});
