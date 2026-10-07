import Foundation
import Testing
@testable import Networth

private final class SourceProtocol: URLProtocol, @unchecked Sendable {
    static var handler: (URLRequest) throws -> (HTTPURLResponse, Data) = { _ in throw URLError(.notConnectedToInternet) }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (response, data) = try Self.handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}
@Suite(.serialized) struct DeviceClientTests {
    func session() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [SourceProtocol.self]
        return URLSession(configuration: config)
    }
    func credential() throws -> DeviceEnrollment {
        try DeviceEnrollment(origin: "https://dashboard.example", label: "Example phone")
    }
    @Test func fingerprintApprovalNeverContainsTheCredential() throws {
        let value = try credential()
        #expect(value.secret.count == 67)
        #expect(value.fingerprint.count == 64)
        #expect(value.approvalURL.absoluteString.contains(value.fingerprint))
        #expect(!value.approvalURL.absoluteString.contains(value.secret))
        #expect(value.approvalURL.path == "/widgets")
        #expect(value.approvalURL.query == nil)
    }
    @Test func nativeKeychainRoundTrip() throws {
        let store = EnrollmentStore(service: "test.networth.\(UUID().uuidString)")
        defer { try? store.remove() }
        let value = try credential()
        try store.save(value)
        #expect(try store.read() == value)
        try store.remove()
        #expect(try store.read() == nil)
    }
    @Test func requestIsNarrowAndAuthenticatedWithoutCookies() async throws {
        let value = try credential()
        SourceProtocol.handler = { request in
            #expect(request.url?.absoluteString == "https://dashboard.example/api/device/session")
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer \(value.secret)")
            #expect(request.value(forHTTPHeaderField: "Cookie") == nil)
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type":"application/json"])!, Data(#"{"id":"example","state":"active","scope":"widgets:read","expiresAt":2000000000000}"#.utf8))
        }
        let status = try await DeviceClient(session: session()).status(value)
        #expect(status.state == .active)
    }
    @Test func rejectsHTTPFailuresWrongScopeAndForeignResponse() async throws {
        let value = try credential()
        for (code, scope, url) in [(403,"widgets:read","https://dashboard.example/api/device/session"),(200,"finance:write","https://dashboard.example/api/device/session"),(200,"widgets:read","https://foreign.example/api/device/session")] {
            SourceProtocol.handler = { _ in
                (HTTPURLResponse(url: URL(string:url)!,statusCode:code,httpVersion:nil,headerFields:["Content-Type":"application/json"])!,Data("{\"id\":\"example\",\"state\":\"active\",\"scope\":\"\(scope)\",\"expiresAt\":2000000000000}".utf8))
            }
            await #expect(throws: (any Error).self) { try await DeviceClient(session: session()).status(value) }
        }
    }
    @Test func revocationUsesOnlyTheCurrentDeviceSession() async throws {
        let value = try credential()
        SourceProtocol.handler = { request in
            #expect(request.httpMethod == "DELETE")
            #expect(request.url?.path == "/api/device/session")
            return (HTTPURLResponse(url:request.url!,statusCode:204,httpVersion:nil,headerFields:nil)!,Data())
        }
        try await DeviceClient(session: session()).revoke(value)
    }
    @Test @MainActor func timeoutReleasesRefreshAndExplainsRetry() async throws {
        let store = EnrollmentStore(service: "test.networth.\(UUID().uuidString)")
        defer { try? store.remove() }
        try store.save(credential())
        SourceProtocol.handler = { _ in throw URLError(.timedOut) }
        let model = DashboardModel(credentials: store, client: DeviceClient(session: session()), snapshots: nil)
        await model.refresh()
        #expect(!model.busy)
        #expect(model.enrollment != nil)
        #expect(model.message.contains("try again"))
    }
}
