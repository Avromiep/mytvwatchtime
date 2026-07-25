import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import { useAppleAuth } from '../../hooks/useAppleAuth';
import { useAppearance } from '../../context/PreferencesProvider';
import { radius, spacing } from '../../theme/theme';
import { useTranslation } from 'react-i18next';

interface AppleSignInButtonProps {
  type: AppleAuthentication.AppleAuthenticationButtonType;
  style?: StyleProp<ViewStyle>;
}

export function AppleSignInButton({ type, style }: AppleSignInButtonProps) {
  const apple = useAppleAuth();
  const { resolvedTheme } = useAppearance();
  const { t } = useTranslation(['auth']);
  const accessibilityLabel =
    type === AppleAuthentication.AppleAuthenticationButtonType.SIGN_UP
      ? t('auth:signupApple')
      : t('auth:continueApple');

  if (!apple.available) return null;

  return (
    <View
      pointerEvents={apple.ready ? 'auto' : 'none'}
      style={[styles.wrapper, !apple.ready && styles.disabled, style]}
    >
      <AppleAuthentication.AppleAuthenticationButton
        buttonType={type}
        buttonStyle={
          resolvedTheme === 'dark'
            ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE
            : AppleAuthentication.AppleAuthenticationButtonStyle.BLACK
        }
        cornerRadius={radius.sm}
        style={styles.button}
        onPress={apple.signIn}
        accessibilityLabel={accessibilityLabel}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    width: '100%',
    height: 44,
    marginBottom: spacing.sm,
  },
  button: {
    width: '100%',
    height: 44,
  },
  disabled: {
    opacity: 0.6,
  },
});
