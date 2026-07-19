import CryptoKit
import Foundation
import UIKit

enum WidgetAPIError: Error {
  case notSignedIn
  case requestFailed
}

/// Direct API access for the WidgetKit timeline. Auth tokens live in the SHARED
/// KEYCHAIN ACCESS GROUP (first keychain-access-groups entitlement entry on both the
/// app and this extension) — never in UserDefaults. The app writes them via
/// expo-secure-store (service "app", accounts "tvwatch.access"/"tvwatch.refresh");
/// when this widget refreshes on a 401 it writes the rotated tokens back to the same
/// keychain items, so the app picks them up on next open. Non-secret config
/// (baseUrl/locale/labels) and cached payloads use the App Group container.
final class WidgetAPI {
  static let shared = WidgetAPI()

  private static let appGroup = "group.app.tvwatchtime.mobile"
  // Last-resort default only — the app pushes the resolved value on every launch;
  // the canonical resolution chain lives in apps/mobile/api/client.ts.
  private static let defaultBaseUrl = "https://api.tvwatchtime.org/api"

  private let defaults = UserDefaults(suiteName: WidgetAPI.appGroup)

  private var baseUrl: String {
    defaults?.string(forKey: "baseUrl") ?? WidgetAPI.defaultBaseUrl
  }

  var labels: WidgetLabels { WidgetLabels.load(from: defaults) }

  // MARK: - Shared keychain (mirrors expo-secure-store's item layout)

  private func keychainQuery(account: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "app",
      kSecAttrAccount as String: Data(account.utf8),
      kSecAttrGeneric as String: Data(account.utf8),
    ]
  }

  private func keychainRead(_ account: String) -> String? {
    var query = keychainQuery(account: account)
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    query[kSecReturnData as String] = kCFBooleanTrue
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
          let data = item as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  private func keychainWrite(_ account: String, _ value: String) {
    let data = Data(value.utf8)
    let query = keychainQuery(account: account)
    let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if status == errSecItemNotFound {
      var add = query
      add[kSecValueData as String] = data
      add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
      SecItemAdd(add as CFDictionary, nil)
    }
  }

  // MARK: - API

  private func authorizedRequest(path: String, token: String) -> URLRequest {
    var req = URLRequest(url: URL(string: baseUrl + path)!)
    req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    req.setValue(defaults?.string(forKey: "locale") ?? "en", forHTTPHeaderField: "Accept-Language")
    req.timeoutInterval = 15
    return req
  }

  private func refreshTokens() async -> Bool {
    guard let refresh = keychainRead("tvwatch.refresh"), !refresh.isEmpty else { return false }
    var req = URLRequest(url: URL(string: baseUrl + "/auth/refresh")!)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try? JSONSerialization.data(withJSONObject: ["refreshToken": refresh])
    req.timeoutInterval = 15
    guard
      let (data, res) = try? await URLSession.shared.data(for: req),
      (res as? HTTPURLResponse)?.statusCode == 200,
      let tokens = try? JSONDecoder().decode(RefreshResponse.self, from: data)
    else { return false }
    keychainWrite("tvwatch.access", tokens.accessToken)
    keychainWrite("tvwatch.refresh", tokens.refreshToken)
    return true
  }

  /// Evict cached API payloads (logout / invalid tokens) so stale personal data
  /// can't linger on the home screen.
  func dropPayloadCaches() {
    defaults?.removeObject(forKey: "cache.watchNext")
    defaults?.removeObject(forKey: "cache.upcoming")
  }

  /// GET an authenticated endpoint. Retries once after a token refresh on 401.
  /// Falls back to the last successful payload cached under `cacheKey` on failure.
  func fetch(path: String, cacheKey: String) async throws -> Data {
    guard let access = keychainRead("tvwatch.access"), !access.isEmpty else {
      dropPayloadCaches()
      throw WidgetAPIError.notSignedIn
    }
    var (data, response) = try await URLSession.shared.data(for: authorizedRequest(path: path, token: access))
    var status = (response as? HTTPURLResponse)?.statusCode ?? 0
    if status == 401, await refreshTokens(),
       let fresh = keychainRead("tvwatch.access") {
      (data, response) = try await URLSession.shared.data(for: authorizedRequest(path: path, token: fresh))
      status = (response as? HTTPURLResponse)?.statusCode ?? 0
    }
    if status == 401 {
      dropPayloadCaches()
      throw WidgetAPIError.notSignedIn
    }
    guard (200..<300).contains(status) else {
      if let cached = defaults?.data(forKey: cacheKey) { return cached }
      throw WidgetAPIError.requestFailed
    }
    defaults?.set(data, forKey: cacheKey)
    return data
  }

  // MARK: - Images (disk-cached in the App Group, 10s timeout)

  private var imageCacheDir: URL? {
    FileManager.default
      .containerURL(forSecurityApplicationGroupIdentifier: WidgetAPI.appGroup)?
      .appendingPathComponent("widget-images", isDirectory: true)
  }

  private func imageCacheFile(for urlString: String) -> URL? {
    let name = SHA256.hash(data: Data(urlString.utf8)).map { String(format: "%02x", $0) }.joined()
    return imageCacheDir?.appendingPathComponent(name)
  }

  /// Remove cached images older than 7 days (bounded growth across reloads).
  func pruneImageCache() {
    guard let dir = imageCacheDir,
          let files = try? FileManager.default.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
    let cutoff = Date().addingTimeInterval(-7 * 24 * 3600)
    for file in files {
      let modified = (try? file.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
      if let modified, modified < cutoff { try? FileManager.default.removeItem(at: file) }
    }
  }

  func loadImage(_ urlString: String?) async -> UIImage? {
    guard let urlString, let url = URL(string: urlString) else { return nil }
    if let file = imageCacheFile(for: urlString),
       let data = try? Data(contentsOf: file),
       let image = UIImage(data: data) {
      return image
    }
    let config = URLSessionConfiguration.default
    config.timeoutIntervalForResource = 10
    guard let (data, res) = try? await URLSession(configuration: config).data(from: url),
          (res as? HTTPURLResponse)?.statusCode == 200 else { return nil }
    if let file = imageCacheFile(for: urlString) {
      try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
      try? data.write(to: file, options: .atomic)
    }
    return UIImage(data: data)
  }
}
