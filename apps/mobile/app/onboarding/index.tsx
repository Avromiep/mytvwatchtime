import React, { useEffect } from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ONBOARDING_VERSION } from '@tvwatch/shared';
import { Button, Card, Screen, T } from '../../components/primitives';
import { useAuth } from '../../context/AuthContext';
import { useAppearance } from '../../context/PreferencesProvider';
import { useUpdateOnboardingState } from '../../api/hooks';
import { logEvent, logFirstEvent } from '../../lib/analytics';
import { showError } from '../../lib/dialog';
import { spacing } from '../../theme/theme';

export default function OnboardingWelcome() {
  const { t } = useTranslation(['onboarding', 'common']);
  const { tokens } = useAppearance();
  const { user, refreshUser } = useAuth();
  const update = useUpdateOnboardingState();

  useEffect(() => {
    logFirstEvent('onboarding_started', user?.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const markInProgress = () =>
    update
      .mutateAsync({ status: 'IN_PROGRESS', version: ONBOARDING_VERSION })
      .catch(() => undefined); // best-effort; apply/skip persist the terminal state

  const onImport = () => {
    logEvent('onboarding_method_import');
    void markInProgress();
    router.push('/import?returnTo=onboarding');
  };

  const onQuickSetup = () => {
    logEvent('onboarding_method_quick_setup');
    void markInProgress();
    router.push('/onboarding/select' as any);
  };

  const onSkip = async () => {
    logFirstEvent('onboarding_skipped', user?.id);
    try {
      await update.mutateAsync({ status: 'SKIPPED', version: ONBOARDING_VERSION });
      await refreshUser();
      router.replace('/(tabs)/shows');
    } catch {
      showError({ description: t('onboarding:skipFailed') });
    }
  };

  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: 'center', padding: spacing.lg, gap: spacing.lg }}>
        <View style={{ alignItems: 'center', gap: spacing.sm }}>
          <Ionicons name="tv" size={56} color={tokens.primary} />
          <T variant="title" style={{ textAlign: 'center' }}>
            {t('onboarding:welcomeTitle')}
          </T>
          <T variant="body" muted style={{ textAlign: 'center' }}>
            {t('onboarding:welcomeDesc')}
          </T>
        </View>
        <Card style={{ gap: spacing.md }}>
          <Button
            title={t('onboarding:importHistory')}
            icon="cloud-upload-outline"
            onPress={onImport}
          />
          <Button
            title={t('onboarding:quickSetup')}
            icon="flash-outline"
            variant="watched"
            onPress={onQuickSetup}
          />
          <Button
            title={t('onboarding:skipForNow')}
            variant="ghost"
            loading={update.isPending}
            onPress={onSkip}
          />
        </Card>
        <T variant="micro" muted style={{ textAlign: 'center' }}>
          {t('onboarding:skipHint')}
        </T>
      </View>
    </Screen>
  );
}
