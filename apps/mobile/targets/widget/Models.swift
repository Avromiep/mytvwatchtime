import Foundation

/// DTOs decoded from the backend API (mirror of packages/shared/src/user.ts).

struct EpisodeBrief: Decodable {
  let id: String
  let seasonNumber: Int
  let number: Int
  let title: String
  let stillUrl: String?
}

struct WatchNextItem: Decodable, Identifiable {
  let showId: String
  let showTitle: String
  let backdropUrl: String?
  let network: String?
  let episode: EpisodeBrief
  let remainingUnwatched: Int
  let bucket: String

  var id: String { episode.id }
}

struct WatchNextResponse: Decodable {
  let items: [WatchNextItem]
}

struct UpcomingItem: Decodable, Identifiable {
  let id: String
  let title: String
  let posterUrl: String?
  let seasonNumber: Int?
  let episodeNumber: Int?
  let episodeTitle: String?
  let airDate: String
  let airTime: String?
  let network: String?
  let label: String?
}

struct UpcomingGroup: Decodable {
  let key: String
  let label: String
  let items: [UpcomingItem]
}

struct UpcomingResponse: Decodable {
  let groups: [UpcomingGroup]
}

struct RefreshResponse: Decodable {
  let accessToken: String
  let refreshToken: String
}

/// Localized strings pushed by the app (i18n) into the App Group container.
struct WidgetLabels {
  let watchNext: String
  let upcoming: String
  let today: String
  let tomorrow: String
  let thisWeek: String
  let emptyWatchNext: String
  let emptyUpcoming: String
  let signIn: String

  static let fallback = WidgetLabels(
    watchNext: "Watch Next",
    upcoming: "Upcoming",
    today: "Today",
    tomorrow: "Tomorrow",
    thisWeek: "This week",
    emptyWatchNext: "Your watch list is empty",
    emptyUpcoming: "No upcoming episodes",
    signIn: "Log in"
  )

  static func load(from defaults: UserDefaults?) -> WidgetLabels {
    guard
      let raw = defaults?.string(forKey: "widgetLabels"),
      let data = raw.data(using: .utf8),
      let dict = try? JSONDecoder().decode([String: String].self, from: data)
    else { return .fallback }
    return WidgetLabels(
      watchNext: dict["watchNext"] ?? fallback.watchNext,
      upcoming: dict["upcoming"] ?? fallback.upcoming,
      today: dict["today"] ?? fallback.today,
      tomorrow: dict["tomorrow"] ?? fallback.tomorrow,
      thisWeek: dict["thisWeek"] ?? fallback.thisWeek,
      emptyWatchNext: dict["emptyWatchNext"] ?? fallback.emptyWatchNext,
      emptyUpcoming: dict["emptyUpcoming"] ?? fallback.emptyUpcoming,
      signIn: dict["signIn"] ?? fallback.signIn
    )
  }

  func groupTitle(for key: String, fallback: String) -> String {
    switch key {
    case "TODAY": return today
    case "TOMORROW": return tomorrow
    case "THIS_WEEK": return thisWeek
    default: return fallback
    }
  }
}

func episodeCode(_ season: Int?, _ number: Int?, separator: String = " ") -> String {
  String(format: "S%02d\(separator)E%02d", season ?? 0, number ?? 0)
}

/// "Tue, Jul 21" in the device locale. Accepts ISO datetimes and bare yyyy-MM-dd dates.
func shortAirDate(_ airDate: String) -> String {
  let iso = ISO8601DateFormatter()
  var date = iso.date(from: airDate)
  if date == nil {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyy-MM-dd"
    date = f.date(from: airDate)
  }
  guard let d = date else { return airDate }
  let out = DateFormatter()
  out.locale = Locale.current
  out.setLocalizedDateFormatFromTemplate("EEE MMM d")
  return out.string(from: d)
}
