import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AuthProvider, Prisma } from '@prisma/client';
import { AuthErrorCode } from '@tvwatch/shared';
import { AuthService } from './auth.service';

function p2002() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: {},
  });
}

function makePrisma(opts: { delayCreate?: boolean } = {}) {
  let nextUserId = 1;
  let nextProviderId = 1;
  const users = new Map<string, any>();
  const providers = new Map<string, any>();
  const providerKey = (provider: AuthProvider, providerUid: string) => `${provider}:${providerUid}`;

  const prisma: any = {
    users,
    providers,
    user: {
      findUnique: jest.fn(async (args: any) => {
        const where = args.where || {};
        const user = where.id
          ? users.get(where.id)
          : [...users.values()].find(
              (u) => u.email === where.email || u.username === where.username,
            );
        return user ? cloneUser(user) : null;
      }),
      findFirst: jest.fn(async (args: any) => {
        const or = args.where?.OR || [];
        const user = [...users.values()].find((u) =>
          or.some((entry: any) => entry.email === u.email || entry.username === u.username),
        );
        return user ? cloneUser(user) : null;
      }),
      create: jest.fn(async (args: any) => {
        if (opts.delayCreate) await new Promise((resolve) => setImmediate(resolve));
        const data = args.data;
        if (
          [...users.values()].some((u) => u.email === data.email || u.username === data.username)
        ) {
          throw p2002();
        }
        const providerData = data.authProviders?.create;
        if (
          providerData &&
          providers.has(providerKey(providerData.provider, providerData.providerUid))
        ) {
          throw p2002();
        }
        const user = {
          id: data.id || `u${nextUserId++}`,
          email: data.email,
          username: data.username,
          passwordHash: data.passwordHash ?? null,
          role: data.role ?? 'USER',
          isSuspended: data.isSuspended ?? false,
          isShadow: false,
          emailVerified: data.emailVerified ?? false,
          mustChangePassword: data.mustChangePassword ?? false,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          profile: { displayName: data.profile?.create?.displayName ?? null },
          authProviders: [] as any[],
        };
        users.set(user.id, user);
        if (providerData) {
          const provider = {
            id: `ap${nextProviderId++}`,
            userId: user.id,
            provider: providerData.provider,
            providerUid: providerData.providerUid,
            refreshToken: providerData.refreshToken ?? null,
            user,
          };
          providers.set(providerKey(provider.provider, provider.providerUid), provider);
          user.authProviders.push(provider);
        }
        return cloneUser(user);
      }),
    },
    userAuthProvider: {
      findUnique: jest.fn(async (args: any) => {
        const key = args.where.provider_providerUid;
        const provider = providers.get(providerKey(key.provider, key.providerUid));
        return provider ? cloneProvider(provider, args.include?.user) : null;
      }),
      update: jest.fn(async (args: any) => {
        const provider = [...providers.values()].find((p) => p.id === args.where.id);
        if (!provider) throw new Error('provider not found');
        Object.assign(provider, args.data);
        return cloneProvider(provider, false);
      }),
    },
    follow: { count: jest.fn(async () => 0) },
    comment: { count: jest.fn(async () => 0) },
    $transaction: jest.fn(async (cb: (tx: any) => Promise<unknown>) => cb(prisma)),
  };

  function cloneUser(user: any) {
    return {
      ...user,
      profile: user.profile ? { ...user.profile } : null,
      authProviders: user.authProviders.map((p: any) => ({ ...p, user: undefined })),
    };
  }

  function cloneProvider(provider: any, includeUser: boolean) {
    return { ...provider, user: includeUser ? cloneUser(provider.user) : undefined };
  }

  return prisma;
}

function makeService(prisma = makePrisma()) {
  const apple = {
    verifyNativeCredential: jest.fn(),
    encryptProviderToken: jest.fn((token: string) => `encrypted:${token}`),
    createNonce: jest.fn(),
  };
  const config = new ConfigService({
    jwt: { secret: 'test-secret-minimum-16-chars', accessTtl: '15m', refreshTtl: '30d' },
    auth: { google: { clientId: 'google-client' } },
  });
  const service = new AuthService(prisma, new JwtService(), config, {} as any, apple as any);
  return { service, prisma, apple };
}

const dto = {
  identityToken: 'identity-token',
  authorizationCode: 'authorization-code',
  nonce: 'nonce',
  state: 'state',
};

describe('AuthService Apple authentication', () => {
  it('creates a new account from a valid Apple identity', async () => {
    const { service, prisma, apple } = makeService();
    apple.verifyNativeCredential.mockResolvedValueOnce({
      profile: {
        providerUid: 'apple-sub',
        email: 'ada@example.com',
        emailVerified: true,
        name: 'Ada Lovelace',
      },
      refreshToken: 'apple-refresh',
    });

    const session = await service.appleLogin(dto as any);

    expect(session.user.email).toBe('ada@example.com');
    expect(session.user.displayName).toBe('Ada Lovelace');
    expect(session.user.authProviders).toEqual([AuthProvider.APPLE]);
    expect([...prisma.providers.values()][0].refreshToken).toBe('encrypted:apple-refresh');
  });

  it('repeat login returns the same user and does not overwrite the first-use name with null', async () => {
    const { service, prisma, apple } = makeService();
    apple.verifyNativeCredential.mockResolvedValueOnce({
      profile: {
        providerUid: 'apple-sub',
        email: 'ada@example.com',
        emailVerified: true,
        name: 'Ada Lovelace',
      },
    });
    const first = await service.appleLogin(dto as any);

    apple.verifyNativeCredential.mockResolvedValueOnce({
      profile: { providerUid: 'apple-sub', emailVerified: false },
    });
    const second = await service.appleLogin(dto as any);

    expect(second.user.id).toBe(first.user.id);
    expect(second.user.displayName).toBe('Ada Lovelace');
    expect(prisma.users.size).toBe(1);
  });

  it('repeat login works when Apple no longer returns a direct credential email', async () => {
    const { service, prisma, apple } = makeService();
    apple.verifyNativeCredential.mockResolvedValueOnce({
      profile: {
        providerUid: 'apple-sub',
        email: 'ada@example.com',
        emailVerified: true,
        name: 'Ada Lovelace',
      },
    });
    await service.appleLogin(dto as any);

    apple.verifyNativeCredential.mockResolvedValueOnce({
      profile: { providerUid: 'apple-sub' },
    });
    const session = await service.appleLogin(dto as any);

    expect(session.user.email).toBe('ada@example.com');
    expect(prisma.users.size).toBe(1);
  });

  it('accepts a verified Hide My Email relay address for a new Apple account', async () => {
    const { service, apple } = makeService();
    apple.verifyNativeCredential.mockResolvedValueOnce({
      profile: {
        providerUid: 'relay-sub',
        email: 'abc123@privaterelay.appleid.com',
        emailVerified: true,
      },
    });

    const session = await service.appleLogin(dto as any);

    expect(session.user.email).toBe('abc123@privaterelay.appleid.com');
  });

  it('does not silently merge when a verified Apple email belongs to another provider', async () => {
    const { service, prisma, apple } = makeService();
    await prisma.user.create({
      data: {
        email: 'ada@example.com',
        username: 'ada',
        emailVerified: true,
        authProviders: { create: { provider: AuthProvider.GOOGLE, providerUid: 'google-sub' } },
        profile: { create: { displayName: 'Ada' } },
      },
    });
    apple.verifyNativeCredential.mockResolvedValueOnce({
      profile: { providerUid: 'apple-sub', email: 'ada@example.com', emailVerified: true },
    });

    await expect(service.appleLogin(dto as any)).rejects.toMatchObject({
      response: { code: AuthErrorCode.ACCOUNT_EXISTS_WITH_DIFFERENT_PROVIDER },
    });
  });

  it('does not create duplicate users for duplicate concurrent Apple requests', async () => {
    const prisma = makePrisma({ delayCreate: true });
    const { service, apple } = makeService(prisma);
    apple.verifyNativeCredential.mockResolvedValue({
      profile: {
        providerUid: 'apple-sub',
        email: 'ada@example.com',
        emailVerified: true,
        name: 'Ada',
      },
    });

    const [one, two] = await Promise.all([
      service.appleLogin(dto as any),
      service.appleLogin(dto as any),
    ]);

    expect(two.user.id).toBe(one.user.id);
    expect(prisma.users.size).toBe(1);
    expect(prisma.providers.size).toBe(1);
  });

  it('disabled Apple-linked users cannot authenticate', async () => {
    const { service, prisma, apple } = makeService();
    const seeded = await prisma.user.create({
      data: {
        email: 'ada@example.com',
        username: 'ada',
        isSuspended: true,
        emailVerified: true,
        authProviders: { create: { provider: AuthProvider.APPLE, providerUid: 'apple-sub' } },
        profile: { create: { displayName: 'Ada' } },
      },
    });
    expect(seeded.id).toBeTruthy();
    apple.verifyNativeCredential.mockResolvedValueOnce({ profile: { providerUid: 'apple-sub' } });

    await expect(service.appleLogin(dto as any)).rejects.toMatchObject({
      response: { code: AuthErrorCode.ACCOUNT_DISABLED },
    });
  });
});
