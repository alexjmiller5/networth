import Foundation
import Observation
import WidgetKit

@MainActor @Observable final class DashboardModel {
    var endpoint = ""
    var deviceName = "My phone"
    var enrollment: DeviceEnrollment?
    var snapshot: WidgetSnapshot?
    var state: DeviceStatus.State?
    var message = ""
    var busy = false
    var concealed: Bool {
        didSet { preferences?.set(concealed,forKey:"concealed"); WidgetCenter.shared.reloadAllTimelines() }
    }
    private let credentials: EnrollmentStore
    private let client: DeviceClient
    private let snapshots: SnapshotStore?
    private let preferences: UserDefaults?
    init(credentials: EnrollmentStore = EnrollmentStore(), client: DeviceClient = DeviceClient(), snapshots: SnapshotStore? = try? .shared()) {
        self.credentials=credentials; self.client=client; self.snapshots=snapshots
        let group=Bundle.main.object(forInfoDictionaryKey:"NetworthAppGroup") as? String
        preferences=group.flatMap { UserDefaults(suiteName:$0) }
        concealed=preferences?.bool(forKey:"concealed") ?? false
        do {
            enrollment=try credentials.read()
            if let enrollment { endpoint=enrollment.origin; deviceName=enrollment.label; snapshot=try snapshots?.read() }
        } catch { message=error.localizedDescription }
    }
    func beginEnrollment() -> URL? {
        guard !busy else { return nil }
        do {
            if let enrollment, state != .expired && state != .revoked { return enrollment.approvalURL }
            let candidate=try DeviceEnrollment(origin:endpoint,label:deviceName)
            try snapshots?.clear()
            try credentials.save(candidate)
            enrollment=candidate; snapshot=nil; state = .pending
            WidgetCenter.shared.reloadAllTimelines()
            message=String(localized:"Compare the connection code, then approve this device in the browser.")
            return candidate.approvalURL
        } catch { message=error.localizedDescription; return nil }
    }
    func refresh() async {
        guard let enrollment, !busy else { return }
        busy=true
        defer { busy=false }
        do {
            let status=try await client.status(enrollment)
            state=status.state
            if status.state == .revoked || status.state == .expired {
                try snapshots?.clear(); snapshot=nil
                WidgetCenter.shared.reloadAllTimelines()
                message=String(localized:"This connection is no longer active. Start a new enrollment.")
                return
            }
            guard status.state == .active else { message=String(localized:"Waiting for browser approval."); return }
            let data=try await client.snapshot(enrollment)
            guard let snapshots else { throw SnapshotError.storageUnavailable }
            try snapshots.save(data)
            snapshot=try WidgetSnapshot.decode(data)
            message=String(localized:"Snapshot updated. Account dates show when each source was verified.")
            WidgetCenter.shared.reloadAllTimelines()
        } catch {
            if case DeviceError.unauthorized = error {
                // An un-staged pending request also returns 401; it grants no access.
                if snapshot != nil { try? snapshots?.clear(); snapshot=nil; WidgetCenter.shared.reloadAllTimelines() }
            }
            message=error.localizedDescription
        }
    }
    func disconnect() async {
        guard let enrollment, !busy else { return }
        busy=true
        defer { busy=false }
        do {
            try await client.revoke(enrollment)
            try snapshots?.clear()
            try credentials.remove()
            self.enrollment=nil; snapshot=nil; state=nil
            WidgetCenter.shared.reloadAllTimelines()
            message=String(localized:"Device disconnected.")
        } catch { message=error.localizedDescription }
    }
}
