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
}

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
    // Only existence is verified here (role/suspension are re-read from the DB by the
    // guards that need them), so cache it briefly: hits 60s, misses 5s so a freshly
    // registered user is never locked out. Bounded staleness on delete (60s max, and
    // access tokens themselves live 15m); user deletion also evicts explicitly.
    const cacheKey = `auth:user:${payload.sub}`;
    let exists = await this.redis.get<boolean>(cacheKey);
    if (exists == null) {
      exists = !!(await this.prisma.user.findUnique({ where: { id: payload.sub }, select: { id: true } }));
      await this.redis.set(cacheKey, exists, exists ? 60 : 5);
    }
    if (!exists) throw new UnauthorizedException();
    return { id: payload.sub, username: payload.username, email: payload.email, role: payload.role };
  }
}
