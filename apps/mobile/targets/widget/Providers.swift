import Foundation
import UIKit
import WidgetKit

// MARK: - Entries

struct WatchNextRowModel: Identifiable {
  let item: WatchNextItem
  let image: UIImage?
  var id: String { item.id }
}

struct WatchNextEntry: TimelineEntry {
  let date: Date
  let rows: [WatchNextRowModel]
  let labels: WidgetLabels
  let signedOut: Bool
}

struct UpcomingRowModel: Identifiable {
  let item: UpcomingItem
  let image: UIImage?
  var id: String { item.id }
}

struct UpcomingSectionModel: Identifiable {
  let key: String
  let title: String
  let rows: [UpcomingRowModel]
  var id: String { key }
}

struct UpcomingEntry: TimelineEntry {
  let date: Date
  let sections: [UpcomingSectionModel]
  let labels: WidgetLabels
  let signedOut: Bool
}

// MARK: - Loading

private func refreshDate() -> Date {
  Calendar.current.date(byAdding: .minute, value: 30, to: Date()) ?? Date().addingTimeInterval(1800)
}

/// Download all images concurrently (a timeline build is time-budgeted, sequential
/// awaits blow it) and return them keyed by row id, preserving input order.
private func downloadImages<T: Identifiable>(
  for items: [T],
  url: (T) -> String?
) async -> [T.ID: UIImage] where T.ID: Hashable {
  await withTaskGroup(of: (T.ID, UIImage?).self) { group in
    for item in items {
      group.addTask { (item.id, await WidgetAPI.shared.loadImage(url(item))) }
    }
    var map: [T.ID: UIImage] = [:]
    for await (id, image) in group {
      if let image { map[id] = image }
    }
    return map
  }
}

struct WatchNextProvider: TimelineProvider {
  func placeholder(in context: Context) -> WatchNextEntry {
    WatchNextEntry(date: Date(), rows: [], labels: .fallback, signedOut: false)
  }

  func getSnapshot(in context: Context, completion: @escaping (WatchNextEntry) -> Void) {
    Task { completion(await load(maxRows: maxRows(for: context.family))) }
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<WatchNextEntry>) -> Void) {
    Task {
      let entry = await load(maxRows: maxRows(for: context.family))
      completion(Timeline(entries: [entry], policy: .after(refreshDate())))
    }
  }

  /// Rows are ~62pt + spacing; systemMedium (~158-184pt) fits the title + 2 rows,
  /// systemLarge up to 7.
  private func maxRows(for family: WidgetFamily) -> Int {
    family == .systemLarge ? 7 : 2
  }

  private func load(maxRows: Int) async -> WatchNextEntry {
    let api = WidgetAPI.shared
    let labels = api.labels
    do {
      let data = try await api.fetch(path: "/me/watch-next", cacheKey: "cache.watchNext")
      let decoded = try JSONDecoder().decode(WatchNextResponse.self, from: data)
      var seen = Set<String>()
      let items = decoded.items.filter { item in
        guard item.bucket == "WATCH_NEXT", !seen.contains(item.episode.id) else { return false }
        seen.insert(item.episode.id)
        return true
      }.prefix(maxRows)
      api.pruneImageCache()
      let images = await downloadImages(for: Array(items)) { $0.episode.stillUrl ?? $0.backdropUrl }
      let rows = items.map { WatchNextRowModel(item: $0, image: images[$0.id]) }
      return WatchNextEntry(date: Date(), rows: rows, labels: labels, signedOut: false)
    } catch WidgetAPIError.notSignedIn {
      return WatchNextEntry(date: Date(), rows: [], labels: labels, signedOut: true)
    } catch {
      return WatchNextEntry(date: Date(), rows: [], labels: labels, signedOut: false)
    }
  }
}

struct UpcomingProvider: TimelineProvider {
  // Keep in sync with UPCOMING_NEAR_TERM_BUCKETS in packages/shared/src/enums.ts.
  private static let wantedKeys = ["TODAY", "TOMORROW", "THIS_WEEK"]

  func placeholder(in context: Context) -> UpcomingEntry {
    UpcomingEntry(date: Date(), sections: [], labels: .fallback, signedOut: false)
  }

  func getSnapshot(in context: Context, completion: @escaping (UpcomingEntry) -> Void) {
    Task { completion(await load(budget: budget(for: context.family))) }
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<UpcomingEntry>) -> Void) {
    Task {
      let entry = await load(budget: budget(for: context.family))
      completion(Timeline(entries: [entry], policy: .after(refreshDate())))
    }
  }

  /// Budget in row units; each section header also costs 1 unit (rows ~68pt,
  /// headers ~16pt, so a header roughly costs a row of vertical space).
  /// systemMedium: title + 1 section with 2 rows. systemLarge: up to 3 sections + 8 rows.
  private func budget(for family: WidgetFamily) -> Int {
    family == .systemLarge ? 11 : 3
  }

  private func load(budget: Int) async -> UpcomingEntry {
    let api = WidgetAPI.shared
    let labels = api.labels
    do {
      let data = try await api.fetch(path: "/me/upcoming", cacheKey: "cache.upcoming")
      let decoded = try JSONDecoder().decode(UpcomingResponse.self, from: data)
      let groups = decoded.groups.filter { Self.wantedKeys.contains($0.key) && !$0.items.isEmpty }
      var remaining = budget
      var sections: [UpcomingSectionModel] = []
      api.pruneImageCache()
      for group in groups where remaining >= 2 { // header + at least one row must fit
        remaining -= 1 // section header
        let items = Array(group.items.prefix(remaining))
        if items.isEmpty { break }
        let images = await downloadImages(for: items) { $0.posterUrl }
        let rows = items.map { UpcomingRowModel(item: $0, image: images[$0.id]) }
        sections.append(UpcomingSectionModel(
          key: group.key,
          title: labels.groupTitle(for: group.key, fallback: group.label),
          rows: rows
        ))
        remaining -= rows.count
      }
      return UpcomingEntry(date: Date(), sections: sections, labels: labels, signedOut: false)
    } catch WidgetAPIError.notSignedIn {
      return UpcomingEntry(date: Date(), sections: [], labels: labels, signedOut: true)
    } catch {
      return UpcomingEntry(date: Date(), sections: [], labels: labels, signedOut: false)
    }
  }
}
