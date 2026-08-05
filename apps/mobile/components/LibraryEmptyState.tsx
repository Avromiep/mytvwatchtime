import { useEffect, useRef } from 'react';
import LottieView from 'lottie-react-native';
import { router } from 'expo-router';
import { Animated, Platform, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useAppearance } from '../context/PreferencesProvider';
import { spacing } from '../theme/theme';
import { Button, T } from './primitives';

const emptyStateSource = require('../assets/empty_state.json');
// The exported text layer references an embedded font that Lottie does not render
// consistently across native and web. Render the localized text natively instead.
const emptyStateAnimation = {
  ...emptyStateSource,
  layers: emptyStateSource.layers.filter((layer: { ty?: number }) => layer.ty !== 5),
};

interface LibraryEmptyStateProps {
  kind: 'movies' | 'shows';
  refreshing?: boolean;
  onRefresh?: () => void;
}

export function LibraryEmptyState({ kind, refreshing = false, onRefresh }: LibraryEmptyStateProps) {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['common', 'import']);
  const animationTextOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // Match the JSON timeline: text fades in around frame 14, remains visible,
    // then fades out around frame 60 of the 89-frame, 29.97fps loop.
    const textLoop = Animated.loop(
      Animated.sequence([
        Animated.delay(467),
        Animated.timing(animationTextOpacity, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
        Animated.delay(1100),
        Animated.timing(animationTextOpacity, {
          toValue: 0,
          duration: 233,
          useNativeDriver: true,
        }),
        Animated.delay(967),
      ]),
    );
    textLoop.start();
    return () => textLoop.stop();
  }, [animationTextOpacity]);

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
        <View style={styles.animationWrap}>
          <LottieView
            source={emptyStateAnimation}
            autoPlay
            loop
            resizeMode="contain"
            style={[styles.animation, Platform.OS === 'web' ? styles.animationWeb : undefined]}
          />
          <Animated.View
            pointerEvents="none"
            style={[styles.animationText, { opacity: animationTextOpacity }]}
          >
            <T variant="h2" style={{ color: tokens.primary, textAlign: 'center' }}>
              {t('libraryEmptyAnimationText')}
            </T>
          </Animated.View>
        </View>

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
    justifyContent: 'flex-start',
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xxl,
  },
  content: {
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center',
    alignItems: 'center',
  },
  // empty_state.json is a square 512×512 composition. Give Lottie explicit square
  // dimensions (absolute edge constraints render too narrowly on web) and let the
  // artwork use more of the available width without overflowing smaller phones.
  animationWrap: { width: '100%', maxWidth: 360, aspectRatio: 1, overflow: 'hidden' },
  animation: { width: '100%', height: '100%' },
  // lottie-react-native's web renderer compresses this precomposition to about half
  // its authored width. Correct only that renderer; native already preserves the asset.
  animationWeb: { transform: [{ scaleX: 2 }] },
  animationText: {
    position: 'absolute',
    top: spacing.xxl * 2,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
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
