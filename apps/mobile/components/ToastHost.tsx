import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useAppearance } from '../context/PreferencesProvider';
import { radius, spacing } from '../theme/theme';
import { T } from './primitives';
import { dismissToast, getToast, subscribeToast } from '../lib/toast';

const TOAST_DURATION_MS = 2200;

/**
 * Renders the current toast as a small bottom-centered pill. Mount once near the
 * app root. Never intercepts touches; auto-dismisses.
 */
export function ToastHost() {
  const { tokens } = useAppearance();
  const insets = useSafeAreaInsets();
  const [, setTick] = useState(0);

  useEffect(() => subscribeToast(() => setTick((t) => t + 1)), []);

  const toast = getToast();
  const toastId = toast?.id;
  useEffect(() => {
    if (toastId == null) return;
    const timer = setTimeout(dismissToast, TOAST_DURATION_MS);
    return () => clearTimeout(timer);
  }, [toastId]);

  if (!toast) return null;
  return (
    <View pointerEvents="none" style={[styles.wrap, { bottom: insets.bottom + spacing.xxl + spacing.xl }]}>
      <View style={[styles.toast, { backgroundColor: tokens.surfaceElevated, borderColor: tokens.border }]}>
        <Ionicons name="checkmark-circle" size={16} color={tokens.watched} />
        <T variant="caption" numberOfLines={2} style={{ marginLeft: spacing.sm, color: tokens.textPrimary }}>
          {toast.message}
        </T>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 1000,
    elevation: 10,
  },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    maxWidth: '85%',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
});
