import SwiftUI
import UIKit

extension UIColor {
  convenience init(hex: UInt32, alpha: CGFloat = 1) {
    self.init(
      red: CGFloat((hex >> 16) & 0xFF) / 255,
      green: CGFloat((hex >> 8) & 0xFF) / 255,
      blue: CGFloat(hex & 0xFF) / 255,
      alpha: alpha
    )
  }
}

/// Mirrors the shared design tokens (packages/shared/src/design-tokens.ts) as
/// dynamic colors so widgets follow the device light/dark theme.
enum WidgetTheme {
  static let background = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: 0x0F1115) : UIColor(hex: 0xF7F8FA) })
  static let surface = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: 0x171A21) : UIColor.white })
  static let textPrimary = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor.white : UIColor(hex: 0x0F1115) })
  static let textMuted = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: 0x9AA3B2) : UIColor(hex: 0x6B7280) })
  static let primary = Color(uiColor: UIColor(hex: 0xFFD60A))
  static let primaryForeground = Color(uiColor: UIColor(hex: 0x0F1115))
}
