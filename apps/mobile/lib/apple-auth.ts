import {
  AuthErrorCode,
  type AppleAuthNonceDto,
  type AppleFullNameDto,
  type AppleLoginDto,
} from '@tvwatch/shared';

export interface AppleCredentialLike {
  identityToken?: string | null;
  authorizationCode?: string | null;
  state?: string | null;
  email?: string | null;
  fullName?: AppleFullNameDto | null;
}

export class AppleClientAuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function buildAppleLoginDto(
  nonce: AppleAuthNonceDto,
  credential: AppleCredentialLike,
): AppleLoginDto {
  if (!credential.identityToken) {
    throw new AppleClientAuthError(
      AuthErrorCode.APPLE_IDENTITY_TOKEN_MISSING,
      'Apple identity token missing',
    );
  }
  if (!credential.authorizationCode) {
    throw new AppleClientAuthError(
      AuthErrorCode.APPLE_AUTHORIZATION_CODE_MISSING,
      'Apple authorization code missing',
    );
  }
  if (credential.state && credential.state !== nonce.state) {
    throw new AppleClientAuthError(AuthErrorCode.APPLE_INVALID_STATE, 'Apple state mismatch');
  }

  return {
    identityToken: credential.identityToken,
    authorizationCode: credential.authorizationCode,
    nonce: nonce.nonce,
    state: credential.state || nonce.state,
    fullName: credential.fullName ?? null,
    email: credential.email ?? null,
  };
}

export function isAppleCancellation(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as { code?: string }).code === 'ERR_REQUEST_CANCELED'
  );
}

export function getAppleAuthErrorCode(error: unknown): AuthErrorCode | null {
  if (error instanceof AppleClientAuthError) return error.code;
  const data = error && typeof error === 'object' ? (error as { data?: unknown }).data : null;
  if (data && typeof data === 'object') {
    const code = (data as { code?: string }).code;
    return Object.values(AuthErrorCode).includes(code as AuthErrorCode)
      ? (code as AuthErrorCode)
      : null;
  }
  return null;
}

export function appleAuthErrorMessageKey(error: unknown): string {
  const code = getAppleAuthErrorCode(error);
  switch (code) {
    case AuthErrorCode.APPLE_AUTH_UNAVAILABLE:
      return 'appleUnavailableDesc';
    case AuthErrorCode.APPLE_IDENTITY_TOKEN_MISSING:
      return 'appleMissingIdentityToken';
    case AuthErrorCode.APPLE_AUTHORIZATION_CODE_MISSING:
      return 'appleMissingAuthorizationCode';
    case AuthErrorCode.APPLE_INVALID_STATE:
      return 'appleInvalidState';
    case AuthErrorCode.APPLE_INVALID_NONCE:
      return 'appleInvalidNonce';
    case AuthErrorCode.APPLE_CODE_ALREADY_CONSUMED:
      return 'appleCodeConsumed';
    case AuthErrorCode.ACCOUNT_EXISTS_WITH_DIFFERENT_PROVIDER:
      return 'accountExistsDifferentProvider';
    case AuthErrorCode.ACCOUNT_DISABLED:
    case AuthErrorCode.ACCOUNT_DELETED:
      return 'accountUnavailable';
    case AuthErrorCode.APPLE_INVALID_SIGNATURE:
    case AuthErrorCode.APPLE_INVALID_ISSUER:
    case AuthErrorCode.APPLE_INVALID_AUDIENCE:
    case AuthErrorCode.APPLE_TOKEN_EXPIRED:
    case AuthErrorCode.APPLE_INVALID_TOKEN:
      return 'appleInvalidCredential';
    case AuthErrorCode.APPLE_PROVIDER_UNAVAILABLE:
      return 'appleProviderUnavailable';
    default:
      return error && typeof error === 'object' && (error as { status?: number }).status === 0
        ? 'appleNetworkFailed'
        : 'appleTryAgain';
  }
}

export async function runAppleSignInFlow(deps: {
  createNonce: () => Promise<AppleAuthNonceDto>;
  signIn: (nonce: AppleAuthNonceDto) => Promise<AppleCredentialLike>;
  login: (dto: AppleLoginDto) => Promise<void>;
  onSuccess: () => void;
  onError: (messageKey: string) => void;
}) {
  try {
    const nonce = await deps.createNonce();
    const credential = await deps.signIn(nonce);
    await deps.login(buildAppleLoginDto(nonce, credential));
    deps.onSuccess();
  } catch (error) {
    if (isAppleCancellation(error)) return;
    deps.onError(appleAuthErrorMessageKey(error));
  }
}
