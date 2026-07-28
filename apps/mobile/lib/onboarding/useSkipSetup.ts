import { useCallback } from 'react';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ONBOARDING_VERSION } from '@tvwatch/shared';
import { useUpdateOnboardingState } from '../../api/hooks';
import { useAuth } from '../../context/AuthContext';
import { logEvent, logFirstEvent } from '../analytics';
import { showDialog, showError } from '../dialog';

/**
 * "Skip setup" — present on every manual onboarding screen after the intro.
 * With selections in the draft, the user confirms first; the draft stays in
 * AsyncStorage either way so the flow can be finished later from Settings.
 */
export function useSkipSetup() {
  const { t } = useTranslation(['onboarding']);
  const { user, refreshUser } = useAuth();
  const update = useUpdateOnboardingState();

  const leave = useCallback(async () => {
    try {
      await update.mutateAsync({ status: 'SKIPPED', version: ONBOARDING_VERSION });
      await refreshUser();
      router.replace('/(tabs)/shows');
    } catch {
      showError({ description: t('onboarding:skipFailed') });
    }
  }, [update, refreshUser, t]);

  const skip = useCallback(
    (hasSelections: boolean) => {
      if (!hasSelections) {
        logFirstEvent('onboarding_skipped', user?.id);
        void leave();
        return;
      }
      showDialog({
        title: t('onboarding:leaveTitle'),
        description: t('onboarding:leaveBody'),
        buttons: [
          { label: t('onboarding:leaveKeep'), variant: 'ghost' },
          {
            label: t('onboarding:leaveSave'),
            variant: 'primary',
            onPress: () => {
              logFirstEvent('onboarding_skipped', user?.id);
              logEvent('onboarding_draft_saved');
              void leave();
            },
          },
        ],
      });
    },
    [leave, t, user?.id],
  );

  return { skip, pending: update.isPending };
}
