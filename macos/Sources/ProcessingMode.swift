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

    static func fromCommandLine(_ arguments: [String]) throws -> (mode: Self, allowEmpty: Bool) {
        if arguments == ["--stdin"] { return (.rewrite, false) }
        if arguments == ["--stdin", "--mode", "prompt", "--allow-empty"] { return (.prompt, true) }
        guard arguments.count == 3, arguments[0] == "--stdin", arguments[1] == "--mode" else {
            throw DraftError("Использование: CalmCodex --stdin [--mode rewrite|prompt [--allow-empty для prompt]].")
        }
        return (try Self(argument: arguments[2]), false)
    }
}
