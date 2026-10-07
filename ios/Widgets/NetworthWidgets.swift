import AppIntents
import SwiftUI
import WidgetKit

enum WidgetViewKind: String, AppEnum, CaseIterable {
    case balances = "balances", guidance = "guidance", caps = "caps", rewards = "rewards", expiry = "expiry", freshness = "freshness"
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "View"
    static let caseDisplayRepresentations: [Self:DisplayRepresentation] = [
        .balances:"Card balances",.guidance:"Which card?",.caps:"Cap headroom",.rewards:"Rewards",.expiry:"Expiry",.freshness:"Account freshness"
    ]
}
struct WidgetConfigurationIntent: AppIntents.WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "Networth widget"
    static let description = IntentDescription("Choose a saved balance, reward or source view.")
    @Parameter(title:"View",default:.balances) var view: WidgetViewKind
}
struct NetworthEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot?
    let concealed: Bool
    let view: WidgetViewKind
}
struct NetworthProvider: AppIntentTimelineProvider {
    func placeholder(in context:Context) -> NetworthEntry { NetworthEntry(date:Date(),snapshot:nil,concealed:true,view:.balances) }
    func snapshot(for configuration:WidgetConfigurationIntent,in context:Context) async -> NetworthEntry { load(configuration.view) }
    func timeline(for configuration:WidgetConfigurationIntent,in context:Context) async -> Timeline<NetworthEntry> {
        let entry=load(configuration.view)
        return Timeline(entries:[entry],policy:.after(entry.date.addingTimeInterval(3600)))
    }
    private func load(_ view:WidgetViewKind) -> NetworthEntry {
        let group=Bundle.main.object(forInfoDictionaryKey:"NetworthAppGroup") as? String
        let concealed=group.flatMap { UserDefaults(suiteName:$0) }?.bool(forKey:"concealed") ?? true
        // No credential or network client is linked into the extension.
        let snapshot=try? SnapshotStore.shared().read()
        return NetworthEntry(date:Date(),snapshot:snapshot,concealed:concealed,view:view)
    }
}
struct NetworthWidgetView: View {
    let entry: NetworthEntry
    @Environment(\.widgetFamily) private var family
    var body:some View {
        VStack(alignment:.leading,spacing:10) {
            Text("Networth").font(.caption).foregroundStyle(.secondary)
            if let snapshot=entry.snapshot {
                WidgetContent(snapshot:snapshot,view:entry.view,concealed:entry.concealed,rowLimit:family == .systemSmall ? 1 : 3)
                Spacer(minLength:0)
                if let fetched=parseSourceDate(snapshot.fetchedAt) {
                    Text("Saved \(fetched.formatted(date:.abbreviated,time:.shortened))").font(.caption2).foregroundStyle(.secondary)
                }
            } else {
                Text("Open Networth").font(.headline)
                Text("Connect or unlock your phone to load a saved snapshot.").font(.caption).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth:.infinity,maxHeight:.infinity,alignment:.topLeading)
        .containerBackground(.background,for:.widget)
        .widgetURL(URL(string:"networth://widget/\(entry.view.rawValue)"))
        .privacySensitive()
    }
}
struct WidgetContent: View {
    let snapshot:WidgetSnapshot
    let view:WidgetViewKind
    let concealed:Bool
    let rowLimit:Int
    var body:some View {
        if view == .balances || view == .freshness {
            ForEach(Array(snapshot.balances.prefix(rowLimit))) { balance in
                VStack(alignment:.leading,spacing:3) {
                    Text(balance.label).font(.caption).lineLimit(1)
                    if view == .balances {
                        Text(balance.displayAmount(concealed:concealed)).font(.headline).monospacedDigit().minimumScaleFactor(0.7).lineLimit(1)
                        Text(balance.kind == .owed ? "Owed" : balance.kind == .credit ? "Credit" : balance.kind == .zero ? "Verified zero" : "Unavailable").font(.caption2).foregroundStyle(.secondary)
                    }
                    if let source=balance.asOf,let date=parseSourceDate(source) {
                        Text(date,format:.dateTime.month().day().year()).font(.caption2).foregroundStyle(.secondary)
                    } else { Text("No source date").font(.caption2).foregroundStyle(.secondary) }
                }
            }
            if snapshot.balances.isEmpty { Text("No card balances available").font(.caption) }
        } else {
            Text(view == .guidance ? "Which card?" : view == .caps ? "Cap headroom" : view == .rewards ? "Rewards" : "Expiry").font(.headline)
            Text("Unavailable").font(.subheadline)
            Text("Verified rules and source history are needed for this view.").font(.caption).foregroundStyle(.secondary)
        }
    }
}
@main struct NetworthWidgets: Widget {
    var body:some WidgetConfiguration {
        AppIntentConfiguration(kind:"networth",intent:WidgetConfigurationIntent.self,provider:NetworthProvider()) { entry in NetworthWidgetView(entry:entry) }
            .configurationDisplayName("Networth")
            .description("Card balances, source dates and reward views from your saved snapshot.")
            .supportedFamilies([.systemSmall,.systemMedium,.systemLarge])
    }
}
#Preview(as:.systemMedium) { NetworthWidgets() } timeline: { NetworthEntry(date:Date(),snapshot:nil,concealed:true,view:.balances) }
