import Foundation

enum ProcessingMode: String {
    case rewrite
    case prompt

    var resourceName: String { self == .rewrite ? "editor" : "prompt" }

    var instruction: String {
        switch self {
        case .rewrite:
            return "Переформулируй реплику пользователя в поле draft по правилам редактора. Верни её от лица пользователя."
        case .prompt:
            return "Подготовь промпт для Codex из поля draft по заданным правилам. Верни его от лица пользователя."
        }
    }

    init(argument: String) throws {
        guard let mode = Self(rawValue: argument) else {
            throw DraftError("Неизвестный режим «\(argument)». Выберите rewrite или prompt.")
        }
        self = mode
    }

    static func fromCommandLine(_ arguments: [String]) throws -> RewriteCommand {
        let usage = "Использование: CalmCodex --stdin|--stdin-json [--mode rewrite|prompt] [--allow-empty для prompt] [--model NAME] [--reasoning-effort low|medium|high|xhigh|max] [--ultracave|--no-ultracave]."
        guard let first = arguments.first, let format = RewriteInputFormat(rawValue: first) else {
            throw DraftError(usage)
        }
        var mode = Self.rewrite
        var allowEmpty = false
        var model: String?
        var reasoningEffort: ReasoningEffort?
        var ultracave: Bool?
        var seen = Set<String>()
        var index = 1
        while index < arguments.count {
            let option = arguments[index]
            guard seen.insert(option).inserted else { throw DraftError(usage) }
            index += 1
            if option == "--allow-empty" {
                allowEmpty = true
                continue
            }
            if option == "--ultracave" || option == "--no-ultracave" {
                guard ultracave == nil else { throw DraftError(usage) }
                ultracave = option == "--ultracave"
                continue
            }
            guard ["--mode", "--model", "--reasoning-effort"].contains(option),
                  index < arguments.count else { throw DraftError(usage) }
            let value = arguments[index]
            index += 1
            switch option {
            case "--mode": mode = try Self(argument: value)
            case "--model": model = try ModelSettings.validateModel(value)
            default: reasoningEffort = try ReasoningEffort(argument: value)
            }
        }
        guard !allowEmpty || mode == .prompt else { throw DraftError(usage) }
        return RewriteCommand(mode: mode, allowEmpty: allowEmpty, inputFormat: format,
                              model: model, reasoningEffort: reasoningEffort, ultracave: ultracave)
    }
}

enum RewriteInputFormat: String {
    case text = "--stdin"
    case json = "--stdin-json"
}

struct RewriteCommand {
    let mode: ProcessingMode
    let allowEmpty: Bool
    let inputFormat: RewriteInputFormat
    let model: String?
    let reasoningEffort: ReasoningEffort?
    let ultracave: Bool?
}
