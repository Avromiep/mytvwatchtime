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
import { radius, spacing } from '../../theme/theme';

/**
 * Onboarding introduction — the single first-run entry point. It replaces the
 * old first-time import popup: manual setup and history import both start here.
 */
export default function OnboardingIntro() {
  const { t } = useTranslation(['onboarding', 'common']);
  const { tokens } = useAppearance();
  const { user, refreshUser } = useAuth();
  const update = useUpdateOnboardingState();

  useEffect(() => {
    logFirstEvent('onboarding_intro_viewed', user?.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const markInProgress = () =>
    update
      .mutateAsync({ status: 'IN_PROGRESS', version: ONBOARDING_VERSION })
      .catch(() => undefined); // best-effort; apply/skip persist the terminal state

  const onManual = () => {
    logEvent('onboarding_manual_started');
    void markInProgress();
    router.push('/onboarding/select-watched' as any);
  };

  const onImport = () => {
    logEvent('onboarding_import_started');
    void markInProgress();
    router.push('/import?returnTo=onboarding');
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
          <T variant="title" style={{ textAlign: 'center' }}>
            {t('onboarding:introTitle')}
          </T>
          <T variant="body" muted style={{ textAlign: 'center' }}>
            {t('onboarding:introBody')}
          </T>
        </View>

        {/* What the setup powers — small static visual, not a feature carousel */}
        <View style={{ flexDirection: 'row', gap: spacing.sm }}>
          <PreviewTile icon="albums-outline" label={t('onboarding:introVisualLibrary')} />
          <PreviewTile icon="play-circle-outline" label={t('onboarding:introVisualWatchNext')} />
          <PreviewTile icon="stats-chart-outline" label={t('onboarding:introVisualStats')} />
        </View>

        <Card style={{ gap: spacing.md }}>
          <Button title={t('onboarding:introCta')} icon="flash-outline" onPress={onManual} />
          <Button
            title={t('onboarding:introImport')}
            icon="cloud-upload-outline"
            variant="ghost"
            onPress={onImport}
          />
          <Button
            title={t('onboarding:introSkip')}
            variant="ghost"
            loading={update.isPending}
            onPress={onSkip}
          />
        </Card>

        <View style={{ alignItems: 'center', gap: spacing.xs }}>
          <T variant="caption" muted style={{ textAlign: 'center' }}>
            {t('onboarding:introTime')}
          </T>
          <T variant="micro" muted style={{ textAlign: 'center' }}>
            {t('onboarding:introReassurance')}
          </T>
        </View>
      </View>
    </Screen>
  );
}

function PreviewTile({ icon, label }: { icon: keyof typeof Ionicons.glyphMap; label: string }) {
  const { tokens } = useAppearance();
  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        gap: spacing.xs,
        paddingVertical: spacing.md,
        borderRadius: radius.lg,
        backgroundColor: tokens.surfaceElevated,
      }}
    >
      <Ionicons name={icon} size={26} color={tokens.primary} />
      <T variant="caption">{label}</T>
    </View>
  );
}
