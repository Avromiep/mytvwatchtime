import React from 'react';
import { Stack } from 'expo-router';
import { useAppearance } from '../../context/PreferencesProvider';

export default function OnboardingLayout() {
  const { tokens } = useAppearance();
  return (
    <Stack
      screenOptions={{ headerShown: false, contentStyle: { backgroundColor: tokens.background } }}
    >
      <Stack.Screen name="index" />
      <Stack.Screen name="select" />
      <Stack.Screen name="progress" />
      <Stack.Screen name="review" />
      <Stack.Screen name="done" options={{ gestureEnabled: false }} />
    </Stack>
  );
}
