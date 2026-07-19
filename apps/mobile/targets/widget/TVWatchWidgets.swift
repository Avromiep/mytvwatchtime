import SwiftUI
import WidgetKit

@main
struct TVWatchWidgetBundle: WidgetBundle {
  var body: some Widget {
    WatchNextWidget()
    UpcomingWidget()
  }
}
