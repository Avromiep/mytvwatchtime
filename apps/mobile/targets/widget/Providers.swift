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

  private func maxRows(for family: WidgetFamily) -> Int {
    family == .systemLarge ? 7 : 3
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
      var rows: [WatchNextRowModel] = []
      for item in items {
        let image = await api.loadImage(item.episode.stillUrl ?? item.backdropUrl)
        rows.append(WatchNextRowModel(item: item, image: image))
      }
      return WatchNextEntry(date: Date(), rows: rows, labels: labels, signedOut: false)
    } catch WidgetAPIError.notSignedIn {
      return WatchNextEntry(date: Date(), rows: [], labels: labels, signedOut: true)
    } catch {
      return WatchNextEntry(date: Date(), rows: [], labels: labels, signedOut: false)
    }
  }
}

struct UpcomingProvider: TimelineProvider {
  private static let wantedKeys = ["TODAY", "TOMORROW", "THIS_WEEK"]

  func placeholder(in context: Context) -> UpcomingEntry {
    UpcomingEntry(date: Date(), sections: [], labels: .fallback, signedOut: false)
  }

  func getSnapshot(in context: Context, completion: @escaping (UpcomingEntry) -> Void) {
    Task { completion(await load(maxRows: maxRows(for: context.family))) }
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<UpcomingEntry>) -> Void) {
    Task {
      let entry = await load(maxRows: maxRows(for: context.family))
      completion(Timeline(entries: [entry], policy: .after(refreshDate())))
    }
  }

  private func maxRows(for family: WidgetFamily) -> Int {
    family == .systemLarge ? 8 : 3
  }

  private func load(maxRows: Int) async -> UpcomingEntry {
    let api = WidgetAPI.shared
    let labels = api.labels
    do {
      let data = try await api.fetch(path: "/me/upcoming", cacheKey: "cache.upcoming")
      let decoded = try JSONDecoder().decode(UpcomingResponse.self, from: data)
      let groups = decoded.groups.filter { Self.wantedKeys.contains($0.key) && !$0.items.isEmpty }
      var remaining = maxRows
      var sections: [UpcomingSectionModel] = []
      for group in groups where remaining > 0 {
        var rows: [UpcomingRowModel] = []
        for item in group.items.prefix(remaining) {
          let image = await api.loadImage(item.posterUrl)
          rows.append(UpcomingRowModel(item: item, image: image))
        }
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
