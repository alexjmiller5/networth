import Foundation

enum SnapshotError: Error { case invalid, storageUnavailable }
struct WidgetBalance: Codable, Identifiable, Equatable {
    enum Kind: String, Codable { case owed, credit, zero, unavailable }
    enum Availability: String, Codable { case verified, unavailable }
    let id: String
    let label: String
    let currency: String?
    let amount: String?
    let kind: Kind
    let asOf: String?
    let availability: Availability

    func displayAmount(concealed: Bool) -> String {
        if concealed { return String(localized: "Hidden") }
        guard let amount, let currency, availability == .verified else { return String(localized: "Unavailable") }
        return "\(currency) \(amount)"
    }
    func validate() throws {
        guard !id.isEmpty, id.count <= 256, !label.isEmpty, label.count <= 200 else { throw SnapshotError.invalid }
        if let asOf, parseSourceDate(asOf) == nil { throw SnapshotError.invalid }
        if let currency, currency.range(of: "^[A-Z]{3}$", options: .regularExpression) == nil { throw SnapshotError.invalid }
        if availability == .verified {
            guard currency != nil, asOf != nil, let amount,
                  amount.count <= 100,
                  amount.range(of: "^(0|[1-9][0-9]*)\\.[0-9]{2}$", options: .regularExpression) != nil,
                  kind != .unavailable, (amount == "0.00") == (kind == .zero) else { throw SnapshotError.invalid }
        } else if amount != nil || kind != .unavailable { throw SnapshotError.invalid }
    }
}
struct WidgetSnapshot: Codable, Equatable {
    let version: Int
    let fetchedAt: String
    let balances: [WidgetBalance]
    static func decode(_ data: Data) throws -> Self {
        guard data.count <= 2_000_000 else { throw SnapshotError.invalid }
        let snapshot = try JSONDecoder().decode(Self.self, from: data)
        guard snapshot.version == 1, parseSourceDate(snapshot.fetchedAt) != nil,
              snapshot.balances.count <= 1000,
              Set(snapshot.balances.map(\.id)).count == snapshot.balances.count else { throw SnapshotError.invalid }
        for balance in snapshot.balances { try balance.validate() }
        return snapshot
    }
}
func parseSourceDate(_ text: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = formatter.date(from: text) { return date }
    formatter.formatOptions = [.withInternetDateTime]
    if let date = formatter.date(from: text) { return date }
    let day = DateFormatter()
    day.locale = Locale(identifier: "en_US_POSIX")
    day.timeZone = TimeZone(secondsFromGMT: 0)
    day.dateFormat = "yyyy-MM-dd"
    day.isLenient = false
    guard let date = day.date(from: text), day.string(from: date) == text else { return nil }
    return date
}
struct SnapshotStore {
    let directory: URL
    static func shared() throws -> Self {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "NetworthAppGroup") as? String,
              let url = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { throw SnapshotError.storageUnavailable }
        return Self(directory: url)
    }
    private var file: URL { directory.appending(path: "snapshot.json") }
    func save(_ data: Data) throws {
        _ = try WidgetSnapshot.decode(data)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try data.write(to: file, options: [.atomic, .completeFileProtection])
        var url = file
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try url.setResourceValues(values)
    }
    func read() throws -> WidgetSnapshot? {
        guard FileManager.default.fileExists(atPath: file.path) else { return nil }
        return try WidgetSnapshot.decode(Data(contentsOf: file))
    }
    func clear() throws {
        if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
    }
}
struct ServiceEndpoint: Equatable {
    let origin: URL
    init(_ value: String) throws {
        guard var parts = URLComponents(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
              parts.scheme == "https", let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/" else { throw SnapshotError.invalid }
        parts.path = ""
        guard let url = parts.url else { throw SnapshotError.invalid }
        origin = url
    }
}
