import SwiftUI

@main struct NetworthApp: App {
    @State private var model=DashboardModel()
    var body: some Scene {
        WindowGroup { DashboardView(model:model) }
    }
}
struct DashboardView: View {
    @Bindable var model: DashboardModel
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @State private var confirmingDisconnect=false
    var body: some View {
        NavigationStack {
            Form {
                if let enrollment=model.enrollment {
                    Section("Connection") {
                        LabeledContent("Device",value:enrollment.label)
                        LabeledContent("Status",value:model.state?.rawValue.capitalized ?? "Checking")
                        if model.busy {
                            ProgressView(model.state == .active ? "Loading card balances…" : "Checking device approval…")
                        }
                        if model.state != .active {
                            LabeledContent("Connection code",value:String(enrollment.fingerprint.prefix(8)).uppercased()).monospaced()
                            Button("Open approval page") { if let url=model.beginEnrollment() { openURL(url) } }
                        }
                        Button("Refresh snapshot") { Task { await model.refresh() } }.disabled(model.busy)
                        Button("Disconnect device",role:.destructive) { confirmingDisconnect=true }.disabled(model.busy)
                    }
                } else {
                    Section("Connect your dashboard") {
                        TextField("Dashboard URL",text:$model.endpoint).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                        TextField("Device name",text:$model.deviceName)
                        Button("Connect") { if let url=model.beginEnrollment() { openURL(url) } }
                        Text("Use your Networth dashboard address. Approve this phone in the browser; no administrator credential is needed.").font(.footnote).foregroundStyle(.secondary)
                    }
                }
                if !model.message.isEmpty { Section { Text(model.message).font(.footnote).accessibilityLabel(model.message) } }
                Section("Privacy") { Toggle("Hide amounts",isOn:$model.concealed) }
                if let snapshot=model.snapshot {
                    BalanceSection(balances:snapshot.balances,concealed:model.concealed)
                    Section("Snapshot") {
                        if let date=parseSourceDate(snapshot.fetchedAt) { LabeledContent("Fetched",value:date.formatted(date:.abbreviated,time:.shortened)) }
                        Text("Widgets show saved data. Open this app to refresh; account source dates may be older than the fetch time.").font(.footnote).foregroundStyle(.secondary)
                    }
                }
                Section("Widget options") {
                    Text("Add Networth from your Home Screen’s widget picker. Choose balances or freshness. Card guidance, cap headroom, rewards and expiry require verified source rules and are shown as unavailable until supported.").font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Networth")
            .task { await model.refresh() }
            .onChange(of:scenePhase) { _,phase in if phase == .active { Task { await model.refresh() } } }
            .confirmationDialog("Disconnect this device?",isPresented:$confirmingDisconnect,titleVisibility:.visible) {
                Button("Disconnect",role:.destructive) { Task { await model.disconnect() } }
            } message: { Text("This revokes the phone’s access and removes its saved widget snapshot.") }
        }
    }
}
struct BalanceSection: View {
    let balances:[WidgetBalance]
    let concealed:Bool
    var body:some View {
        Section("Card balances") {
            ForEach(balances) { balance in
                VStack(alignment:.leading,spacing:5) {
                    LabeledContent(balance.label,value:balance.displayAmount(concealed:concealed)).monospacedDigit().privacySensitive()
                    HStack {
                        Text(balance.kind == .owed ? "Balance owed" : balance.kind == .credit ? "Credit" : balance.kind == .zero ? "Verified zero" : "Unavailable")
                        Spacer()
                        if let source=balance.asOf,let date=parseSourceDate(source) { Text(date,format:.dateTime.month().day().year()) }
                    }.font(.caption).foregroundStyle(.secondary)
                }
            }
            if balances.isEmpty { Text("No open credit cards in this snapshot.").foregroundStyle(.secondary) }
        }
    }
}
