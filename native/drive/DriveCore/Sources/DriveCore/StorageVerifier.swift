import Foundation

public struct StorageCheck: Identifiable, Sendable {
    public enum State: Sendable { case pending, running, passed, warning, failed }
    public let id: Int
    public let title: String
    public var state: State = .pending
    public var detail: String = ""
}

/// Runs a short end-to-end test of a storage configuration before it is saved: sign in, write, read back, delete,
/// set the trash retention rule, and mint a share link. Failures come back in plain language with a suggested fix.
public enum StorageVerifier {
    public static let titles = [
        "Connect and sign in",
        "Write a test file",
        "Read it back",
        "Clean up the test file",
        "Set 30-day trash",
        "Create a share link",
    ]

    public static func initialChecks() -> [StorageCheck] { titles.enumerated().map { StorageCheck(id: $0.offset, title: $0.element) } }

    /// Calls `update` after each state change so a UI can show live progress. Returns true if every required step passed.
    @discardableResult
    public static func run(config: SharedConfig, update: @Sendable @escaping ([StorageCheck]) -> Void) async -> Bool {
        var checks = initialChecks()
        func set(_ i: Int, _ s: StorageCheck.State, _ detail: String = "") { checks[i].state = s; checks[i].detail = detail; update(checks) }

        if let problem = config.validationProblem { set(0, .failed, problem); return false }
        let store = config.makeStore()
        let testKey = ".ghost-check-\(UUID().uuidString.prefix(8))"
        let payload = Data("ghost connection test".utf8)
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("ghost-verify-\(UUID().uuidString)")
        try? payload.write(to: tmp)
        defer { try? FileManager.default.removeItem(at: tmp) }

        set(0, .running)
        do { _ = try await store.list(prefix: "") } catch { set(0, .failed, explain(error, config: config)); return false }
        set(0, .passed)

        set(1, .running)
        do { try await store.upload(file: tmp, as: testKey, mtime: nil, progress: nil) }
        catch { set(1, .failed, explain(error, config: config, writing: true)); return false }
        set(1, .passed)

        set(2, .running)
        var cleanupOK = true
        do {
            let back = try await store.read(key: testKey, offset: 0, length: payload.count, fileID: nil)
            if back == payload { set(2, .passed) } else { set(2, .failed, "The file came back different from what was written. Try again, or choose another provider.") }
        } catch {
            if isCapError(error) { set(2, .warning, explain(error, config: config)) }       // setup is fine; the account is just throttled right now
            else { set(2, .failed, explain(error, config: config)); cleanupOK = false }
        }

        set(3, .running)
        if let obj = try? await store.stat(key: testKey) {
            do { try await store.deleteVersion(key: testKey, fileID: obj.fileID ?? ""); set(3, .passed) }
            catch { set(3, .warning, "The key can write but not delete. Give it delete permission, or deleted files in Ember Drive won't be removable.") }
        } else {
            // Couldn't look the file up (e.g. downloads are throttled); fall back to a soft delete that needs no lookup.
            do { try await store.hide(key: testKey); set(3, .passed) }
            catch { set(3, .warning, "Couldn't remove the test file. It's harmless and tiny; you can delete \(testKey) from the bucket later.") }
        }

        set(4, .running)
        do { try await store.configureTrashLifecycle(days: 30); set(4, .passed) }
        catch {
            if config.provider == .b2 { set(4, .warning, "Couldn't set the 30-day trash rule (the key may lack bucket-settings permission). Ember Drive still works; deleted files just won't expire automatically.") }
            else { set(4, .passed, "Deleted files are kept 30 days; Ember Drive clears older trash itself.") }       // purged client-side, no bucket-settings permission needed
        }

        set(5, .running)
        do { _ = try await store.shareURL(key: testKey, validFor: 60); set(5, .passed) }
        catch { set(5, .warning, "Share links aren't available with this key (it may lack the share permission).") }

        return !checks.contains { $0.state == .failed }
    }

    /// Turns a transport/API error into something a person can act on.
    /// True when the provider is refusing downloads because a usage cap was reached (Backblaze's free daily allowance, for example).
    public static func isCapError(_ error: Error) -> Bool {
        if case B2Error.http(_, let code, let message) = error {
            let c = (code + " " + message).lowercased()
            return c.contains("cap_exceeded") || c.contains("cap exceeded")
        }
        return false
    }

    public static func explain(_ error: Error, config: SharedConfig, writing: Bool = false) -> String {
        if isCapError(error) {
            let onBackblaze = config.provider == .b2 || config.endpoint.contains("backblazeb2")
            return onBackblaze
                ? "Your Backblaze account has hit a usage cap, so downloads are paused. Open Caps & Alerts (secure.backblaze.com/caps.htm) and raise the daily download cap; the free allowance resets at midnight UTC."
                : "Your storage provider is refusing downloads because a usage cap was reached. Check the usage limits in your provider's dashboard."
        }
        if case B2Error.notFound = error { return "That bucket wasn't found. Check the bucket name, and the region or account ID." }
        if case B2Error.http(let status, let code, let message) = error {
            let lower = (code + " " + message).lowercased()
            switch (status, code) {
            case (401, _), (_, "InvalidAccessKeyId"), (_, "SignatureDoesNotMatch"), (_, "bad_auth_token"), (_, "unauthorized"):
                if config.provider == .b2 { return "Backblaze rejected the key. Check the Key ID and Application Key (the key is only shown once when created, so you may need to make a new one)." }
                if lower.contains("malformed") { return "The Access Key ID doesn't look right. Copy it again from the provider's console." }
                return "The provider rejected the keys. Check the Access Key ID and Secret Access Key, and that the region/account matches."
            case (403, _):
                return writing ? "The key can sign in but isn't allowed to write to this bucket. Make the key Read and Write." : "This key isn't allowed to access that bucket. Check the bucket name and the key's permissions."
            case (404, _), (_, "NoSuchBucket"):
                return "That bucket wasn't found. Check the spelling, and (for AWS and Wasabi) that the region matches where you created it."
            case (301, _), (_, "PermanentRedirect"), (_, "AuthorizationHeaderMalformed"):
                return "The region looks wrong for this bucket. Pick the region the bucket was created in."
            default: break
            }
            if lower.contains("bucket") && lower.contains("not found") { return "That bucket wasn't found. Check the bucket name." }
            return "The provider returned an error (\(status) \(code)): \(message)"
        }
        if case B2Error.badResponse(let m) = error, m.contains("not found") { return "That bucket wasn't found. Check the bucket name." }
        if let e = error as? URLError {
            switch e.code {
            case .notConnectedToInternet, .networkConnectionLost, .timedOut: return "Couldn't reach the provider. Check your internet connection."
            case .cannotFindHost, .dnsLookupFailed: return "Couldn't find that server. Check the endpoint / account ID / region."
            case .serverCertificateUntrusted, .secureConnectionFailed: return "The secure connection failed. Check the endpoint address."
            default: return "Network error: \(e.localizedDescription)"
            }
        }
        return "\(error.localizedDescription)"
    }
}
