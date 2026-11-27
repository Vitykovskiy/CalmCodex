import Darwin
import Foundation

private struct Reply: Decodable { let text: String }

struct Rewriter {
    let files = FileManager.default
    let defaults = UserDefaults.standard

    private func executable() throws -> URL {
        if let configured = defaults.string(forKey: "cliPath"), !configured.isEmpty {
            guard configured.hasPrefix("/"), files.isExecutableFile(atPath: configured) else {
                throw DraftError("Проверьте путь cliPath к Codex CLI в настройках CalmCodex.")
            }
            return URL(fileURLWithPath: configured)
        }
        #if arch(arm64)
        let platform = "macos-aarch64"
        #else
        let platform = "macos-x86_64"
        #endif
        let extensions = files.homeDirectoryForCurrentUser.appendingPathComponent(".vscode/extensions")
        let entries = (try? files.contentsOfDirectory(atPath: extensions.path)) ?? []
        let bundled = entries.filter { $0.hasPrefix("openai.chatgpt-") }
            .sorted { $0.compare($1, options: .numeric) == .orderedDescending }
            .map { extensions.appendingPathComponent("\($0)/bin/\(platform)/codex").path }
        let candidates = bundled + [
            "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
            "/Applications/Codex.app/Contents/Resources/codex",
            "/opt/homebrew/bin/codex",
            "/usr/local/bin/codex"
        ]
        guard let path = candidates.first(where: files.isExecutableFile(atPath:)) else {
            throw DraftError("Установите расширение Codex для VS Code или укажите cliPath к Codex CLI.")
        }
        return URL(fileURLWithPath: path)
    }

    func rewrite(_ original: String) throws -> String {
        let draft = try ProtectedDraft(original)
        if draft.isSingleLiteral { return original }
        let binary = try executable()
        guard let instructions = Bundle.main.url(forResource: "editor", withExtension: "txt"),
              let schema = Bundle.main.url(forResource: "response", withExtension: "json") else {
            throw DraftError("Файлы службы повреждены. Переустановите CalmCodex из архива.")
        }
        let model = defaults.string(forKey: "model") ?? "gpt-6-luna"
        let temp = files.temporaryDirectory.appendingPathComponent("CalmCodex-\(UUID().uuidString)")
        try files.createDirectory(at: temp, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? files.removeItem(at: temp) }

        let encoder = JSONEncoder()
        encoder.outputFormatting = .withoutEscapingSlashes
        let instructionPath = String(decoding: try encoder.encode(instructions.path), as: UTF8.self)
        let payload = String(decoding: try encoder.encode(["draft": draft.masked]), as: UTF8.self)
        let input = Data(("Переформулируй реплику пользователя в поле draft по правилам редактора. Верни её от лица пользователя.\n" + payload).utf8)
        let result = temp.appendingPathComponent("result.json")
        let diagnostic = temp.appendingPathComponent("diagnostic.jsonl")
        guard files.createFile(atPath: diagnostic.path, contents: nil) else {
            throw DraftError("Не удалось создать временный файл диагностики.")
        }
        let log = try FileHandle(forWritingTo: diagnostic)
        defer { try? log.close() }
        let process = Process()
        process.executableURL = binary
        process.currentDirectoryURL = temp
        process.arguments = [
            "-a", "never", "exec", "--ignore-user-config", "--ignore-rules", "--ephemeral",
            "--skip-git-repo-check", "--sandbox", "read-only", "--model", model,
            "--output-schema", schema.path, "--output-last-message", result.path, "--json",
            "-c", "model_instructions_file=\(instructionPath)", "-c", "model_reasoning_effort=\"low\"",
            "-c", "project_doc_max_bytes=0", "-c", "skills.include_instructions=false",
            "-c", "include_environment_context=false", "-c", "web_search=\"disabled\"",
            "-c", "include_collaboration_mode_instructions=false", "-c", "include_apps_instructions=false"
        ] + ["shell_tool", "unified_exec", "hooks", "apps", "plugins", "code_mode", "browser_use",
             "image_generation", "multi_agent_v2", "view_image"].flatMap { ["--disable", $0] } + ["-"]
        process.standardOutput = log
        process.standardError = log
        let pipe = Pipe()
        process.standardInput = pipe
        let finished = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in finished.signal() }
        try process.run()
        let writer = pipe.fileHandleForWriting
        DispatchQueue.global().async {
            defer { try? writer.close() }
            try? writer.write(contentsOf: input)
        }
        if finished.wait(timeout: .now() + 65) == .timedOut {
            if process.isRunning { process.terminate() }
            if finished.wait(timeout: .now() + 1) == .timedOut && process.isRunning {
                kill(process.processIdentifier, SIGKILL)
                process.waitUntilExit()
            }
            throw DraftError("Luna не ответила за 65 секунд. Выделенный текст сохранён.")
        }
        guard process.terminationStatus == 0 else {
            let details = (try? String(contentsOf: diagnostic, encoding: .utf8)) ?? ""
            throw failure(details: details.lowercased(), model: model)
        }
        guard let data = try? Data(contentsOf: result),
              let response = try? JSONDecoder().decode(Reply.self, from: data) else {
            throw DraftError("Codex вернул неполный ответ. Выделенный текст сохранён.")
        }
        return try draft.restore(response.text)
    }

    private func failure(details: String, model: String) -> DraftError {
        if ["401", "unauthorized", "not logged in", "sign in", "refresh token"].contains(where: details.contains) {
            return DraftError("Войдите в Codex и повторите команду.")
        }
        if ["429", "quota", "rate limit", "usage limit"].contains(where: details.contains) {
            return DraftError("Лимит Codex исчерпан. Повторите команду позже.")
        }
        if ["model_not_found", "not supported", "does not exist", "not available"].contains(where: details.contains) {
            return DraftError("Проверьте доступ к модели \(model) в Codex.")
        }
        if details.contains("unexpected argument") || details.contains("unknown feature") {
            return DraftError("Обновите расширение Codex для VS Code. Его CLI не поддерживает параметры службы.")
        }
        return DraftError("Не удалось получить ответ от Codex. Проверьте подключение и вход в Codex.")
    }
}
