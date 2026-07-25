import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { router } from 'expo-router';
import * as AppleAuthentication from 'expo-apple-authentication';
import type { AppleAuthNonceDto } from '@tvwatch/shared';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { showError } from '../lib/dialog';
import { runAppleSignInFlow } from '../lib/apple-auth';
import { useTranslation } from 'react-i18next';

export function useAppleAuth() {
  const { loginApple } = useAuth();
  const { t } = useTranslation(['auth']);
  const [available, setAvailable] = useState(false);
  const [checkingAvailability, setCheckingAvailability] = useState(Platform.OS === 'ios');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let mounted = true;
    if (Platform.OS !== 'ios') {
      setCheckingAvailability(false);
      return;
    }
    AppleAuthentication.isAvailableAsync()
      .then((ok) => {
        if (mounted) setAvailable(ok);
      })
      .finally(() => {
        if (mounted) setCheckingAvailability(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const signIn = useCallback(async () => {
    if (loading) return;
    if (!available) {
      showError({
        title: t('auth:appleUnavailableTitle'),
        description: t('auth:appleUnavailableDesc'),
      });
      return;
    }

    setLoading(true);
    try {
      await runAppleSignInFlow({
        createNonce: () => api.post<AppleAuthNonceDto>('/auth/apple/nonce'),
        signIn: (nonce) =>
          AppleAuthentication.signInAsync({
            requestedScopes: [
              AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
              AppleAuthentication.AppleAuthenticationScope.EMAIL,
            ],
            nonce: nonce.nonce,
            state: nonce.state,
          }),
        login: loginApple,
        onSuccess: () => router.replace('/(tabs)/shows'),
        onError: (messageKey) =>
          showError({
            title: t('auth:appleSignInFailed'),
            description: t(`auth:${messageKey}`),
          }),
      });
    } finally {
      setLoading(false);
    }
  }, [available, loading, loginApple, t]);

  return {
    available,
    ready: available && !checkingAvailability && !loading,
    loading,
    signIn,
  };
}
