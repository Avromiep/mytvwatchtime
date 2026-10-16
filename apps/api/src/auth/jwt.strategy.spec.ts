import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtStrategy, JwtPayload } from './jwt.strategy';

function makeStrategy(exists = true, passwordChangedAt: Date | null = null) {
  const config = new ConfigService({ jwt: { secret: 'test-secret-minimum-16-chars' } });
  const prisma = {
    user: {
      findUnique: jest
        .fn()
        .mockResolvedValue(exists ? { id: 'u1', passwordChangedAt } : null),
    },
  };
  const redis = { get: jest.fn().mockResolvedValue(null), set: jest.fn() };
  const strategy = new JwtStrategy(config as any, prisma as any, redis as any);
  return { strategy, prisma, redis };
}

const base: JwtPayload = {
  sub: 'u1',
  username: 'u',
  email: 'e@example.com',
  role: 'USER',
  iat: Math.floor(Date.now() / 1000),
};

describe('JwtStrategy.validate', () => {
  it('accepts an access token', async () => {
    const { strategy } = makeStrategy();
    await expect(strategy.validate({ ...base, kind: 'access' })).resolves.toMatchObject({ id: 'u1' });
  });

  it('refuses a refresh token on a protected route', async () => {
    const { strategy } = makeStrategy();
    await expect(strategy.validate({ ...base, kind: 'refresh' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('refuses a legacy (kind-less) token older than the access lifetime', async () => {
    const { strategy } = makeStrategy();
    const old: JwtPayload = { ...base, kind: undefined, iat: Math.floor(Date.now() / 1000) - 3600 };
    await expect(strategy.validate(old)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses a token issued before the last password change', async () => {
    const changedAt = new Date();
    const { strategy } = makeStrategy(true, changedAt);
    const stale: JwtPayload = {
      ...base,
      kind: 'access',
      pwc: Math.floor(changedAt.getTime() / 1000) - 10,
    };
    await expect(strategy.validate(stale)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('accepts a token issued at/after the last password change', async () => {
    const changedAt = new Date();
    const { strategy } = makeStrategy(true, changedAt);
    const fresh: JwtPayload = {
      ...base,
      kind: 'access',
      pwc: Math.floor(changedAt.getTime() / 1000),
    };
    await expect(strategy.validate(fresh)).resolves.toMatchObject({ id: 'u1' });
  });
});
