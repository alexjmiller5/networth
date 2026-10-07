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
