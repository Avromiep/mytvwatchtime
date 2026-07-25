import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthErrorCode } from '@tvwatch/shared';
import { SignJWT, exportJWK, exportPKCS8, generateKeyPair, type KeyLike, type JWK } from 'jose';
import { AppleAuthService } from './apple-auth.service';

const CLIENT_ID = 'app.tvwatchtime.mobile';
const ISSUER = 'https://appleid.apple.com';

function makeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    client: {
      set: jest.fn(async (key: string, value: string, _ex: string, _ttl: number, nx: string) => {
        if (nx === 'NX' && store.has(key)) return null;
        store.set(key, value);
        return 'OK';
      }),
      eval: jest.fn(async (_script: string, _keys: number, key: string) => {
        const value = store.get(key) ?? null;
        if (value) store.delete(key);
        return value;
      }),
    },
  } as any;
}

describe('AppleAuthService', () => {
  let server: Server;
  let baseUrl: string;
  let applePrivateKey: KeyLike;
  let wrongPrivateKey: KeyLike;
  let applePublicJwk: JWK;
  let clientSecretPrivateKey: string;
  let revokeRequests: string[];

  beforeAll(async () => {
    const appleKeys = await generateKeyPair('RS256');
    const wrongKeys = await generateKeyPair('RS256');
    const clientSecretKeys = await generateKeyPair('ES256');
    applePrivateKey = appleKeys.privateKey;
    wrongPrivateKey = wrongKeys.privateKey;
    applePublicJwk = {
      ...(await exportJWK(appleKeys.publicKey)),
      kid: 'apple-test-key',
      alg: 'RS256',
    };
    clientSecretPrivateKey = await exportPKCS8(clientSecretKeys.privateKey);
    revokeRequests = [];

    server = createServer(async (req, res) => {
      if (req.url === '/keys') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ keys: [applePublicJwk] }));
        return;
      }
      if (req.url === '/token' && req.method === 'POST') {
        const body = await readRequestBody(req);
        const params = new URLSearchParams(body);
        if (params.get('code') === 'used-code') {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            id_token: await signAppleToken({ sub: params.get('code') || 'apple-sub' }),
            refresh_token: 'apple-refresh-token',
          }),
        );
        return;
      }
      if (req.url === '/revoke' && req.method === 'POST') {
        revokeRequests.push(await readRequestBody(req));
        res.statusCode = 200;
        res.end('');
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function signAppleToken(opts: {
    sub?: string;
    nonce?: string;
    email?: string;
    emailVerified?: boolean | string;
    issuer?: string;
    audience?: string;
    expiresIn?: string | number;
    key?: KeyLike;
  }) {
    const jwt = new SignJWT({
      ...(opts.sub !== undefined ? { sub: opts.sub } : {}),
      ...(opts.nonce ? { nonce: opts.nonce } : {}),
      ...(opts.email ? { email: opts.email } : {}),
      ...(opts.emailVerified !== undefined ? { email_verified: opts.emailVerified } : {}),
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'apple-test-key' })
      .setIssuer(opts.issuer ?? ISSUER)
      .setAudience(opts.audience ?? CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime(opts.expiresIn ?? '5m');
    return jwt.sign(opts.key ?? applePrivateKey);
  }

  function makeService() {
    const redis = makeRedis();
    const config = new ConfigService({
      nodeEnv: 'test',
      auth: {
        apple: {
          clientId: CLIENT_ID,
          teamId: 'TEAMID1234',
          keyId: 'KEYID1234',
          privateKey: clientSecretPrivateKey,
          jwksUrl: `${baseUrl}/keys`,
          tokenUrl: `${baseUrl}/token`,
          revokeUrl: `${baseUrl}/revoke`,
        },
      },
      commentImages: { encryptionMasterKey: 'test-master-key' },
    });
    return { service: new AppleAuthService(config, redis), redis };
  }

  async function validNonce(service: AppleAuthService) {
    return service.createNonce();
  }

  it('verifies a valid Apple token, exchanges the code, and accepts private relay email', async () => {
    const { service } = makeService();
    const nonce = await validNonce(service);
    const identityToken = await signAppleToken({
      sub: 'apple-sub',
      nonce: nonce.nonce,
      email: 'relay@privaterelay.appleid.com',
      emailVerified: 'true',
    });

    const result = await service.verifyNativeCredential({
      identityToken,
      authorizationCode: 'apple-sub',
      nonce: nonce.nonce,
      state: nonce.state,
      fullName: { givenName: 'Ada', familyName: 'Lovelace' },
    });

    expect(result.profile).toMatchObject({
      providerUid: 'apple-sub',
      email: 'relay@privaterelay.appleid.com',
      emailVerified: true,
      name: 'Ada Lovelace',
    });
    expect(result.refreshToken).toBe('apple-refresh-token');
  });

  it('rejects an invalid signature', async () => {
    const { service } = makeService();
    const nonce = await validNonce(service);
    const identityToken = await signAppleToken({
      sub: 'apple-sub',
      nonce: nonce.nonce,
      key: wrongPrivateKey,
    });

    await expect(
      service.verifyNativeCredential({
        identityToken,
        authorizationCode: 'apple-sub',
        nonce: nonce.nonce,
        state: nonce.state,
      }),
    ).rejects.toMatchObject({ response: { code: AuthErrorCode.APPLE_INVALID_SIGNATURE } });
  });

  it('rejects the wrong issuer', async () => {
    const { service } = makeService();
    const nonce = await validNonce(service);
    const identityToken = await signAppleToken({
      sub: 'apple-sub',
      nonce: nonce.nonce,
      issuer: 'https://evil.example',
    });

    await expect(
      service.verifyNativeCredential({
        identityToken,
        authorizationCode: 'apple-sub',
        nonce: nonce.nonce,
        state: nonce.state,
      }),
    ).rejects.toMatchObject({ response: { code: AuthErrorCode.APPLE_INVALID_ISSUER } });
  });

  it('rejects the wrong audience', async () => {
    const { service } = makeService();
    const nonce = await validNonce(service);
    const identityToken = await signAppleToken({
      sub: 'apple-sub',
      nonce: nonce.nonce,
      audience: 'other.bundle',
    });

    await expect(
      service.verifyNativeCredential({
        identityToken,
        authorizationCode: 'apple-sub',
        nonce: nonce.nonce,
        state: nonce.state,
      }),
    ).rejects.toMatchObject({ response: { code: AuthErrorCode.APPLE_INVALID_AUDIENCE } });
  });

  it('rejects an expired token', async () => {
    const { service } = makeService();
    const nonce = await validNonce(service);
    const identityToken = await signAppleToken({
      sub: 'apple-sub',
      nonce: nonce.nonce,
      expiresIn: Math.floor(Date.now() / 1000) - 1,
    });

    await expect(
      service.verifyNativeCredential({
        identityToken,
        authorizationCode: 'apple-sub',
        nonce: nonce.nonce,
        state: nonce.state,
      }),
    ).rejects.toMatchObject({ response: { code: AuthErrorCode.APPLE_TOKEN_EXPIRED } });
  });

  it('rejects a missing or incorrect nonce', async () => {
    const { service } = makeService();
    const nonce = await validNonce(service);
    const identityToken = await signAppleToken({ sub: 'apple-sub', nonce: 'different' });

    await expect(
      service.verifyNativeCredential({
        identityToken,
        authorizationCode: 'apple-sub',
        nonce: nonce.nonce,
        state: nonce.state,
      }),
    ).rejects.toMatchObject({ response: { code: AuthErrorCode.APPLE_INVALID_NONCE } });
  });

  it('rejects a reused nonce', async () => {
    const { service } = makeService();
    const nonce = await validNonce(service);
    const identityToken = await signAppleToken({ sub: 'apple-sub', nonce: nonce.nonce });
    await service.verifyNativeCredential({
      identityToken,
      authorizationCode: 'apple-sub',
      nonce: nonce.nonce,
      state: nonce.state,
    });

    await expect(
      service.verifyNativeCredential({
        identityToken,
        authorizationCode: 'apple-sub',
        nonce: nonce.nonce,
        state: nonce.state,
      }),
    ).rejects.toMatchObject({ response: { code: AuthErrorCode.APPLE_INVALID_NONCE } });
  });

  it('rejects a missing subject', async () => {
    const { service } = makeService();
    const nonce = await validNonce(service);
    const identityToken = await signAppleToken({ nonce: nonce.nonce });

    await expect(
      service.verifyNativeCredential({
        identityToken,
        authorizationCode: 'apple-sub',
        nonce: nonce.nonce,
        state: nonce.state,
      }),
    ).rejects.toMatchObject({ response: { code: AuthErrorCode.APPLE_INVALID_TOKEN } });
  });

  it('rejects an invalid state', async () => {
    const { service } = makeService();
    const nonce = await validNonce(service);
    const identityToken = await signAppleToken({ sub: 'apple-sub', nonce: nonce.nonce });

    await expect(
      service.verifyNativeCredential({
        identityToken,
        authorizationCode: 'apple-sub',
        nonce: nonce.nonce,
        state: 'wrong',
      }),
    ).rejects.toMatchObject({ response: { code: AuthErrorCode.APPLE_INVALID_STATE } });
  });

  it('maps a consumed Apple authorization code to a stable error code', async () => {
    const { service } = makeService();
    const nonce = await validNonce(service);
    const identityToken = await signAppleToken({ sub: 'apple-sub', nonce: nonce.nonce });

    await expect(
      service.verifyNativeCredential({
        identityToken,
        authorizationCode: 'used-code',
        nonce: nonce.nonce,
        state: nonce.state,
      }),
    ).rejects.toMatchObject({ response: { code: AuthErrorCode.APPLE_CODE_ALREADY_CONSUMED } });
  });

  it('does not log sensitive Apple credentials on verification failure', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service } = makeService();
    const nonce = await validNonce(service);
    const identityToken = await signAppleToken({
      sub: 'secret-sub',
      nonce: nonce.nonce,
      key: wrongPrivateKey,
    });

    await expect(
      service.verifyNativeCredential({
        identityToken,
        authorizationCode: 'secret-code',
        nonce: nonce.nonce,
        state: nonce.state,
      }),
    ).rejects.toBeTruthy();

    expect(JSON.stringify(warn.mock.calls)).not.toContain(identityToken);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-code');
    warn.mockRestore();
  });

  it('encrypts refresh tokens before storage and revokes decrypted tokens', async () => {
    const { service } = makeService();
    const encrypted = service.encryptProviderToken('refresh-token-to-revoke');
    expect(encrypted).not.toContain('refresh-token-to-revoke');

    await service.revokeEncryptedRefreshToken(encrypted, 'provider-id');

    expect(revokeRequests.at(-1)).toContain('token=refresh-token-to-revoke');
    expect(revokeRequests.at(-1)).toContain('token_type_hint=refresh_token');
  });
});

function readRequestBody(req: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
  });
}
