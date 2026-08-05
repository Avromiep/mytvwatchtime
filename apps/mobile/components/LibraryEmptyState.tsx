import LottieView from 'lottie-react-native';
import { router } from 'expo-router';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useAppearance } from '../context/PreferencesProvider';
import { spacing } from '../theme/theme';
import { Button, T } from './primitives';

interface LibraryEmptyStateProps {
  kind: 'movies' | 'shows';
  refreshing?: boolean;
  onRefresh?: () => void;
}

export function LibraryEmptyState({ kind, refreshing = false, onRefresh }: LibraryEmptyStateProps) {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['common', 'import']);

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.scrollContent}
      showsVerticalScrollIndicator={false}
      refreshControl={
        onRefresh ? (
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={[tokens.primary]}
            tintColor={tokens.primary}
          />
        ) : undefined
      }
    >
      <View style={styles.content}>
        <LottieView
          source={require('../assets/empty_state.json')}
          autoPlay
          loop
          style={styles.animation}
        />

        <T variant="h1" style={styles.title}>
          {t(kind === 'movies' ? 'libraryEmptyMovieTitle' : 'libraryEmptyShowTitle')}
        </T>
        <T variant="body" muted style={styles.description}>
          {t('libraryEmptyExplore')}
        </T>
        <Button
          title={t('libraryEmptyExploreCta')}
          icon="compass-outline"
          onPress={() => router.push('/(tabs)/explore')}
          style={styles.button}
        />

        <View style={styles.orRow}>
          <View style={[styles.divider, { backgroundColor: tokens.divider }]} />
          <T variant="caption" muted style={styles.orLabel}>
            {t('or')}
          </T>
          <View style={[styles.divider, { backgroundColor: tokens.divider }]} />
        </View>

        <T variant="body" muted style={styles.description}>
          {t('libraryEmptyBuilder')}
        </T>
        <Button
          title={t('libraryEmptyBuilderCta')}
          icon="flash-outline"
          variant="ghost"
          onPress={() => router.push('/onboarding' as any)}
          style={styles.button}
        />

        <View style={styles.orRow}>
          <View style={[styles.divider, { backgroundColor: tokens.divider }]} />
          <T variant="caption" muted style={styles.orLabel}>
            {t('or')}
          </T>
          <View style={[styles.divider, { backgroundColor: tokens.divider }]} />
        </View>

        <T variant="body" muted style={styles.description}>
          {t('libraryEmptyImport')}
        </T>
        <Button
          title={t('import:importFromTvTimeOrTrakt')}
          icon="cloud-upload-outline"
          variant="ghost"
          onPress={() => router.push('/import' as any)}
          style={styles.button}
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    paddingBottom: spacing.xxl,
  },
  content: {
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center',
    alignItems: 'center',
  },
  animation: { width: 240, height: 200 },
  title: { textAlign: 'center', marginTop: spacing.sm },
  description: { textAlign: 'center', marginTop: spacing.sm },
  button: { width: '100%', marginTop: spacing.lg },
  orRow: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.xl,
  },
  divider: { flex: 1, height: StyleSheet.hairlineWidth },
  orLabel: { marginHorizontal: spacing.md },
});
