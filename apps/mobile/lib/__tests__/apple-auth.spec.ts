import { AuthErrorCode } from '@tvwatch/shared';
import { appleAuthErrorMessageKey, buildAppleLoginDto, runAppleSignInFlow } from '../apple-auth';

describe('Apple auth mobile handler', () => {
  it('builds the API login request from the native Apple credential', () => {
    expect(
      buildAppleLoginDto(
        { nonce: 'nonce', state: 'state', expiresInSeconds: 300 },
        {
          identityToken: 'identity-token',
          authorizationCode: 'authorization-code',
          state: 'state',
          email: null,
          fullName: { givenName: 'Ada', familyName: 'Lovelace' },
        },
      ),
    ).toEqual({
      identityToken: 'identity-token',
      authorizationCode: 'authorization-code',
      nonce: 'nonce',
      state: 'state',
      email: null,
      fullName: { givenName: 'Ada', familyName: 'Lovelace' },
    });
  });

  it('treats Apple user cancellation as a normal no-op', async () => {
    const onError = jest.fn();
    const login = jest.fn();
    const onSuccess = jest.fn();

    await runAppleSignInFlow({
      createNonce: async () => ({ nonce: 'nonce', state: 'state', expiresInSeconds: 300 }),
      signIn: async () => {
        throw { code: 'ERR_REQUEST_CANCELED' };
      },
      login,
      onSuccess,
      onError,
    });

    expect(login).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('hydrates the existing session path after successful Apple authentication', async () => {
    const login = jest.fn(async () => undefined);
    const onSuccess = jest.fn();

    await runAppleSignInFlow({
      createNonce: async () => ({ nonce: 'nonce', state: 'state', expiresInSeconds: 300 }),
      signIn: async () => ({
        identityToken: 'identity-token',
        authorizationCode: 'authorization-code',
        state: 'state',
        email: 'relay@privaterelay.appleid.com',
        fullName: null,
      }),
      login,
      onSuccess,
      onError: jest.fn(),
    });

    expect(login).toHaveBeenCalledWith({
      identityToken: 'identity-token',
      authorizationCode: 'authorization-code',
      nonce: 'nonce',
      state: 'state',
      email: 'relay@privaterelay.appleid.com',
      fullName: null,
    });
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('maps account conflicts to the localized different-provider message', () => {
    const error = { data: { code: AuthErrorCode.ACCOUNT_EXISTS_WITH_DIFFERENT_PROVIDER } };
    expect(appleAuthErrorMessageKey(error)).toBe('accountExistsDifferentProvider');
  });
});
