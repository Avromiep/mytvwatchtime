/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: 'widget',
  name: 'TVWatchWidgets',
  displayName: 'TV Watch Time',
  colors: {
    $accent: '#FFD60A',
    $widgetBackground: '#0F1115',
  },
  frameworks: ['SwiftUI', 'WidgetKit'],
  deploymentTarget: '17.0',
  entitlements: {
    'com.apple.security.application-groups': config.ios?.entitlements?.[
      'com.apple.security.application-groups'
    ] ?? ['group.app.tvwatchtime.mobile'],
    // Must match the main app's first keychain-access-groups entry: tokens live in
    // this shared group (written by expo-secure-store) so the widget never handles
    // a UserDefaults copy. Keep in sync with app.json ios.entitlements.
    'keychain-access-groups': ['$(AppIdentifierPrefix)app.tvwatchtime.mobile.shared'],
  },
});
