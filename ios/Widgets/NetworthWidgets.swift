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
                WidgetContent(snapshot:snapshot,view:entry.view,concealed:entry.concealed,rowLimit:family == .systemSmall ? 1 : family == .systemLarge ? 6 : 3)
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
        switch view {
        case .balances, .freshness: BalanceRows(snapshot:snapshot,view:view,concealed:concealed,rowLimit:rowLimit)
        case .guidance: GuidanceRows(guidance:snapshot.guidance,loaded:snapshot.rewards != nil,concealed:concealed,rowLimit:rowLimit)
        case .caps: CapRows(caps:snapshot.caps,concealed:concealed,rowLimit:rowLimit)
        case .rewards: RewardRows(rewards:snapshot.rewards,concealed:concealed,rowLimit:rowLimit)
        case .expiry: ExpiryRows(clocks:snapshot.expiry,today:String(snapshot.fetchedAt.prefix(10)),rowLimit:rowLimit)
        }
    }
}
struct Unavailable: View {
    let title: LocalizedStringKey
    let detail: LocalizedStringKey
    var body:some View {
        Text(title).font(.headline)
        Text(detail).font(.caption).foregroundStyle(.secondary)
    }
}
struct BalanceRows: View {
    let snapshot:WidgetSnapshot
    let view:WidgetViewKind
    let concealed:Bool
    let rowLimit:Int
    var body:some View {
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
    }
}
/** Which card per category this quarter. A card without verified terms is "unknown", never guessed. */
struct GuidanceRows: View {
    let guidance:WidgetGuidance?
    let loaded:Bool
    let concealed:Bool
    let rowLimit:Int
    var body:some View {
        Text("Which card?").font(.caption).foregroundStyle(.tint)
        if let guidance {
            if guidance.categories.isEmpty {
                Unavailable(title:"No card spend yet",detail:"No categorized card purchases this quarter.")
            }
            ForEach(Array(guidance.categories.prefix(rowLimit))) { category in
                VStack(alignment:.leading,spacing:2) {
                    HStack(alignment:.firstTextBaseline) {
                        Text(category.category).font(.subheadline.weight(.semibold)).lineLimit(1)
                        Spacer(minLength:4)
                        Text(category.displaySpent(concealed:concealed)).font(.caption2).monospacedDigit().foregroundStyle(.secondary)
                    }
                    if let card=category.pickedCard {
                        Text("\(card.label) · \(card.displayRate)").font(.caption).lineLimit(1).minimumScaleFactor(0.8)
                    } else if category.unknownCount > 0 {
                        Text("Unknown for \(category.unknownCount) of \(category.cards.count) cards").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    } else {
                        Text("No single best card").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        } else {
            Unavailable(title:"Unavailable",detail:loaded ? "Card categories could not be read." : "Open Networth to load reward rules.")
        }
    }
}
struct CapRows: View {
    let caps:[WidgetCap]?
    let concealed:Bool
    let rowLimit:Int
    var body:some View {
        Text("Cap headroom").font(.caption).foregroundStyle(.secondary)
        if let caps {
            if caps.isEmpty { Unavailable(title:"No caps",detail:"No published cap terms apply to your programs.") }
            ForEach(Array(caps.prefix(rowLimit))) { cap in
                VStack(alignment:.leading,spacing:3) {
                    Text(cap.program).font(.caption).lineLimit(1)
                    Text(cap.displayRemaining(concealed:concealed)).font(.headline).monospacedDigit().lineLimit(1).minimumScaleFactor(0.7)
                    if let fraction=cap.usedFraction { ProgressView(value:fraction).accessibilityLabel("Share of cap used") }
                    Text(cap.resetLabel ?? cap.reason ?? "").font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                }
            }
        } else { Unavailable(title:"Unavailable",detail:"Open Networth to load reward rules.") }
    }
}
struct RewardRows: View {
    let rewards:[WidgetReward]?
    let concealed:Bool
    let rowLimit:Int
    var body:some View {
        Text("Available rewards").font(.caption).foregroundStyle(.secondary)
        if let rewards {
            if rewards.isEmpty { Unavailable(title:"None observed",detail:"No reward balances have been captured.") }
            ForEach(Array(rewards.prefix(rowLimit))) { reward in
                VStack(alignment:.leading,spacing:2) {
                    Text(reward.program).font(.caption).lineLimit(1)
                    HStack(alignment:.firstTextBaseline) {
                        Text(reward.displayAmount(concealed:concealed)).font(.headline).monospacedDigit().lineLimit(1).minimumScaleFactor(0.7)
                        if let value=reward.displayValue(concealed:concealed) {
                            Spacer(minLength:4)
                            Text(value).font(.caption).monospacedDigit().foregroundStyle(.secondary)
                        }
                    }
                    Text(reward.sourceLabel).font(.caption2).foregroundStyle(.secondary)
                }
            }
        } else { Unavailable(title:"Unavailable",detail:"Open Networth to load reward balances.") }
    }
}
struct ExpiryRows: View {
    let clocks:[WidgetExpiry]?
    let today:String
    let rowLimit:Int
    var body:some View {
        Text("Rewards expiring").font(.caption).foregroundStyle(.secondary)
        if let clocks {
            if clocks.isEmpty { Unavailable(title:"Nothing tracked",detail:"No reward units are recorded.") }
            ForEach(Array(clocks.prefix(rowLimit))) { clock in
                VStack(alignment:.leading,spacing:2) {
                    HStack(alignment:.firstTextBaseline) {
                        Text(clock.program).font(.caption).lineLimit(1)
                        Spacer(minLength:4)
                        Text(clock.headline(today:today)).font(.subheadline.weight(.semibold)).lineLimit(1)
                    }
                    Text(clock.detail).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
            }
        } else { Unavailable(title:"Unavailable",detail:"Open Networth to load reward rules.") }
    }
}
@main struct NetworthWidgets: Widget {
    var body:some WidgetConfiguration {
        AppIntentConfiguration(kind:"networth",intent:WidgetConfigurationIntent.self,provider:NetworthProvider()) { entry in NetworthWidgetView(entry:entry) }
            .configurationDisplayName("Networth")
            .description("Card balances, source dates, card guidance, caps, rewards and expiry from your saved snapshot.")
            .supportedFamilies([.systemSmall,.systemMedium,.systemLarge])
    }
}
#Preview(as:.systemMedium) { NetworthWidgets() } timeline: { NetworthEntry(date:Date(),snapshot:nil,concealed:true,view:.balances) }
