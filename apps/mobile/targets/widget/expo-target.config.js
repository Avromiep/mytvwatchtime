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
  bundleIdentifier: ".widget",
  entitlements: {
    "com.apple.security.application-groups": [
      "group.app.tvwatchtime.mobile",
    ],
    "keychain-access-groups": [
      "$(AppIdentifierPrefix)app.tvwatchtime.mobile.shared",
    ],
  },
});
