import AppKit
import Darwin

// An early CLI exit must surface as an error instead of terminating the service on EPIPE.
signal(SIGPIPE, SIG_IGN)

final class ServiceProvider: NSObject {
    private var idleTimer: Timer?
    private var inProgress = false

    func startIdleTimer() {
        idleTimer?.invalidate()
        idleTimer = Timer.scheduledTimer(withTimeInterval: 90, repeats: false) { _ in
            NSApplication.shared.terminate(nil)
        }
    }

    @objc(rewriteDraft:userData:error:)
    func rewriteDraft(_ board: NSPasteboard, userData: String?,
                      error errorPointer: AutoreleasingUnsafeMutablePointer<NSString?>) {
        guard !inProgress else {
            errorPointer.pointee = "Предыдущий запрос ещё обрабатывается."
            return
        }
        inProgress = true
        idleTimer?.invalidate()
        defer { inProgress = false; startIdleTimer() }
        do {
            guard let source = board.string(forType: .string) else {
                throw DraftError("Выделите текст в поле ввода.")
            }
            let mode = try ProcessingMode(argument: userData ?? "rewrite")
            let result = try Rewriter().rewrite(source, mode: mode)
            // The Services pasteboard belongs to this invocation; the general clipboard stays intact.
            board.clearContents()
            guard board.setString(result, forType: .string) else {
                throw DraftError("Не удалось вернуть текст в поле ввода.")
            }
        } catch {
            errorPointer.pointee = error.localizedDescription as NSString
        }
    }
}

if CommandLine.arguments.dropFirst() == ["--register-shortcut"] {
    do {
        try registerServiceShortcut()
    } catch {
        FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
        exit(EXIT_FAILURE)
    }
// AppKit may supply its own launch arguments; our CLI uses long options.
} else if CommandLine.arguments.dropFirst().contains(where: { $0.hasPrefix("--") }) {
    do {
        let mode = try ProcessingMode.fromCommandLine(Array(CommandLine.arguments.dropFirst()))
        let data = FileHandle.standardInput.readDataToEndOfFile()
        guard let input = String(data: data, encoding: .utf8) else {
            throw DraftError("Нужен текст в кодировке UTF-8.")
        }
        let output = try Rewriter().rewrite(input, mode: mode)
        FileHandle.standardOutput.write(Data(output.utf8))
    } catch {
        FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
        exit(EXIT_FAILURE)
    }
} else {
    let provider = ServiceProvider()
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    app.servicesProvider = provider
    NSRegisterServicesProvider(provider, "CalmCodex")
    provider.startIdleTimer()
    withExtendedLifetime(provider) { app.run() }
}
