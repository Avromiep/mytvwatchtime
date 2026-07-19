import Foundation
import UIKit

enum WidgetAPIError: Error {
  case notSignedIn
  case requestFailed
}

/// Direct API access for the WidgetKit timeline. Credentials are pushed by the app
/// (ExtensionStorage) into the shared App Group container; on 401 the widget refreshes
/// the tokens itself and persists them back so the app picks them up on next open.
final class WidgetAPI {
  static let shared = WidgetAPI()

  private static let appGroup = "group.app.tvwatchtime.mobile"
  private static let defaultBaseUrl = "https://api.tvwatchtime.org/api"

  private let defaults = UserDefaults(suiteName: WidgetAPI.appGroup)

  private var baseUrl: String {
    defaults?.string(forKey: "baseUrl") ?? WidgetAPI.defaultBaseUrl
  }

  var labels: WidgetLabels { WidgetLabels.load(from: defaults) }

  private func authorizedRequest(path: String, token: String) -> URLRequest {
    var req = URLRequest(url: URL(string: baseUrl + path)!)
    req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    req.setValue(defaults?.string(forKey: "locale") ?? "en", forHTTPHeaderField: "Accept-Language")
    req.timeoutInterval = 15
    return req
  }

  private func refreshTokens() async -> Bool {
    guard let refresh = defaults?.string(forKey: "refreshToken"), !refresh.isEmpty else { return false }
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
    defaults?.set(tokens.accessToken, forKey: "accessToken")
    defaults?.set(tokens.refreshToken, forKey: "refreshToken")
    return true
  }

  /// GET an authenticated endpoint. Retries once after a token refresh on 401.
  /// Falls back to the last successful payload cached under `cacheKey` on failure.
  func fetch(path: String, cacheKey: String) async throws -> Data {
    guard let access = defaults?.string(forKey: "accessToken"), !access.isEmpty else {
      throw WidgetAPIError.notSignedIn
    }
    var (data, response) = try await URLSession.shared.data(for: authorizedRequest(path: path, token: access))
    var status = (response as? HTTPURLResponse)?.statusCode ?? 0
    if status == 401, await refreshTokens(),
       let fresh = defaults?.string(forKey: "accessToken") {
      (data, response) = try await URLSession.shared.data(for: authorizedRequest(path: path, token: fresh))
      status = (response as? HTTPURLResponse)?.statusCode ?? 0
    }
    if status == 401 { throw WidgetAPIError.notSignedIn }
    guard (200..<300).contains(status) else {
      if let cached = defaults?.data(forKey: cacheKey) { return cached }
      throw WidgetAPIError.requestFailed
    }
    defaults?.set(data, forKey: cacheKey)
    return data
  }

  func loadImage(_ urlString: String?) async -> UIImage? {
    guard let urlString, let url = URL(string: urlString) else { return nil }
    guard let (data, res) = try? await URLSession.shared.data(from: url),
          (res as? HTTPURLResponse)?.statusCode == 200 else { return nil }
    return UIImage(data: data)
  }
}
