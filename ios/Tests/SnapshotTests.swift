import Foundation
import Testing
@testable import Networth

struct SnapshotTests {
    let valid = #"{"version":1,"fetchedAt":"2030-01-03T12:00:00.000Z","balances":[{"id":"card-a","label":"Example card","currency":"USD","amount":"12.34","kind":"owed","asOf":"2030-01-02T10:00:00Z","availability":"verified"}]}"#

    @Test func validatesExactMoneyAndIndependentSourceClock() throws {
        let snapshot = try WidgetSnapshot.decode(Data(valid.utf8))
        #expect(snapshot.balances[0].amount == "12.34")
        #expect(snapshot.balances[0].asOf == "2030-01-02T10:00:00Z")
        #expect(snapshot.balances[0].displayAmount(concealed: true) == "Hidden")
        #expect(snapshot.balances[0].displayAmount(concealed: false) == "USD 12.34")
        #expect(snapshot.balances[0].kind == .owed)
    }
    @Test func rejectsMalformedSnapshotInsteadOfInventingZero() throws {
        for data in [valid.replacingOccurrences(of: "12.34", with: "NaN"), valid.replacingOccurrences(of: "12.34", with: "-12.34"), valid.replacingOccurrences(of: #""version":1"#, with: #""version":2"#), valid.replacingOccurrences(of: "2030-01-02T10:00:00Z", with: "not a date"), valid.replacingOccurrences(of: "owed", with: "zero")] {
            #expect(throws: (any Error).self) { try WidgetSnapshot.decode(Data(data.utf8)) }
        }
    }
    @Test func unavailableIsNotZeroAndDuplicateIdentityFails() throws {
        let missing = #"{"version":1,"fetchedAt":"2030-01-03T12:00:00.000Z","balances":[{"id":"card-a","label":"Example","currency":null,"amount":null,"kind":"unavailable","asOf":null,"availability":"unavailable"}]}"#
        let snapshot = try WidgetSnapshot.decode(Data(missing.utf8))
        #expect(snapshot.balances[0].displayAmount(concealed: false) == "Unavailable")
        var duplicate = try JSONSerialization.jsonObject(with: Data(valid.utf8)) as! [String:Any]
        let rows = duplicate["balances"] as! [[String:Any]]
        duplicate["balances"] = rows + rows
        #expect(throws: (any Error).self) { try WidgetSnapshot.decode(JSONSerialization.data(withJSONObject: duplicate)) }
    }
    @Test func failedRefreshCannotReplaceLastGoodSnapshot() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = SnapshotStore(directory: root)
        try store.save(Data(valid.utf8))
        #expect(throws: (any Error).self) { try store.save(Data("bad".utf8)) }
        #expect(try store.read()?.balances[0].amount == "12.34")
        try store.clear()
        #expect(try store.read() == nil)
    }
    @Test func endpointRejectsCredentialsQueryFragmentsAndNonHTTPS() throws {
        #expect(try ServiceEndpoint("https://dashboard.example/").origin.absoluteString == "https://dashboard.example")
        for value in ["http://dashboard.example", "https://user:password@dashboard.example", "https://dashboard.example?token=x", "https://dashboard.example/finance", "https://dashboard.example#token"] {
            #expect(throws: (any Error).self) { try ServiceEndpoint(value) }
        }
    }
}

struct RewardSnapshotTests {
    let today = parseSourceDate("2030-05-10T12:00:00Z")!
    var utc: Calendar { var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(secondsFromGMT: 0)!; return c }
    let rewards = #"{"version":1,"fetchedAt":"2030-05-10T12:00:00.000Z","balances":[],"rewards":[{"id":"m","program":"Example Air","label":"Miles","unit":"miles","amount":"48389","asOf":"2030-05-01T06:00:00.000Z","captured":true,"pending":null,"usd":"580.67","estimated":true},{"id":"c","program":"Example Card","label":"Cash","unit":"USD","amount":"17.8","asOf":"2030-04-30","captured":false,"pending":"2.5","usd":"17.8","estimated":false}],"expiry":[{"id":"h","program":"Example Hotel","unit":"points","status":"scheduled","expiresOn":"2031-08-24","verified":true,"reason":"Provider-stated deadline."},{"id":"m","program":"Example Air","unit":"miles","status":"unknown","expiresOn":null,"verified":false,"reason":"No expiry terms are published for this unit."},{"id":"c","program":"Example Card","unit":"USD","status":"none","expiresOn":null,"verified":false,"reason":"Public program policy: no scheduled expiry. Not verified for this account."}],"caps":[{"id":"p:q","program":"Example Card","status":"available","unit":"USD","limit":"2500","used":"600.5","remaining":"1899.5","resetsOn":"2030-07-01","reason":null},{"id":"p:r","program":"Other Card","status":"unavailable","unit":"USD","limit":"1500","used":null,"remaining":null,"resetsOn":null,"reason":"Cap usage has not been observed for this account."}],"guidance":{"periodStart":"2030-04-01","periodEnd":"2030-07-01","categories":[{"category":"Dining","spent":"60","pick":"b","cards":[{"id":"a","label":"Card A","status":"rate","rate":"0.01","unit":"USD","value":"0.01","estimated":false,"headroom":null},{"id":"b","label":"Card B","status":"rate","rate":"3","unit":"points","value":"0.03","estimated":true,"headroom":"2400"}]},{"category":"Groceries","spent":"100","pick":null,"cards":[{"id":"a","label":"Card A","status":"unknown","rate":null,"unit":null,"value":null,"estimated":false,"headroom":null}]}]}}"#

    @Test func decodesRewardSectionsWithExactTextAndExplicitUnknowns() throws {
        let snapshot = try WidgetSnapshot.decode(Data(rewards.utf8))
        #expect(snapshot.rewards?.count == 2)
        #expect(snapshot.rewards?[0].displayAmount(concealed: false) == "48,389 miles")
        #expect(snapshot.rewards?[1].displayAmount(concealed: false) == "$17.80")
        #expect(snapshot.rewards?[0].displayValue(concealed: false) == "≈ $580.67")
        #expect(snapshot.rewards?[0].sourceLabel.hasPrefix("Captured") == true)
        #expect(snapshot.rewards?[1].sourceLabel.hasPrefix("As of") == true)
        #expect(snapshot.expiry?[1].headline(today: today, calendar: utc) == "Unknown")
        #expect(snapshot.expiry?[0].headline(today: today, calendar: utc) == "471 days")
        #expect(snapshot.expiry?[2].headline(today: today, calendar: utc) == "No scheduled expiry")
        // Late evening in a western time zone is still the local calendar day.
        var pacific = Calendar(identifier: .gregorian)
        pacific.timeZone = TimeZone(identifier: "America/Los_Angeles")!
        #expect(snapshot.expiry?[0].days(from: parseSourceDate("2030-05-10T05:00:00Z")!, calendar: pacific) == 472)
        #expect(snapshot.caps?[0].displayRemaining(concealed: false) == "$1,899.50 left")
        #expect(snapshot.caps?[1].displayRemaining(concealed: false) == "Unavailable")
        let dining = try #require(snapshot.guidance?.categories.first)
        #expect(dining.pickedCard?.label == "Card B")
        #expect(dining.pickedCard?.displayRate == "3 points/$ (est. 3%)")
        #expect(snapshot.guidance?.categories[1].pickedCard == nil)
    }
    @Test func concealsEveryAmountButKeepsRatesAndDates() throws {
        let snapshot = try WidgetSnapshot.decode(Data(rewards.utf8))
        #expect(snapshot.rewards?.allSatisfy { $0.displayAmount(concealed: true) == "Hidden" && ($0.displayValue(concealed: true) ?? "Hidden") == "Hidden" } == true)
        #expect(snapshot.caps?[0].displayRemaining(concealed: true) == "Hidden")
        #expect(snapshot.guidance?.categories[0].displaySpent(concealed: true) == "Hidden")
        #expect(snapshot.guidance?.categories[0].displaySpent(concealed: false) == "$60.00 spent")
        #expect(snapshot.expiry?[0].headline(today: today, calendar: utc) == "471 days")
    }
    @Test func oldSnapshotsWithoutRewardSectionsStillDecode() throws {
        let snapshot = try WidgetSnapshot.decode(Data(#"{"version":1,"fetchedAt":"2030-01-03T12:00:00.000Z","balances":[]}"#.utf8))
        #expect(snapshot.rewards == nil && snapshot.guidance == nil && snapshot.caps == nil && snapshot.expiry == nil)
    }
    @Test func rejectsMalformedRewardFactsInsteadOfShowingThem() throws {
        for (from, to) in [(#""amount":"48389""#, #""amount":"4.8e4""#), (#""amount":"48389""#, #""amount":"-0""#), (#""expiresOn":"2031-08-24""#, #""expiresOn":"2031-02-30""#), (#""status":"scheduled""#, #""status":"soon""#), (#""remaining":"1899.5""#, #""remaining":"1899.50""#), (#""pick":"b""#, #""pick":"missing""#), (#""status":"scheduled","expiresOn":"2031-08-24""#, #""status":"scheduled","expiresOn":null"#)] {
            #expect(throws: (any Error).self) { try WidgetSnapshot.decode(Data(rewards.replacingOccurrences(of: from, with: to).utf8)) }
        }
    }
}
