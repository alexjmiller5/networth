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
    // Optional within version 1: absent in older snapshots or when reward sources failed.
    var rewards: [WidgetReward]? = nil
    var expiry: [WidgetExpiry]? = nil
    var caps: [WidgetCap]? = nil
    var guidance: WidgetGuidance? = nil
    static func decode(_ data: Data) throws -> Self {
        guard data.count <= 2_000_000 else { throw SnapshotError.invalid }
        let snapshot = try JSONDecoder().decode(Self.self, from: data)
        guard snapshot.version == 1, parseSourceDate(snapshot.fetchedAt) != nil,
              snapshot.balances.count <= 1000,
              Set(snapshot.balances.map(\.id)).count == snapshot.balances.count else { throw SnapshotError.invalid }
        for balance in snapshot.balances { try balance.validate() }
        try unique(snapshot.rewards); try unique(snapshot.expiry); try unique(snapshot.caps)
        for reward in snapshot.rewards ?? [] { try reward.validate() }
        for clock in snapshot.expiry ?? [] { try clock.validate() }
        for cap in snapshot.caps ?? [] { try cap.validate() }
        try snapshot.guidance?.validate()
        return snapshot
    }
}
private func unique<T: Identifiable>(_ rows: [T]?) throws where T.ID == String {
    guard let rows else { return }
    guard rows.count <= 1000, Set(rows.map(\.id)).count == rows.count else { throw SnapshotError.invalid }
}
/** Canonical decimal text, the server's exact grammar: no exponent, no trailing zeros, no -0. */
func isCanonicalDecimal(_ text: String?, allowNegative: Bool = false) -> Bool {
    guard let text, text.count <= 102, text != "-0" else { return false }
    let pattern = allowNegative ? "^-?(0|[1-9][0-9]*)(\\.[0-9]*[1-9])?$" : "^(0|[1-9][0-9]*)(\\.[0-9]*[1-9])?$"
    return text.range(of: pattern, options: .regularExpression) != nil
}
private func label(_ text: String, max: Int = 200) -> Bool { !text.isEmpty && text.count <= max }
/** Grouped display of exact decimal text; dollars pad to cents. Display only, never arithmetic. */
func displayDecimal(_ text: String, unit: String) -> String {
    let negative = text.hasPrefix("-")
    let parts = text.drop(while: { $0 == "-" }).split(separator: ".", omittingEmptySubsequences: false)
    var whole = String(parts[0])
    var grouped = ""
    while whole.count > 3 { grouped = "," + whole.suffix(3) + grouped; whole.removeLast(3) }
    grouped = whole + grouped
    var fraction = parts.count > 1 ? String(parts[1]) : ""
    if unit == "USD" {
        while fraction.count < 2 { fraction += "0" }
        return (negative ? "-$" : "$") + grouped + "." + fraction
    }
    return (negative ? "-" : "") + grouped + (fraction.isEmpty ? "" : "." + fraction) + " " + unit
}
private func shortDate(_ text: String) -> String {
    guard let date = parseSourceDate(text) else { return text }
    var style = Date.FormatStyle.dateTime.month(.abbreviated).day()
    if text.count == 10 { style.timeZone = TimeZone(secondsFromGMT: 0)! }
    return date.formatted(style)
}
struct WidgetReward: Codable, Identifiable, Equatable {
    let id, program, label, unit, amount, asOf: String
    /** True when the amount is the latest capture rather than a source-dated balance. */
    let captured: Bool
    let pending: String?
    let usd: String?
    let estimated: Bool
    func validate() throws {
        guard labels(id, program, label, unit), isCanonicalDecimal(amount, allowNegative: true),
              parseSourceDate(asOf) != nil, pending == nil || isCanonicalDecimal(pending, allowNegative: true),
              usd == nil || isCanonicalDecimal(usd, allowNegative: true), usd != nil || !estimated else { throw SnapshotError.invalid }
    }
    func displayAmount(concealed: Bool) -> String { concealed ? String(localized: "Hidden") : displayDecimal(amount, unit: unit) }
    func displayValue(concealed: Bool) -> String? {
        guard let usd, unit != "USD" else { return nil }
        return concealed ? String(localized: "Hidden") : (estimated ? "≈ " : "") + displayDecimal(usd, unit: "USD")
    }
    var sourceLabel: String { captured ? String(localized: "Captured \(shortDate(asOf))") : String(localized: "As of \(shortDate(asOf))") }
}
private func labels(_ values: String...) -> Bool { values.allSatisfy { label($0) } }
struct WidgetExpiry: Codable, Identifiable, Equatable {
    enum Status: String, Codable { case scheduled, none, unknown }
    let id, program, unit: String
    let status: Status
    let expiresOn: String?
    /** False when only public program policy applies. */
    let verified: Bool
    let reason: String
    func validate() throws {
        guard labels(id, program, unit), reason.count <= 500,
              (status == .scheduled) == (expiresOn != nil),
              expiresOn == nil || (expiresOn!.count == 10 && parseSourceDate(expiresOn!) != nil) else { throw SnapshotError.invalid }
    }
    func days(from today: String) -> Int? {
        guard let expiresOn, let end = parseSourceDate(expiresOn), let start = parseSourceDate(today) else { return nil }
        return Int((end.timeIntervalSince(start) / 86_400).rounded())
    }
    func headline(today: String) -> String {
        switch status {
        case .scheduled: return days(from: today).map { String(localized: "\($0) days") } ?? shortDate(expiresOn!)
        case .none: return String(localized: "No scheduled expiry")
        case .unknown: return String(localized: "Unknown")
        }
    }
    var detail: String {
        switch status {
        case .scheduled: return String(localized: "Expires \(shortDate(expiresOn!))") + (verified ? "" : String(localized: " · public policy"))
        case .none: return verified ? String(localized: "Verified for this account") : String(localized: "Public policy, unverified")
        case .unknown: return reason
        }
    }
}
struct WidgetCap: Codable, Identifiable, Equatable {
    enum Status: String, Codable { case available, unavailable }
    let id, program: String
    let status: Status
    let unit, limit, used, remaining, resetsOn, reason: String?
    func validate() throws {
        guard labels(id, program),
              [limit, used, remaining].allSatisfy({ $0 == nil || isCanonicalDecimal($0) }),
              resetsOn == nil || parseSourceDate(resetsOn!) != nil,
              status == .unavailable || (remaining != nil && unit != nil) else { throw SnapshotError.invalid }
    }
    func displayRemaining(concealed: Bool) -> String {
        guard status == .available, let remaining, let unit else { return String(localized: "Unavailable") }
        return concealed ? String(localized: "Hidden") : String(localized: "\(displayDecimal(remaining, unit: unit)) left")
    }
    /** Share of the cap used, for a bar; nil when unknown. */
    var usedFraction: Double? {
        guard status == .available, let used, let limit, let u = Double(used), let l = Double(limit), l > 0 else { return nil }
        return min(1, max(0, u / l))
    }
    var resetLabel: String? { resetsOn.map { String(localized: "Resets \(shortDate($0))") } }
}
struct WidgetGuidance: Codable, Equatable {
    let periodStart, periodEnd: String
    let categories: [Category]
    struct Category: Codable, Identifiable, Equatable {
        var id: String { category }
        let category, spent: String
        let pick: String?
        let cards: [Card]
        var pickedCard: Card? { cards.first { $0.id == pick } }
        var unknownCount: Int { cards.filter { $0.status != .rate }.count }
        func displaySpent(concealed: Bool) -> String { concealed ? String(localized: "Hidden") : displayDecimal(spent, unit: "USD") }
    }
    struct Card: Codable, Identifiable, Equatable {
        enum Status: String, Codable { case rate, unknown, conflict }
        let id, label: String
        let status: Status
        let rate, unit, value: String?
        let estimated: Bool
        let headroom: String?
        var displayRate: String {
            guard status == .rate, let rate, let unit else { return status == .conflict ? String(localized: "Conflicting rules") : String(localized: "Unknown") }
            let percent = { (v: String) in (Double(v).map { ($0 * 100).formatted(.number.precision(.fractionLength(0...2))) } ?? v) + "%" }
            if unit == "USD" { return percent(rate) }
            let base = "\(rate) \(unit)/$"
            guard let value else { return base }
            return base + (estimated ? " (est. \(percent(value)))" : " (\(percent(value)))")
        }
    }
    func validate() throws {
        guard parseSourceDate(periodStart) != nil, parseSourceDate(periodEnd) != nil, categories.count <= 200,
              Set(categories.map(\.id)).count == categories.count else { throw SnapshotError.invalid }
        for category in categories {
            guard label(category.category), isCanonicalDecimal(category.spent), category.cards.count <= 100,
                  Set(category.cards.map(\.id)).count == category.cards.count,
                  category.pick == nil || category.pickedCard?.status == .rate else { throw SnapshotError.invalid }
            for card in category.cards {
                guard label(card.id, max: 256), label(card.label),
                      [card.rate, card.value, card.headroom].allSatisfy({ $0 == nil || isCanonicalDecimal($0) }),
                      (card.status == .rate) == (card.rate != nil) else { throw SnapshotError.invalid }
            }
        }
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
