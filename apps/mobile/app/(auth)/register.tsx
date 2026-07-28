import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as WebBrowser from 'expo-web-browser';
import * as AppleAuthentication from 'expo-apple-authentication';
import { useAuth } from '../../context/AuthContext';
import { useGoogleAuth } from '../../hooks/useSocialAuth';
import { AppleSignInButton } from '../../components/auth/AppleSignInButton';
import { Button, Card, Screen, T } from '../../components/primitives';
import { TextField } from '../../components/TextField';
import { SITE_URL } from '../../api/client';
import { useAppearance } from '../../context/PreferencesProvider';
import { spacing } from '../../theme/theme';
import { showError } from '../../lib/dialog';
import { useTranslation } from 'react-i18next';

export default function RegisterScreen() {
  const { tokens } = useAppearance();
  const { registerEmail, isSelfHosted, setSelfHosted } = useAuth();
  const { t } = useTranslation(['auth', 'common', 'settings']);
  const google = useGoogleAuth();
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [serverUrl, setServerUrl] = useState('');
  const [selfHostedChecked, setSelfHostedChecked] = useState(isSelfHosted);
  const [agreedTerms, setAgreedTerms] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showConfirm, setShowConfirm] = useState(false);

  const toggleSelfHosted = async () => {
    const newVal = !selfHostedChecked;
    setSelfHostedChecked(newVal);
    if (newVal) {
      await setSelfHosted(true, serverUrl || 'http://localhost:4000/api');
    } else {
      await setSelfHosted(false);
    }
  };

  const submit = async () => {
    if (selfHostedChecked && !serverUrl) {
      showError({ title: t('auth:serverUrlRequired'), description: t('auth:enterBackendUrl') });
      return;
    }
    if (password !== confirmPassword) {
      showError({ title: t('auth:passwordMismatch'), description: t('auth:passwordsDoNotMatch') });
      return;
    }
    if (!agreedTerms) {
      showError({ title: t('auth:termsRequired'), description: t('auth:agreeToTerms') });
      return;
    }
    setLoading(true);
    try {
      if (selfHostedChecked) {
        await setSelfHosted(true, serverUrl);
      }
      await registerEmail({ email, username, password });
      // No explicit navigation: the Gate routes brand-new accounts to the
      // onboarding intro (session now carries onboardingStatus) and everyone
      // else to the tabs — one router, no race.
    } catch (e: any) {
      showError({ title: t('auth:signupFailed'), description: e.message ?? t('common:tryAgain') });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Screen style={{ justifyContent: 'center', padding: spacing.xl }}>
      <View style={{ alignItems: 'center', marginBottom: spacing.xl }}>
        <Ionicons name="tv-outline" size={48} color={tokens.primary} />
        <T variant="title" style={{ marginTop: spacing.md }}>
          {t('auth:createAccount')}
        </T>
      </View>

      <Card>
        <Pressable
          onPress={toggleSelfHosted}
          style={{ flexDirection: 'row', alignItems: 'center', marginBottom: spacing.md }}
        >
          <View
            style={[
              styles.checkbox,
              { borderColor: tokens.border },
              selfHostedChecked && { backgroundColor: tokens.primary, borderColor: tokens.primary },
            ]}
          >
            {selfHostedChecked ? (
              <Ionicons name="checkmark" size={16} color={tokens.primaryForeground} />
            ) : null}
          </View>
          <View style={{ flex: 1, marginLeft: spacing.sm }}>
            <T variant="body">{t('auth:selfHosted')}</T>
            <T variant="micro" muted>
              {t('auth:selfHostedHint')}
            </T>
          </View>
        </Pressable>

        {selfHostedChecked ? (
          <TextField
            label={t('settings:backendUrl')}
            value={serverUrl}
            onChangeText={setServerUrl}
            autoCapitalize="none"
            keyboardType="url"
          />
        ) : null}

        <TextField
          label={t('settings:username')}
          value={username}
          onChangeText={setUsername}
          autoCapitalize="none"
        />
        <TextField
          label={t('auth:email')}
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          autoCapitalize="none"
        />
        <TextField
          label={t('auth:password')}
          value={password}
          onChangeText={setPassword}
          secureTextEntry={!showPassword}
          trailingIcon={{
            name: showPassword ? 'eye-off-outline' : 'eye-outline',
            onPress: () => setShowPassword(!showPassword),
          }}
        />
        <TextField
          label={t('auth:confirmPassword')}
          value={confirmPassword}
          onChangeText={setConfirmPassword}
          secureTextEntry={!showConfirm}
          trailingIcon={{
            name: showConfirm ? 'eye-off-outline' : 'eye-outline',
            onPress: () => setShowConfirm(!showConfirm),
          }}
        />

        <Pressable
          onPress={() => setAgreedTerms(!agreedTerms)}
          style={{ flexDirection: 'row', alignItems: 'flex-start', marginTop: spacing.sm }}
        >
          <View
            style={[
              styles.checkbox,
              { borderColor: tokens.border },
              agreedTerms && { backgroundColor: tokens.primary, borderColor: tokens.primary },
            ]}
          >
            {agreedTerms ? (
              <Ionicons name="checkmark" size={16} color={tokens.primaryForeground} />
            ) : null}
          </View>
          <View style={{ flex: 1, marginLeft: spacing.sm }}>
            <T variant="micro">
              {t('auth:agreePrefix')}{' '}
              <T
                variant="micro"
                style={{ color: tokens.primary }}
                onPress={() => WebBrowser.openBrowserAsync(`${SITE_URL}/terms`)}
              >
                {t('auth:termsOfUse')}
              </T>{' '}
              {t('auth:and')}{' '}
              <T
                variant="micro"
                style={{ color: tokens.primary }}
                onPress={() => WebBrowser.openBrowserAsync(`${SITE_URL}/privacy`)}
              >
                {t('auth:privacyPolicy')}
              </T>
            </T>
          </View>
        </Pressable>

        <Button
          title={t('auth:createAccount')}
          onPress={submit}
          loading={loading}
          icon="person-add-outline"
          disabled={!agreedTerms}
          style={{ marginTop: spacing.sm }}
        />
      </Card>

      {!selfHostedChecked ? (
        <View style={styles.divider}>
          <View style={[styles.line, { backgroundColor: tokens.border }]} />
          <T variant="caption" muted style={{ marginHorizontal: spacing.md }}>
            {t('auth:or')}
          </T>
          <View style={[styles.line, { backgroundColor: tokens.border }]} />
        </View>
      ) : null}

      {!selfHostedChecked ? (
        <>
          <AppleSignInButton type={AppleAuthentication.AppleAuthenticationButtonType.SIGN_UP} />
          {google.configured ? (
            <Button
              title={t('auth:signupGoogle')}
              variant="ghost"
              icon="logo-google"
              onPress={google.signIn}
              disabled={!google.ready}
              style={styles.social}
            />
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  divider: { flexDirection: 'row', alignItems: 'center', marginVertical: spacing.lg },
  line: { flex: 1, height: 1 },
  social: { marginBottom: spacing.sm },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
