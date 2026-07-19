// Web/fallback no-ops. Platform implementations live in sync.ios.ts / sync.android.ts
// (Metro picks the platform file; this one is bundled for web so the Expo web export
// never touches the native widget modules).

export async function syncWidgetCredentials(): Promise<void> {}
export async function clearWidgetCredentials(): Promise<void> {}
export async function syncWidgetLabels(): Promise<void> {}
export async function refreshWidgets(): Promise<void> {}
