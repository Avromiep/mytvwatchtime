import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';

export interface JwtPayload {
  sub: string;
  username: string;
  email: string;
  role: string;
  kind?: 'access' | 'refresh';
  /** Epoch seconds of the user's passwordChangedAt at issue time (0 if never changed). */
  pwc?: number;
  /** Standard JWT issued-at (seconds). Present on every verified token. */
  iat?: number;
}

/** Max age (seconds) a legacy token without a `kind` claim may be accepted as an
 *  access token — matches the access-token lifetime, so stale refresh tokens that
 *  predate the `kind` claim can't be used on protected routes. */
const LEGACY_ACCESS_MAX_AGE_S = 15 * 60;

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('jwt.secret')!,
    });
  }

  async validate(payload: JwtPayload) {
    // Protected routes accept access tokens only. Refresh tokens (and anything else)
    // are rejected; a legacy token without a `kind` is accepted only while still
    // within the access-token lifetime, so long-lived refresh tokens can't slip in.
    if (payload.kind !== 'access') {
      if (payload.kind != null) throw new UnauthorizedException();
      const age = payload.iat != null ? Date.now() / 1000 - payload.iat : Infinity;
      if (age > LEGACY_ACCESS_MAX_AGE_S) throw new UnauthorizedException();
    }

    // Only existence + password-change epoch are verified here (role/suspension are
    // re-read from the DB by the guards that need them), so cache briefly: hits 60s,
    // misses 5s so a freshly registered user is never locked out. Bounded staleness on
    // delete/password-change (60s max, and access tokens live 15m); user deletion and
    // password changes also evict explicitly.
    const cacheKey = `auth:user:${payload.sub}`;
    let cached = await this.redis.get<{ exists: boolean; pwc: number }>(cacheKey);
    // Tolerate the pre-upgrade boolean cache shape by treating it as a miss.
    if (cached == null || typeof cached !== 'object') {
      const u = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, passwordChangedAt: true },
      });
      cached = {
        exists: !!u,
        pwc: u?.passwordChangedAt ? Math.floor(u.passwordChangedAt.getTime() / 1000) : 0,
      };
      await this.redis.set(cacheKey, cached, cached.exists ? 60 : 5);
    }
    if (!cached.exists) throw new UnauthorizedException();
    // Reject tokens issued before the last password change/reset.
    if ((payload.pwc ?? 0) < cached.pwc) throw new UnauthorizedException();
    return { id: payload.sub, username: payload.username, email: payload.email, role: payload.role };
  }
}
