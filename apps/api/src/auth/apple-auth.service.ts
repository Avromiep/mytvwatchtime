import { HttpException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthErrorCode, type AppleAuthNonceDto, type AppleFullNameDto } from '@tvwatch/shared';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import {
  SignJWT,
  createRemoteJWKSet,
  errors as joseErrors,
  importPKCS8,
  jwtVerify,
  type JWTPayload,
} from 'jose';
import { RedisService } from '../common/redis/redis.service';
import {
  badRequestAuth,
  serviceUnavailableAuth,
  unauthorizedAuth,
} from './auth-errors';

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_EXPECTED_ALG = 'RS256';
const NONCE_TTL_SECONDS = 5 * 60;
const NONCE_PREFIX = 'auth:apple:nonce:';
const ENCRYPTED_TOKEN_PREFIX = 'enc:v1:';
const SECRET_ALGORITHM = 'aes-256-gcm';

export interface SocialProfile {
  providerUid: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
}

export interface AppleAuthResult {
  profile: SocialProfile;
  refreshToken?: string;
}

interface VerifiedAppleIdentity {
  sub: string;
  email?: string;
  emailVerified: boolean;
  payload: JWTPayload;
}

interface AppleTokenResponse {
  access_token?: string;
  expires_in?: number;
  id_token?: string;
  refresh_token?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

@Injectable()
export class AppleAuthService implements OnModuleInit {
  private readonly logger = new Logger(AppleAuthService.name);
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {
    this.jwks = createRemoteJWKSet(new URL(this.appleJwksUrl), {
      cacheMaxAge: 60 * 60 * 1000,
      cooldownDuration: 30_000,
      timeoutDuration: 5_000,
    });
  }

  onModuleInit() {
    const nodeEnv = this.config.get<string>('nodeEnv') || this.config.get<string>('NODE_ENV');
    if (nodeEnv === 'production' && this.clientId && !this.serverCredentialsConfigured) {
      throw new Error(
        'Sign in with Apple is enabled but APPLE_TEAM_ID, APPLE_KEY_ID, and APPLE_PRIVATE_KEY are required in production',
      );
    }
  }

  async createNonce(): Promise<AppleAuthNonceDto> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const nonce = randomBytes(32).toString('base64url');
      const state = randomBytes(32).toString('base64url');
      const stored = await this.redis.client.set(
        `${NONCE_PREFIX}${nonce}`,
        JSON.stringify({ state }),
        'EX',
        NONCE_TTL_SECONDS,
        'NX',
      );
      if (stored === 'OK') return { nonce, state, expiresInSeconds: NONCE_TTL_SECONDS };
    }
    throw serviceUnavailableAuth(
      AuthErrorCode.APPLE_PROVIDER_UNAVAILABLE,
      'Apple authentication is temporarily unavailable',
    );
  }

  async verifyNativeCredential(dto: {
    identityToken: string;
    authorizationCode: string;
    nonce: string;
    state: string;
    fullName?: AppleFullNameDto | null;
  }): Promise<AppleAuthResult> {
    if (!this.clientId) {
      throw serviceUnavailableAuth(
        AuthErrorCode.APPLE_AUTH_UNAVAILABLE,
        'Sign in with Apple is not configured',
      );
    }
    if (!dto.identityToken) {
      throw badRequestAuth(
        AuthErrorCode.APPLE_IDENTITY_TOKEN_MISSING,
        'Apple identity token is required',
      );
    }
    if (!dto.authorizationCode) {
      throw badRequestAuth(
        AuthErrorCode.APPLE_AUTHORIZATION_CODE_MISSING,
        'Apple authorization code is required',
      );
    }

    const stored = await this.consumeNonce(dto.nonce);
    if (!stored) {
      throw unauthorizedAuth(AuthErrorCode.APPLE_INVALID_NONCE, 'Invalid Apple nonce');
    }
    if (stored.state !== dto.state) {
      throw unauthorizedAuth(AuthErrorCode.APPLE_INVALID_STATE, 'Invalid Apple state');
    }

    const verified = await this.verifyIdentityToken(dto.identityToken, dto.nonce);
    const tokenResponse = await this.exchangeAuthorizationCode(dto.authorizationCode);
    if (tokenResponse.id_token) {
      const exchanged = await this.verifyIdentityToken(tokenResponse.id_token);
      if (exchanged.sub !== verified.sub) {
        throw unauthorizedAuth(AuthErrorCode.APPLE_INVALID_TOKEN, 'Apple token subject mismatch');
      }
    }

    return {
      profile: {
        providerUid: verified.sub,
        email: verified.emailVerified ? verified.email : undefined,
        emailVerified: verified.emailVerified,
        name: this.formatFullName(dto.fullName),
      },
      refreshToken: tokenResponse.refresh_token,
    };
  }

  encryptProviderToken(token: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(SECRET_ALGORITHM, this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${ENCRYPTED_TOKEN_PREFIX}${Buffer.concat([iv, tag, encrypted]).toString('base64')}`;
  }

  decryptProviderToken(stored?: string | null): string | null {
    if (!stored) return null;
    if (!stored.startsWith(ENCRYPTED_TOKEN_PREFIX)) return stored;
    try {
      const raw = Buffer.from(stored.slice(ENCRYPTED_TOKEN_PREFIX.length), 'base64');
      const iv = raw.subarray(0, 12);
      const tag = raw.subarray(12, 28);
      const encrypted = raw.subarray(28);
      const decipher = createDecipheriv(SECRET_ALGORITHM, this.encryptionKey, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    } catch {
      this.logger.warn('Unable to decrypt stored Apple provider token');
      return null;
    }
  }

  async revokeEncryptedRefreshToken(encryptedRefreshToken?: string | null, providerId?: string) {
    const refreshToken = this.decryptProviderToken(encryptedRefreshToken);
    if (!refreshToken) return;
    if (!this.serverCredentialsConfigured) {
      this.logger.warn('Skipping Apple revocation because server credentials are not configured');
      return;
    }

    try {
      const clientSecret = await this.createClientSecret();
      const res = await fetch(this.appleRevokeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.clientId!,
          client_secret: clientSecret,
          token: refreshToken,
          token_type_hint: 'refresh_token',
        }),
      });
      if (!res.ok) {
        this.logger.warn(
          `Apple revocation failed${providerId ? ` for provider ${providerId}` : ''}: ${res.status}`,
        );
      }
    } catch {
      this.logger.warn(
        `Apple revocation request failed${providerId ? ` for provider ${providerId}` : ''}`,
      );
    }
  }

  private async consumeNonce(nonce: string): Promise<{ state: string } | null> {
    if (!nonce) return null;
    const raw = (await this.redis.client.eval(
      'local v = redis.call("GET", KEYS[1]); if v then redis.call("DEL", KEYS[1]); end; return v',
      1,
      `${NONCE_PREFIX}${nonce}`,
    )) as string | null;
    if (!raw) return null;
    try {
      return JSON.parse(raw) as { state: string };
    } catch {
      return null;
    }
  }

  private async verifyIdentityToken(
    identityToken: string,
    expectedNonce?: string,
  ): Promise<VerifiedAppleIdentity> {
    try {
      const { payload, protectedHeader } = await jwtVerify(identityToken, this.jwks, {
        issuer: APPLE_ISSUER,
        audience: this.clientId,
        algorithms: [APPLE_EXPECTED_ALG],
      });

      if (protectedHeader.alg !== APPLE_EXPECTED_ALG) {
        throw unauthorizedAuth(AuthErrorCode.APPLE_INVALID_TOKEN, 'Invalid Apple token algorithm');
      }
      if (typeof payload.sub !== 'string' || !payload.sub) {
        throw unauthorizedAuth(AuthErrorCode.APPLE_INVALID_TOKEN, 'Invalid Apple token subject');
      }
      if (typeof payload.iat === 'number') {
        const nowSeconds = Math.floor(Date.now() / 1000);
        if (payload.iat > nowSeconds + 300) {
          throw unauthorizedAuth(
            AuthErrorCode.APPLE_INVALID_TOKEN,
            'Invalid Apple token issued-at',
          );
        }
      }
      if (expectedNonce && !this.nonceMatches(payload.nonce, expectedNonce)) {
        throw unauthorizedAuth(AuthErrorCode.APPLE_INVALID_NONCE, 'Invalid Apple nonce');
      }

      return {
        sub: payload.sub,
        email: typeof payload.email === 'string' ? payload.email.toLowerCase() : undefined,
        emailVerified: this.isEmailVerified(payload.email_verified),
        payload,
      };
    } catch (e) {
      if (e instanceof HttpException) throw e;
      throw this.mapJoseError(e);
    }
  }

  private mapJoseError(e: unknown) {
    if (e instanceof joseErrors.JWTExpired) {
      return unauthorizedAuth(AuthErrorCode.APPLE_TOKEN_EXPIRED, 'Expired Apple token');
    }
    if (e instanceof joseErrors.JWSSignatureVerificationFailed) {
      return unauthorizedAuth(
        AuthErrorCode.APPLE_INVALID_SIGNATURE,
        'Invalid Apple token signature',
      );
    }
    if (e instanceof joseErrors.JWTClaimValidationFailed) {
      if (e.claim === 'iss') {
        return unauthorizedAuth(AuthErrorCode.APPLE_INVALID_ISSUER, 'Invalid Apple token issuer');
      }
      if (e.claim === 'aud') {
        return unauthorizedAuth(
          AuthErrorCode.APPLE_INVALID_AUDIENCE,
          'Invalid Apple token audience',
        );
      }
    }
    return unauthorizedAuth(AuthErrorCode.APPLE_INVALID_TOKEN, 'Invalid Apple token');
  }

  private async exchangeAuthorizationCode(code: string): Promise<AppleTokenResponse> {
    if (!this.serverCredentialsConfigured) {
      throw serviceUnavailableAuth(
        AuthErrorCode.APPLE_PROVIDER_UNAVAILABLE,
        'Apple server authentication is not configured',
      );
    }

    try {
      const clientSecret = await this.createClientSecret();
      const res = await fetch(this.appleTokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.clientId!,
          client_secret: clientSecret,
          code,
          grant_type: 'authorization_code',
        }),
      });
      const body = (await res.json().catch(() => ({}))) as AppleTokenResponse;
      if (!res.ok) {
        if (body.error === 'invalid_grant') {
          throw unauthorizedAuth(
            AuthErrorCode.APPLE_CODE_ALREADY_CONSUMED,
            'Apple authorization code is invalid or already used',
          );
        }
        throw serviceUnavailableAuth(
          AuthErrorCode.APPLE_PROVIDER_UNAVAILABLE,
          'Apple authentication is temporarily unavailable',
        );
      }
      return body;
    } catch (e) {
      if (e instanceof HttpException) throw e;
      throw serviceUnavailableAuth(
        AuthErrorCode.APPLE_PROVIDER_UNAVAILABLE,
        'Apple authentication is temporarily unavailable',
      );
    }
  }

  private async createClientSecret(): Promise<string> {
    const privateKey = await importPKCS8(this.privateKey, 'ES256');
    return new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: this.keyId })
      .setIssuer(this.teamId!)
      .setSubject(this.clientId!)
      .setAudience(APPLE_ISSUER)
      .setIssuedAt()
      .setExpirationTime('180d')
      .sign(privateKey);
  }

  private nonceMatches(claimNonce: unknown, expectedNonce: string): boolean {
    if (typeof claimNonce !== 'string' || !claimNonce) return false;
    if (claimNonce === expectedNonce) return true;
    const hex = createHash('sha256').update(expectedNonce).digest('hex');
    const base64url = createHash('sha256').update(expectedNonce).digest('base64url');
    return claimNonce === hex || claimNonce === base64url;
  }

  private isEmailVerified(value: unknown): boolean {
    return value === true || value === 'true' || value === '1';
  }

  private formatFullName(fullName?: AppleFullNameDto | null): string | undefined {
    if (!fullName) return undefined;
    const parts = [
      fullName.namePrefix,
      fullName.givenName,
      fullName.middleName,
      fullName.familyName,
      fullName.nameSuffix,
    ]
      .map((part) => this.sanitizeNamePart(part))
      .filter(Boolean);
    const name = parts.join(' ') || this.sanitizeNamePart(fullName.nickname);
    return name || undefined;
  }

  private sanitizeNamePart(value?: string | null): string {
    return (value || '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
  }

  private get encryptionKey(): Buffer {
    const raw =
      this.config.get<string>('commentImages.encryptionMasterKey') ||
      'dev-master-key-change-in-prod-32bytes!';
    return createHash('sha256').update(raw).digest();
  }

  private get clientId(): string | undefined {
    return this.config.get<string>('auth.apple.clientId');
  }

  private get teamId(): string | undefined {
    return this.config.get<string>('auth.apple.teamId');
  }

  private get keyId(): string | undefined {
    return this.config.get<string>('auth.apple.keyId');
  }

  private get privateKey(): string {
    const direct = this.config.get<string>('auth.apple.privateKey');
    if (direct) return direct.replace(/\\n/g, '\n');
    const privateKeyPath = this.config.get<string>('auth.apple.privateKeyPath');
    if (privateKeyPath) return readFileSync(privateKeyPath, 'utf8').replace(/\\n/g, '\n');
    return '';
  }

  private get serverCredentialsConfigured(): boolean {
    return !!(this.clientId && this.teamId && this.keyId && this.privateKey);
  }

  private get appleJwksUrl(): string {
    return this.config.get<string>('auth.apple.jwksUrl') || `${APPLE_ISSUER}/auth/keys`;
  }

  private get appleTokenUrl(): string {
    return this.config.get<string>('auth.apple.tokenUrl') || `${APPLE_ISSUER}/auth/token`;
  }

  private get appleRevokeUrl(): string {
    return this.config.get<string>('auth.apple.revokeUrl') || `${APPLE_ISSUER}/auth/revoke`;
  }
}
