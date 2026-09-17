// WindowFinder native shell — WKWebView windows around the local server,
// so the explorer runs as its own macOS app (no Chrome dependency).
import Cocoa
import FinderSync
import WebKit
import UniformTypeIdentifiers

let PORT = 8890
let BASE = "http://127.0.0.1:\(PORT)"

func slog(_ s: String) {
    let line = "\(Date()) \(s)\n"
    if let h = FileHandle(forWritingAtPath: "/tmp/windowfinder-shell.log") {
        h.seekToEndOfFile()
        if let d = line.data(using: .utf8) { h.write(d) }
        h.closeFile()
    } else {
        try? line.write(toFile: "/tmp/windowfinder-shell.log", atomically: false, encoding: .utf8)
    }
}

// what to do when a dragged-out file already exists at the destination
enum ConflictChoice { case overwrite, keepBoth, skip }
final class ConflictPolicy {
    static let shared = ConflictPolicy()
    private let lock = NSLock() // serialize prompts across concurrent promise writes
    private var applyAll: ConflictChoice?
    func reset() { applyAll = nil }
    func ask(name: String) -> ConflictChoice {
        lock.lock(); defer { lock.unlock() }
        if let a = applyAll { return a }
        var choice = ConflictChoice.skip
        var apply = false
        DispatchQueue.main.sync {
            let alert = NSAlert()
            alert.messageText = "‘\(name)’ 항목이 이미 있습니다"
            alert.informativeText = "대상 폴더에 같은 이름의 항목이 있습니다. 어떻게 할까요?"
            alert.addButton(withTitle: "덮어쓰기")
            alert.addButton(withTitle: "둘 다 유지")
            alert.addButton(withTitle: "건너뛰기")
            alert.showsSuppressionButton = true
            alert.suppressionButton?.title = "나머지 항목에도 적용"
            NSApp.activate(ignoringOtherApps: true)
            switch alert.runModal() {
            case .alertFirstButtonReturn: choice = .overwrite
            case .alertSecondButtonReturn: choice = .keepBoth
            default: choice = .skip
            }
            apply = alert.suppressionButton?.state == .on
        }
        if apply { applyAll = choice }
        return choice
    }
}

// file promise: Finder asks us to produce each file at the drop location —
// the reliable way for a third-party app to drag files out (folders too)
final class FilePromiseDelegate: NSObject, NSFilePromiseProviderDelegate {
    static let queue = OperationQueue()
    let srcPath: String
    init(_ p: String) { srcPath = p }
    func filePromiseProvider(_ fp: NSFilePromiseProvider, fileNameForType fileType: String) -> String {
        (srcPath as NSString).lastPathComponent
    }
    static func uniqueURL(_ url: URL) -> URL {
        let fm = FileManager.default
        let dir = url.deletingLastPathComponent()
        let ext = url.pathExtension
        let base = url.deletingPathExtension().lastPathComponent
        var i = 1
        while true {
            let name = i == 1 ? "\(base) copy" : "\(base) copy \(i)"
            let cand = dir.appendingPathComponent(ext.isEmpty ? name : "\(name).\(ext)")
            if !fm.fileExists(atPath: cand.path) { return cand }
            i += 1
        }
    }
    func filePromiseProvider(_ fp: NSFilePromiseProvider, writePromiseTo url: URL,
                             completionHandler: @escaping (Error?) -> Void) {
        let fm = FileManager.default
        var dest = url
        if fm.fileExists(atPath: dest.path) {
            switch ConflictPolicy.shared.ask(name: dest.lastPathComponent) {
            case .skip:
                slog("promise skip (exists): \(dest.path)")
                completionHandler(nil)
                return
            case .overwrite:
                try? fm.removeItem(at: dest)
            case .keepBoth:
                dest = Self.uniqueURL(dest)
            }
        }
        slog("promise write: \(srcPath) -> \(dest.path)")
        do {
            try fm.copyItem(at: URL(fileURLWithPath: srcPath), to: dest)
            completionHandler(nil)
        } catch {
            slog("promise error: \(error)")
            completionHandler(error)
        }
    }
    func operationQueue(for fp: NSFilePromiseProvider) -> OperationQueue { FilePromiseDelegate.queue }
}

// promise + real file URL together on the pasteboard: Finder consumes the
// promise, while web drop zones (S3 web UI, browsers) need public.file-url
final class FilePromiseProviderWithURL: NSFilePromiseProvider {
    var fileURL: URL?
    override func writableTypes(for pasteboard: NSPasteboard) -> [NSPasteboard.PasteboardType] {
        var types = super.writableTypes(for: pasteboard)
        types.append(.fileURL)
        return types
    }
    override func pasteboardPropertyList(forType type: NSPasteboard.PasteboardType) -> Any? {
        if type == .fileURL { return (fileURL as NSURL?)?.pasteboardPropertyList(forType: type) }
        return super.pasteboardPropertyList(forType: type)
    }
    override func writingOptions(forType type: NSPasteboard.PasteboardType,
                                 pasteboard: NSPasteboard) -> NSPasteboard.WritingOptions {
        if type == .fileURL { return [] }
        return super.writingOptions(forType: type, pasteboard: pasteboard)
    }
}

// dedicated drag source, separate from WKWebView (which has its own private
// NSDraggingSource machinery that must not shadow ours)
final class FileDragSource: NSObject, NSDraggingSource {
    weak var webView: WKWebView?
    var paths: [String] = [] // real paths of the current drag (read by drop targets)
    var activeDelegates: [FilePromiseDelegate] = [] // retained for the session's lifetime
    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
        return context == .outsideApplication ? .copy : [.copy, .move]
    }
    func draggingSession(_ session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation) {
        slog("drag session ended, operation=\(operation.rawValue)")
        activeDelegates.removeAll()
        paths = []
        DispatchQueue.main.async {
            self.webView?.evaluateJavaScript("window.fxNativeDragEnded && window.fxNativeDragEnded()")
        }
    }
}

// WKWebView that bridges drag & drop with the real filesystem:
//  - Finder → app: dropped paths are copied natively via the server API
//  - app → Finder: a native drag session carries real file URLs out
final class DropWebView: WKWebView {
    let dragSource = FileDragSource()
    // the session must start while a mouse-drag event is being PROCESSED —
    // the JS bridge only queues the paths; the next mouseDragged starts it
    var pendingDragPaths: [String]?
    override func mouseDragged(with event: NSEvent) {
        if let paths = pendingDragPaths {
            pendingDragPaths = nil
            startFileDrag(paths: paths, event: event)
            return // the drag session owns the mouse loop from here
        }
        super.mouseDragged(with: event)
    }
    override func mouseUp(with event: NSEvent) {
        pendingDragPaths = nil
        super.mouseUp(with: event)
    }

    func startFileDrag(paths: [String], event: NSEvent) {
        let loc = convert(event.locationInWindow, from: nil)
        let fm = FileManager.default
        var items: [NSDraggingItem] = []
        ConflictPolicy.shared.reset() // fresh "apply to all" decision per drag
        dragSource.activeDelegates.removeAll()
        dragSource.paths = paths
        for (i, p) in paths.enumerated() {
            var isDir: ObjCBool = false
            fm.fileExists(atPath: p, isDirectory: &isDir)
            let ut: UTType = isDir.boolValue
                ? .folder
                : (UTType(filenameExtension: (p as NSString).pathExtension.lowercased()) ?? .data)
            let del = FilePromiseDelegate(p)
            dragSource.activeDelegates.append(del)
            let provider = FilePromiseProviderWithURL(fileType: ut.identifier, delegate: del)
            provider.fileURL = URL(fileURLWithPath: p)
            let item = NSDraggingItem(pasteboardWriter: provider)
            let icon = NSWorkspace.shared.icon(forFile: p)
            icon.size = NSSize(width: 48, height: 48)
            let off = CGFloat(min(i, 3)) * 4
            item.setDraggingFrame(NSRect(x: loc.x - 24 + off, y: loc.y - 24 - off, width: 48, height: 48),
                                  contents: i == 0 ? icon : nil)
            items.append(item)
        }
        beginDraggingSession(with: items, event: event, source: dragSource)
        slog("drag session started from live mouseDragged, \(paths.count) paths")
    }

    private func isExternalFileDrag(_ sender: NSDraggingInfo) -> Bool {
        if sender.draggingSource != nil { return false }
        return sender.draggingPasteboard.types?.contains(.fileURL) ?? false
    }
    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        if sender.draggingSource is FileDragSource { return .move } // our own drag (any window)
        if isExternalFileDrag(sender) { return .copy }
        return super.draggingEntered(sender)
    }
    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        if sender.draggingSource is FileDragSource { return .move }
        if isExternalFileDrag(sender) { return .copy }
        return super.draggingUpdated(sender)
    }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        // our own drag dropped on this (or another) explorer window:
        // hand the drop point + paths to the page, which resolves the target folder
        if let src = sender.draggingSource as? FileDragSource {
            let paths = src.paths
            guard !paths.isEmpty,
                  let json = (try? JSONSerialization.data(withJSONObject: paths))
                    .flatMap({ String(data: $0, encoding: .utf8) }) else { return false }
            let pt = convert(sender.draggingLocation, from: nil)
            let alt = NSEvent.modifierFlags.contains(.option)
            let sameWindow = src.webView === self
            evaluateJavaScript("window.fxInternalDrop && window.fxInternalDrop(\(pt.x), \(pt.y), \(json), \(alt), \(sameWindow))")
            return true
        }
        guard isExternalFileDrag(sender) else { return super.performDragOperation(sender) }
        let opts: [NSPasteboard.ReadingOptionKey: Any] = [.urlReadingFileURLsOnly: true]
        guard let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: opts) as? [URL],
              !urls.isEmpty else { return false }
        var dest = NSHomeDirectory()
        if let frag = self.url?.fragment?.removingPercentEncoding, frag.hasPrefix("/") { dest = frag }
        var req = URLRequest(url: URL(string: "\(BASE)/api/op")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: [
            "op": "copy", "dest": dest, "paths": urls.map { $0.path },
        ])
        URLSession.shared.dataTask(with: req) { _, _, _ in
            DispatchQueue.main.async {
                self.evaluateJavaScript("window.dispatchEvent(new Event('fx-refresh'))")
            }
        }.resume()
        return true
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler {
    var windows: [NSWindow] = []
    var titleObservations: [ObjectIdentifier: NSKeyValueObservation] = [:]
    // 문서 열기 이벤트가 didFinishLaunching보다 먼저 와도 안전하도록 지연 초기화
    lazy var config: WKWebViewConfiguration = {
        let c = WKWebViewConfiguration()
        c.userContentController.add(self, name: "fxDrag")
        c.userContentController.add(self, name: "fxNewWindow")
        c.userContentController.add(self, name: "fxCloseWindow")
        c.userContentController.add(self, name: "fxCheckUpdate")
        return c
    }()

    // ── JS bridge ──
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let wv = message.webView as? DropWebView else { return }
        switch message.name {
        case "fxNewWindow":
            let url = (message.body as? String) ?? wv.url?.absoluteString ?? "\(BASE)/"
            makeWindow(urlString: url)
        case "fxCloseWindow":
            wv.window?.close()
        case "fxCheckUpdate":
            checkForUpdates(interactive: true)
        case "fxDrag":
            guard let paths = message.body as? [String], !paths.isEmpty else {
                slog("fxDrag: bad payload"); return
            }
            // queue: the very next mouseDragged event starts the session
            if NSEvent.pressedMouseButtons & 1 == 1 {
                slog("fxDrag: queued \(paths.count) paths")
                wv.pendingDragPaths = paths
            } else {
                slog("fxDrag: mouse already up, ignored")
            }
        default: break
        }
    }

    // ── windows ──
    @discardableResult
    func makeWindow(urlString: String?) -> NSWindow {
        let wv = DropWebView(frame: .zero, configuration: config)
        wv.dragSource.webView = wv
        wv.registerForDraggedTypes([.fileURL])
        let w = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1320, height: 860),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        w.title = "WindowFinder"
        w.minSize = NSSize(width: 720, height: 480)
        w.contentView = wv
        w.delegate = self
        w.isReleasedWhenClosed = false
        if windows.isEmpty {
            w.setFrameAutosaveName("WindowFinderMain")
            if w.frame.width < 720 { w.center() }
        } else if let key = windows.last {
            w.setFrameOrigin(NSPoint(x: key.frame.origin.x + 28,
                                     y: key.frame.origin.y - 28))
        }
        windows.append(w)
        // 창 제목 = 페이지 제목(현재 폴더/도구 이름) — 윈도우 메뉴 목록에서 구분됨
        titleObservations[ObjectIdentifier(w)] = wv.observe(\.title, options: [.new]) { [weak w] view, _ in
            DispatchQueue.main.async {
                let t = view.title ?? ""
                w?.title = t.isEmpty ? "WindowFinder" : t
            }
        }
        w.makeKeyAndOrderFront(nil)
        waitAndLoad(wv, urlString ?? "\(BASE)/", attempts: 40)
        return w
    }
    func windowWillClose(_ note: Notification) {
        if let w = note.object as? NSWindow {
            windows.removeAll { $0 === w }
            titleObservations.removeValue(forKey: ObjectIdentifier(w))
        }
    }
    @objc func newWindowAction(_ sender: Any?) {
        let current = (NSApp.keyWindow?.contentView as? DropWebView)?.url?.absoluteString
        makeWindow(urlString: current)
    }
    @objc func configureFinderExtensionAction(_ sender: Any?) {
        FIFinderSyncController.showExtensionManagementInterface()
    }
    func offerFinderExtensionSetupIfNeeded() {
        let key = "didOfferFinderExtensionSetup.v1"
        guard !FIFinderSyncController.isExtensionEnabled,
              !UserDefaults.standard.bool(forKey: key) else { return }
        UserDefaults.standard.set(true, forKey: key)

        let alert = NSAlert()
        alert.messageText = "Finder 우클릭 메뉴를 활성화할까요?"
        alert.informativeText = "Finder에서 파일·폴더나 빈 공간을 우클릭해 ‘WindowFinder로 열기’를 사용하려면 Finder 확장을 한 번 켜야 합니다."
        alert.addButton(withTitle: "확장 설정 열기")
        alert.addButton(withTitle: "나중에")
        if alert.runModal() == .alertFirstButtonReturn {
            FIFinderSyncController.showExtensionManagementInterface()
        }
    }

    // ── 자동 업데이트 (사내 배포: latest.json + zip) ──
    // Info.plist의 WindowFinderUpdateURL: http(s) 주소 또는 공유 폴더 경로(/Volumes/…)
    var updateBase: String? { Bundle.main.object(forInfoDictionaryKey: "WindowFinderUpdateURL") as? String }
    var currentVersion: String {
        (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "0"
    }
    static func newer(_ a: String, than b: String) -> Bool {
        let x = a.split(separator: ".").map { Int($0) ?? 0 }
        let y = b.split(separator: ".").map { Int($0) ?? 0 }
        for i in 0..<max(x.count, y.count) {
            let l = i < x.count ? x[i] : 0, r = i < y.count ? y[i] : 0
            if l != r { return l > r }
        }
        return false
    }
    func fetchData(_ location: String, done: @escaping (Data?) -> Void) {
        if location.hasPrefix("/") { // 공유 폴더 배포
            done(FileManager.default.contents(atPath: location))
        } else if let url = URL(string: location) {
            URLSession.shared.dataTask(with: url) { d, _, _ in done(d) }.resume()
        } else { done(nil) }
    }
    @objc func checkUpdatesAction(_ sender: Any?) { checkForUpdates(interactive: true) }
    func checkForUpdates(interactive: Bool) {
        guard let base = updateBase, !base.isEmpty else {
            if interactive { self.info("업데이트 주소가 설정되어 있지 않습니다", "빌드 시 update-url.txt로 설정합니다.") }
            return
        }
        let sep = base.hasSuffix("/") ? "" : "/"
        fetchData("\(base)\(sep)latest.json") { data in
            guard let data,
                  let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let ver = j["version"] as? String, let zip = j["zip"] as? String else {
                slog("update check failed: \(base) (data=\(data?.count ?? -1) bytes)")
                if interactive { DispatchQueue.main.async { self.info("업데이트 확인 실패", "latest.json을 읽을 수 없습니다.") } }
                return
            }
            slog("update check: current=\(self.currentVersion) latest=\(ver)")
            DispatchQueue.main.async {
                guard Self.newer(ver, than: self.currentVersion) else {
                    if interactive { self.info("최신 버전입니다", "현재 v\(self.currentVersion)") }
                    return
                }
                if !interactive {
                    // 백그라운드 확인: 묻지 않고 자동 업데이트 (사내 배포 채널)
                    slog("auto-update: v\(self.currentVersion) → v\(ver)")
                    self.downloadAndApply(base: base + sep, zip: zip)
                    return
                }
                let alert = NSAlert()
                alert.messageText = "새 버전 v\(ver) 이 있습니다"
                alert.informativeText = "현재 v\(self.currentVersion) — 지금 업데이트할까요? (앱이 다시 시작됩니다)"
                alert.addButton(withTitle: "지금 업데이트")
                alert.addButton(withTitle: "나중에")
                if alert.runModal() == .alertFirstButtonReturn {
                    self.downloadAndApply(base: base + sep, zip: zip)
                }
            }
        }
    }
    func downloadAndApply(base: String, zip: String) {
        // zip이 절대 URL/경로면 그대로, 아니면 base 기준 상대 경로
        let loc = (zip.hasPrefix("http") || zip.hasPrefix("/")) ? zip : base + zip
        fetchData(loc) { data in
            guard let data else { DispatchQueue.main.async { self.info("업데이트 실패", "다운로드할 수 없습니다.") }; return }
            let tmp = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("windowfinder-upd-\(UUID().uuidString)")
            do {
                try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
                let zipURL = tmp.appendingPathComponent("app.zip")
                try data.write(to: zipURL)
                let unzip = Process()
                unzip.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
                unzip.arguments = ["-x", "-k", zipURL.path, tmp.path]
                try unzip.run(); unzip.waitUntilExit()
                guard let newApp = try FileManager.default.contentsOfDirectory(at: tmp, includingPropertiesForKeys: nil)
                    .first(where: { $0.pathExtension == "app" }) else { throw NSError(domain: "windowfinder", code: 1) }
                let xa = Process()
                xa.executableURL = URL(fileURLWithPath: "/usr/bin/xattr")
                xa.arguments = ["-dr", "com.apple.quarantine", newApp.path]
                try? xa.run(); xa.waitUntilExit()
                DispatchQueue.main.async { self.applyUpdate(newApp) }
            } catch {
                slog("update failed: \(error)")
                DispatchQueue.main.async { self.info("업데이트 실패", "\(error.localizedDescription)") }
            }
        }
    }
    func applyUpdate(_ newApp: URL) {
        let fm = FileManager.default
        let cur = Bundle.main.bundleURL
        let backup = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("windowfinder-old-\(UUID().uuidString).app")
        do {
            try fm.moveItem(at: cur, to: backup)
            do { try fm.moveItem(at: newApp, to: cur) }
            catch { try fm.copyItem(at: newApp, to: cur) } // 볼륨이 다르면 복사
            slog("updated app at \(cur.path)")
            // 새 서버가 뜨도록 기존 내장 서버 종료 후 재실행
            let k = Process()
            k.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
            k.arguments = ["-f", "WindowFinder-server"]
            try? k.run(); k.waitUntilExit()
            let o = Process()
            o.executableURL = URL(fileURLWithPath: "/usr/bin/open")
            o.arguments = ["-n", cur.path]
            try? o.run()
            NSApp.terminate(nil)
        } catch {
            try? fm.moveItem(at: backup, to: cur) // 원복
            slog("apply failed: \(error)")
            info("업데이트 실패", "앱 교체 중 오류: \(error.localizedDescription)")
        }
    }
    func info(_ title: String, _ text: String) {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = text
        a.runModal()
    }

    // ── Finder/CLI 연동: 폴더·파일을 이 앱으로 열기 ──
    func explorerDirectory(forPath p: String) -> String {
        var isDir: ObjCBool = false
        FileManager.default.fileExists(atPath: p, isDirectory: &isDir)
        let path = isDir.boolValue ? p : (p as NSString).deletingLastPathComponent
        return URL(fileURLWithPath: path).standardizedFileURL.path
    }
    func openPathWindow(_ p: String) {
        let dir = explorerDirectory(forPath: p)
        let enc = dir.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? dir
        makeWindow(urlString: "\(BASE)/#\(enc)")
        NSApp.activate(ignoringOtherApps: true)
    }
    // open -a WindowFinder <경로> / Finder '다음으로 열기'
    func application(_ application: NSApplication, open urls: [URL]) {
        var openedDirectories = Set<String>()
        var paths: [String] = []
        for url in urls {
            if url.isFileURL {
                paths.append(url.path)
            } else if url.scheme?.lowercased() == "windowfinder",
                      url.host?.lowercased() == "open",
                      let components = URLComponents(url: url, resolvingAgainstBaseURL: false) {
                paths.append(contentsOf: components.queryItems?
                    .filter { $0.name == "path" }
                    .compactMap(\.value) ?? [])
            }
        }
        for path in paths {
            let dir = explorerDirectory(forPath: path)
            if openedDirectories.insert(dir).inserted {
                openPathWindow(dir)
            }
        }
    }
    // tfe CLI 자동 설치 (쓰기 가능한 표준 bin 경로에 1회)
    func setupCLI() {
        let script = "#!/bin/zsh\nd=\"${1:-$PWD}\"\nd=$(cd \"$d\" 2>/dev/null && pwd || echo \"$d\")\nexec open -a WindowFinder \"$d\"\n"
        let fm = FileManager.default
        for dir in ["/opt/homebrew/bin", "/usr/local/bin"] {
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: dir, isDirectory: &isDir), isDir.boolValue,
                  fm.isWritableFile(atPath: dir) else { continue }
            let dest = "\(dir)/tfe"
            if fm.fileExists(atPath: dest) { return }
            try? script.write(toFile: dest, atomically: true, encoding: .utf8)
            try? fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: dest)
            slog("tfe CLI installed: \(dest)")
            return
        }
    }

    // ── lifecycle ──
    func applicationDidFinishLaunching(_ note: Notification) {
        buildMenu()
        startServerIfNeeded()
        setupCLI()
        // 서비스/문서 열기로 실행된 경우 기본 창을 만들지 않도록 잠시 대기
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
            if self.windows.isEmpty { self.makeWindow(urlString: nil) }
        }
        // Finder 확장 활성화에는 사용자 동의가 필요하다. 최초 한 번 안내하고,
        // 이후에는 앱 메뉴의 "Finder 메뉴 확장 설정…"에서 다시 열 수 있다.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            self.offerFinderExtensionSetupIfNeeded()
        }
        NSApp.activate(ignoringOtherApps: true)
        // 시작 5초 후 + 4시간마다 자동 업데이트 확인
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { self.checkForUpdates(interactive: false) }
        Timer.scheduledTimer(withTimeInterval: 4 * 3600, repeats: true) { _ in
            self.checkForUpdates(interactive: false)
        }
    }

    func probe(_ done: @escaping (Bool) -> Void) {
        var req = URLRequest(url: URL(string: "\(BASE)/api/home")!)
        req.timeoutInterval = 1
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            done((resp as? HTTPURLResponse)?.statusCode == 200)
        }.resume()
    }

    static let serverLog = "/tmp/windowfinder-server.log"
    func startServerIfNeeded() {
        probe { ok in
            if ok { return }
            guard let bin = Bundle.main.path(forResource: "WindowFinder-server", ofType: nil) else {
                slog("server binary not found in bundle"); return
            }
            // 다른 Mac으로 배포된 경우: 격리 속성이 실행을 막을 수 있어 제거 시도
            let x = Process()
            x.executableURL = URL(fileURLWithPath: "/usr/bin/xattr")
            x.arguments = ["-d", "com.apple.quarantine", bin]
            try? x.run(); x.waitUntilExit()

            FileManager.default.createFile(atPath: Self.serverLog, contents: nil)
            let logHandle = FileHandle(forWritingAtPath: Self.serverLog)
            let p = Process()
            p.executableURL = URL(fileURLWithPath: bin)
            p.arguments = ["--serve", String(PORT)]
            p.standardOutput = logHandle ?? FileHandle.nullDevice
            p.standardError = logHandle ?? FileHandle.nullDevice
            do {
                try p.run() // survives app quit; next launch just reuses it
                slog("server spawned pid=\(p.processIdentifier)")
            } catch {
                slog("server spawn failed: \(error)")
                try? "server spawn failed: \(error)\n".write(toFile: Self.serverLog, atomically: false, encoding: .utf8)
            }
        }
    }

    func waitAndLoad(_ wv: DropWebView, _ urlString: String, attempts: Int) {
        probe { ok in
            DispatchQueue.main.async {
                if ok {
                    wv.load(URLRequest(url: URL(string: urlString) ?? URL(string: "\(BASE)/")!))
                } else if attempts > 0 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                        self.waitAndLoad(wv, urlString, attempts: attempts - 1)
                    }
                } else {
                    let log = (try? String(contentsOfFile: Self.serverLog, encoding: .utf8)) ?? "(로그 없음)"
                    let tail = log.split(separator: "\n").suffix(15).joined(separator: "\n")
                    let esc = tail.replacingOccurrences(of: "<", with: "&lt;")
                    wv.loadHTMLString("""
                    <body style='font-family:-apple-system,sans-serif;padding:32px;background:#1e1e1e;color:#eee'>
                    <h2>서버를 시작하지 못했습니다</h2>
                    <p>포트 \(PORT)에서 내장 서버가 응답하지 않습니다. 아래 로그를 확인하거나
                    앱을 <b>/Applications로 이동한 뒤</b> 다시 실행해 보세요.
                    (처음 실행이라면 앱을 우클릭 → ‘열기’로 승인해야 할 수 있습니다)</p>
                    <pre style='background:#111;padding:12px;border-radius:8px;white-space:pre-wrap;font-size:12px'>\(esc)</pre>
                    <p style='color:#999;font-size:12px'>전체 로그: \(Self.serverLog)</p>
                    </body>
                    """, baseURL: nil)
                }
            }
        }
    }

    func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "업데이트 확인…", action: #selector(AppDelegate.checkUpdatesAction(_:)), keyEquivalent: "")
        appMenu.addItem(withTitle: "Finder 메뉴 확장 설정…", action: #selector(AppDelegate.configureFinderExtensionAction(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "WindowFinder 숨기기", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "WindowFinder 종료", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let fileItem = NSMenuItem(); main.addItem(fileItem)
        let file = NSMenu(title: "파일")
        file.addItem(withTitle: "새 창", action: #selector(AppDelegate.newWindowAction(_:)), keyEquivalent: "n")
        file.addItem(withTitle: "창 닫기", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        fileItem.submenu = file

        // web page handlers get first shot at ⌘C/⌘V (they preventDefault);
        // these are fallbacks so text fields still cut/copy/paste natively
        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "편집")
        edit.addItem(withTitle: "잘라내기", action: Selector(("cut:")), keyEquivalent: "x")
        edit.addItem(withTitle: "복사", action: Selector(("copy:")), keyEquivalent: "c")
        edit.addItem(withTitle: "붙여넣기", action: Selector(("paste:")), keyEquivalent: "v")
        edit.addItem(withTitle: "모두 선택", action: Selector(("selectAll:")), keyEquivalent: "a")
        editItem.submenu = edit

        let winItem = NSMenuItem(); main.addItem(winItem)
        let win = NSMenu(title: "윈도우")
        win.addItem(withTitle: "최소화", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "확대/축소", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        win.addItem(NSMenuItem.separator())
        win.addItem(withTitle: "모두 앞으로 가져오기", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        winItem.submenu = win
        NSApp.windowsMenu = win // AppKit이 열린 창 목록을 이 메뉴에 자동으로 추가

        NSApp.mainMenu = main
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { makeWindow(urlString: nil) } // Dock 클릭으로 재활성화 시 창 복원
        return true
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
