import CryptoKit
import Foundation
import Security

enum DeviceError: Error, LocalizedError {
    case invalid, unauthorized, unavailable, storage(OSStatus)
    var errorDescription: String? {
        switch self {
        case .invalid: return String(localized: "The service returned an invalid response.")
        case .unauthorized: return String(localized: "Device approval is required or access was revoked.")
        case .unavailable: return String(localized: "Cannot refresh right now. Your saved snapshot is unchanged.")
        case .storage: return String(localized: "Secure storage is unavailable. Unlock this device and try again.")
        }
    }
}
struct DeviceEnrollment: Codable, Equatable {
    let id: String
    let secret: String
    let origin: String
    let label: String
    init(origin: String, label: String) throws {
        self.origin = try ServiceEndpoint(origin).origin.absoluteString
        let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 100,
              !trimmed.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { throw DeviceError.invalid }
        self.label = trimmed
        id = UUID().uuidString.lowercased()
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else { throw DeviceError.storage(status) }
        secret = "nw_" + bytes.map { String(format: "%02x", $0) }.joined()
    }
    var fingerprint: String { SHA256.hash(data: Data(secret.utf8)).map { String(format:"%02x",$0) }.joined() }
    var approvalURL: URL {
        var url = URLComponents(string: origin)!
        url.path = "/widgets"
        var fragment = URLComponents()
        fragment.queryItems = [URLQueryItem(name:"id",value:id), URLQueryItem(name:"hash",value:fingerprint), URLQueryItem(name:"label",value:label)]
        url.percentEncodedFragment = fragment.percentEncodedQuery
        return url.url!
    }
}
struct EnrollmentStore {
    let service: String
    init(service: String = Bundle.main.bundleIdentifier! + ".device") { self.service = service }
    private var query: [String:Any] { [kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:service,kSecAttrAccount as String:"widget-device",kSecAttrSynchronizable as String:false] }
    func read() throws -> DeviceEnrollment? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary,&item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else { throw DeviceError.storage(status) }
        let value = try JSONDecoder().decode(DeviceEnrollment.self,from:data)
        _ = try ServiceEndpoint(value.origin)
        guard value.secret.range(of:"^nw_[0-9a-f]{64}$", options:.regularExpression) != nil else { throw DeviceError.invalid }
        return value
    }
    func save(_ value: DeviceEnrollment) throws {
        let data = try JSONEncoder().encode(value)
        let updated = SecItemUpdate(query as CFDictionary,[kSecValueData as String:data] as CFDictionary)
        if updated == errSecSuccess { return }
        guard updated == errSecItemNotFound else { throw DeviceError.storage(updated) }
        var request = query
        request[kSecValueData as String] = data
        request[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(request as CFDictionary,nil)
        guard status == errSecSuccess else { throw DeviceError.storage(status) }
    }
    func remove() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw DeviceError.storage(status) }
    }
}
struct DeviceStatus: Decodable {
    enum State: String, Decodable { case pending, active, expired, revoked }
    let id: String
    let state: State
    let scope: String
    let expiresAt: Double
}
private final class NoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
struct DeviceClient {
    let session: URLSession
    init(session: URLSession? = nil) {
        if let session { self.session = session; return }
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.httpCookieStorage = nil
        config.urlCache = nil
        config.timeoutIntervalForRequest = 45
        config.timeoutIntervalForResource = 50
        self.session = URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
    }
    private func request(_ enrollment: DeviceEnrollment, path: String, method: String = "GET") async throws -> Data {
        let endpoint = try ServiceEndpoint(enrollment.origin)
        let url = endpoint.origin.appending(path: "api/device/" + path)
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
        request.httpMethod = method
        request.setValue("Bearer " + enrollment.secret, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Networth/1.0", forHTTPHeaderField: "User-Agent")
        let (data, raw) = try await session.data(for: request)
        guard let response = raw as? HTTPURLResponse, response.url == url else { throw DeviceError.invalid }
        if response.statusCode == 401 || response.statusCode == 403 { throw DeviceError.unauthorized }
        guard (method == "DELETE" ? response.statusCode == 204 : response.statusCode == 200), data.count <= 2_000_000 else { throw DeviceError.unavailable }
        if method != "DELETE", response.mimeType != "application/json" { throw DeviceError.invalid }
        return data
    }
    func status(_ enrollment: DeviceEnrollment) async throws -> DeviceStatus {
        let value = try JSONDecoder().decode(DeviceStatus.self, from: await request(enrollment,path:"session"))
        guard value.scope == "widgets:read" else { throw DeviceError.invalid }
        return value
    }
    func snapshot(_ enrollment: DeviceEnrollment) async throws -> Data {
        let data = try await request(enrollment,path:"snapshot")
        _ = try WidgetSnapshot.decode(data)
        return data
    }
    func revoke(_ enrollment: DeviceEnrollment) async throws { _ = try await request(enrollment,path:"session",method:"DELETE") }
}
