import { Stack } from 'expo-router';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppearance } from '../../context/PreferencesProvider';
import { LanguagePicker } from '../../components/LanguagePicker';

/**
 * No auth-state redirects here on purpose: the root Gate is the single router
 * (logged-out → login, pending onboarding → /onboarding, done → tabs). A local
 * "user ⇒ tabs" Redirect raced the Gate and sent brand-new accounts straight
 * to the tabs, skipping the onboarding intro.
 */
export default function AuthLayout() {
  const { tokens } = useAppearance();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: tokens.background }}>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: tokens.background } }} />
      <View style={{ position: 'absolute', top: insets.top + 6, right: 12, zIndex: 10 }} pointerEvents="box-none">
        <LanguagePicker />
      </View>
    </View>
  );
}
