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
    private var rowLimit: Int {
        switch family {
        case .systemSmall: return 1
        case .systemLarge: return entry.view == .caps ? 4 : 6
        default: return entry.view == .caps ? 1 : 2
        }
    }
    var body:some View {
        VStack(alignment:.leading,spacing:10) {
            Text("Networth").font(.caption).foregroundStyle(.secondary)
            if let snapshot=entry.snapshot {
                // Rows fill the space between the fixed header and footer and clip at the bottom,
                // so a long list never pushes the title or the saved time out of the widget.
                VStack(alignment:.leading,spacing:8) {
                    WidgetContent(snapshot:snapshot,view:entry.view,concealed:entry.concealed,rowLimit:rowLimit,today:entry.date)
                }
                .frame(maxWidth:.infinity,maxHeight:.infinity,alignment:.topLeading)
                .clipped()
                if let fetched=parseSourceDate(snapshot.fetchedAt) {
                    Text("Saved \(fetched.formatted(family == .systemSmall ? .dateTime.month(.abbreviated).day().hour().minute() : .dateTime.month(.abbreviated).day().year().hour().minute()))").font(.caption2).foregroundStyle(.secondary).lineLimit(1)
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
    var today=Date()
    var body:some View {
        switch view {
        case .balances, .freshness: BalanceRows(snapshot:snapshot,view:view,concealed:concealed,rowLimit:rowLimit)
        case .guidance: GuidanceRows(guidance:snapshot.guidance,loaded:snapshot.rewards != nil,concealed:concealed,rowLimit:rowLimit)
        case .caps: CapRows(caps:snapshot.caps,concealed:concealed,rowLimit:rowLimit)
        case .rewards: RewardRows(rewards:snapshot.rewards,concealed:concealed,rowLimit:rowLimit)
        case .expiry: ExpiryRows(clocks:snapshot.expiry,today:today,rowLimit:rowLimit)
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
/** Two facts side by side when they fit, stacked when they do not (small widgets, long names). */
struct Pair<Leading: View, Trailing: View>: View {
    let leading: Leading
    let trailing: Trailing
    init(@ViewBuilder leading: () -> Leading, @ViewBuilder trailing: () -> Trailing) {
        self.leading = leading(); self.trailing = trailing()
    }
    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment:.firstTextBaseline) { leading; Spacer(minLength:4); trailing }
            VStack(alignment:.leading,spacing:1) { leading; trailing }
        }
    }
}
struct ViewTitle: View {
    let text: LocalizedStringKey
    var body:some View { Text(text).font(.caption.weight(.semibold)).foregroundStyle(.secondary) }
}
struct BalanceRows: View {
    let snapshot:WidgetSnapshot
    let view:WidgetViewKind
    let concealed:Bool
    let rowLimit:Int
    var body:some View {
        ViewTitle(text:view == .balances ? "Card balances" : "Account freshness")
        ForEach(Array(snapshot.balances.prefix(rowLimit))) { balance in
            let source=balance.asOf.flatMap(parseSourceDate).map { $0.formatted(.dateTime.month().day().year()) } ?? String(localized:"No source date")
            VStack(alignment:.leading,spacing:2) {
                Pair {
                    Text(balance.label).font(.caption).lineLimit(1)
                } trailing: {
                    if view == .balances {
                        Text(balance.displayAmount(concealed:concealed)).font(.subheadline.weight(.semibold)).monospacedDigit().lineLimit(1).minimumScaleFactor(0.7)
                    }
                }
                if view == .balances {
                    let kind=balance.kind == .owed ? String(localized:"Owed") : balance.kind == .credit ? String(localized:"Credit") : balance.kind == .zero ? String(localized:"Verified zero") : String(localized:"Unavailable")
                    Text("\(kind) · \(source)").font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                } else {
                    Text(source).font(.caption2).foregroundStyle(.secondary)
                }
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
        ViewTitle(text:"Which card?")
        if let guidance {
            if guidance.categories.isEmpty {
                Unavailable(title:"No card spend yet",detail:"No categorized card purchases this quarter.")
            }
            ForEach(Array(guidance.categories.prefix(rowLimit))) { category in
                VStack(alignment:.leading,spacing:2) {
                    Pair {
                        Text(category.category).font(.subheadline.weight(.semibold)).lineLimit(1)
                    } trailing: {
                        Text(category.displaySpent(concealed:concealed)).font(.caption2).monospacedDigit().foregroundStyle(.secondary)
                    }
                    if let card=category.pickedCard {
                        Text("\(card.label) · \(card.displayRate)").font(.caption).lineLimit(1)
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
        ViewTitle(text:"Cap headroom")
        if let caps {
            if caps.isEmpty { Unavailable(title:"No caps",detail:"No published cap terms apply to your programs.") }
            ForEach(Array(caps.prefix(rowLimit))) { cap in
                VStack(alignment:.leading,spacing:5) {
                    Pair {
                        Text(cap.program).font(.caption).lineLimit(1)
                    } trailing: {
                        Text(cap.displayRemaining(concealed:concealed)).font(.subheadline.weight(.semibold)).monospacedDigit().lineLimit(1).minimumScaleFactor(0.7)
                    }
                    if let fraction=cap.usedFraction { ProgressView(value:fraction).accessibilityLabel("Share of cap used") }
                    Text(cap.resetLabel ?? cap.reason ?? "").font(.caption2).foregroundStyle(.secondary).lineLimit(1)
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
        ViewTitle(text:"Available rewards")
        if let rewards {
            if rewards.isEmpty { Unavailable(title:"None observed",detail:"No reward balances have been captured.") }
            ForEach(Array(rewards.prefix(rowLimit))) { reward in
                VStack(alignment:.leading,spacing:2) {
                    Pair {
                        Text(reward.program).font(.caption).lineLimit(1)
                    } trailing: {
                        Text(reward.sourceLabel).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Pair {
                        Text(reward.displayAmount(concealed:concealed)).font(.subheadline.weight(.semibold)).monospacedDigit().lineLimit(1).minimumScaleFactor(0.7)
                    } trailing: {
                        if !concealed, let value=reward.displayValue(concealed:concealed) {
                            Text(value).font(.caption).monospacedDigit().foregroundStyle(.secondary)
                        }
                    }
                }
            }
        } else { Unavailable(title:"Unavailable",detail:"Open Networth to load reward balances.") }
    }
}
struct ExpiryRows: View {
    let clocks:[WidgetExpiry]?
    let today:Date
    let rowLimit:Int
    var body:some View {
        ViewTitle(text:"Rewards expiring")
        if let clocks {
            if clocks.isEmpty { Unavailable(title:"Nothing tracked",detail:"No reward units are recorded.") }
            // One summary instead of a wall of identical unknowns; a dated clock always lists.
            if !clocks.isEmpty && clocks.allSatisfy({ $0.status == .unknown }) {
                Unavailable(title:"Unknown",detail:"None of your \(clocks.count) reward units has a stated deadline or qualifying activity date yet.")
            } else {
            ForEach(Array(clocks.prefix(rowLimit))) { clock in
                VStack(alignment:.leading,spacing:2) {
                    Pair {
                        Text(clock.program).font(.caption).lineLimit(1)
                    } trailing: {
                        Text(clock.headline(today:today)).font(.subheadline.weight(.semibold)).lineLimit(1)
                    }
                    Text(clock.detail).font(.caption2).foregroundStyle(.secondary).lineLimit(clock.status == .unknown ? 2 : 1)
                }
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
