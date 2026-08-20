import AppKit
import Foundation
import WebKit

let cookieAllowlist: Set<String> = [
    "sessionid", "csrftoken", "ds_user_id", "mid", "ig_did", "rur", "datr", "dpr",
]
let defaultLoginURL = "https://www.instagram.com/accounts/login/"

struct CookieOut: Codable {
    let name: String
    let value: String
    let domain: String
}

struct HelperOutput: Codable {
    let ok: Bool
    let cookies: [CookieOut]
    let cancelled: Bool
    let error: String?
}

func argValue(_ name: String, from args: [String]) -> String? {
    guard let index = args.firstIndex(of: name), args.indices.contains(index + 1) else { return nil }
    return args[index + 1]
}

func writeStderr(_ message: String) {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
}

func emit(_ output: HelperOutput, code: Int32) -> Never {
    let encoder = JSONEncoder()
    guard let data = try? encoder.encode(output) else {
        writeStderr("Could not encode login helper output.")
        exit(1)
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    try? FileHandle.standardOutput.synchronize()
    exit(code)
}

func ensureStore(_ path: String) throws -> URL {
    let url = URL(fileURLWithPath: path, isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: [
        FileAttributeKey.posixPermissions: 0o700,
    ])
    return url
}

func storeUUID(at directory: URL) throws -> UUID {
    let file = directory.appendingPathComponent("store-uuid")
    if let existing = try? String(contentsOf: file, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
       let uuid = UUID(uuidString: existing) {
        return uuid
    }
    let uuid = UUID()
    try uuid.uuidString.write(to: file, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    return uuid
}

func isInstagramDomain(_ domain: String) -> Bool {
    let host = domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")).lowercased()
    return host == "instagram.com" || host.hasSuffix(".instagram.com")
}

func allowedCookies(from cookies: [HTTPCookie]) -> [CookieOut] {
    var seen = Set<String>()
    var result: [CookieOut] = []
    for cookie in cookies {
        guard cookieAllowlist.contains(cookie.name), !cookie.value.isEmpty, isInstagramDomain(cookie.domain) else { continue }
        if seen.contains(cookie.name) { continue }
        seen.insert(cookie.name)
        result.append(CookieOut(name: cookie.name, value: cookie.value, domain: cookie.domain))
    }
    return result
}

func hasSessionPair(_ cookies: [CookieOut]) -> Bool {
    let names = Set(cookies.map(\.name))
    return names.contains("sessionid") && names.contains("csrftoken")
}

func websiteDataStore(uuid: UUID) -> WKWebsiteDataStore {
    if #available(macOS 14.0, *) {
        return WKWebsiteDataStore(forIdentifier: uuid)
    }
    return WKWebsiteDataStore.default()
}

final class LoginHelper: NSObject, NSApplicationDelegate, NSWindowDelegate, WKHTTPCookieStoreObserver {
    let storeDirectory: URL
    let loginURL: URL
    let exportOnly: Bool
    let uuid: UUID
    var window: NSWindow?
    var webView: WKWebView?
    var finished = false
    var pollTimer: Timer?

    init(storeDirectory: URL, loginURL: URL, exportOnly: Bool, uuid: UUID) {
        self.storeDirectory = storeDirectory
        self.loginURL = loginURL
        self.exportOnly = exportOnly
        self.uuid = uuid
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let store = websiteDataStore(uuid: uuid)
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = store
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true

        if exportOnly {
            let hidden = WKWebView(frame: .zero, configuration: configuration)
            webView = hidden
            store.httpCookieStore.getAllCookies { [weak self] cookies in
                self?.finishExport(cookies)
            }
            return
        }

        NSApp.setActivationPolicy(.regular)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 980, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Gramclaw — Sign in to Instagram"
        window.delegate = self
        window.center()

        let webView = WKWebView(frame: window.contentView?.bounds ?? .zero, configuration: configuration)
        webView.autoresizingMask = [.width, .height]
        window.contentView = webView
        self.window = window
        self.webView = webView

        store.httpCookieStore.add(self)
        webView.load(URLRequest(url: loginURL))
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        pollTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            self?.inspectCookies()
        }
    }

    func cookiesDidChange(in cookieStore: WKHTTPCookieStore) {
        inspectCookies()
    }

    func windowWillClose(_ notification: Notification) {
        guard !finished else { return }
        finish(HelperOutput(ok: false, cookies: [], cancelled: true, error: "cancelled"), code: 2)
    }

    private func inspectCookies() {
        websiteDataStore(uuid: uuid).httpCookieStore.getAllCookies { [weak self] cookies in
            guard let self, !self.finished else { return }
            let allowed = allowedCookies(from: cookies)
            if hasSessionPair(allowed) {
                self.finish(HelperOutput(ok: true, cookies: allowed, cancelled: false, error: nil), code: 0)
            }
        }
    }

    private func finishExport(_ cookies: [HTTPCookie]) {
        let allowed = allowedCookies(from: cookies)
        if hasSessionPair(allowed) {
            finish(HelperOutput(ok: true, cookies: allowed, cancelled: false, error: nil), code: 0)
            return
        }
        finish(HelperOutput(ok: false, cookies: [], cancelled: false, error: "not_signed_in"), code: 3)
    }

    private func finish(_ output: HelperOutput, code: Int32) {
        finished = true
        pollTimer?.invalidate()
        pollTimer = nil
        if let webView {
            webView.configuration.websiteDataStore.httpCookieStore.remove(self)
        }
        emit(output, code: code)
    }
}

let args = Array(CommandLine.arguments.dropFirst())
guard let storePath = argValue("--store", from: args), !storePath.isEmpty else {
    writeStderr("Missing --store directory.")
    exit(2)
}

let exportOnly = args.contains("--export")
let login = URL(string: argValue("--login-url", from: args) ?? defaultLoginURL) ?? URL(string: defaultLoginURL)!

do {
    let directory = try ensureStore(storePath)
    let uuid = try storeUUID(at: directory)
    let app = NSApplication.shared
    app.setActivationPolicy(exportOnly ? .accessory : .regular)
    let helper = LoginHelper(storeDirectory: directory, loginURL: login, exportOnly: exportOnly, uuid: uuid)
    app.delegate = helper
    withExtendedLifetime(helper) {
        app.run()
    }
} catch {
    writeStderr("Could not start the Gramclaw login window.")
    exit(1)
}
