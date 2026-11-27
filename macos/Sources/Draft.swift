import Foundation

struct DraftError: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}

struct ProtectedDraft {
    let original: String
    let masked: String
    private let prefix: String
    private let leadingSpace: String
    private let trailingSpace: String
    private let literals: [String]

    // A fenced block, an inline code span, a quoted string, or a file path is one editing unit.
    // Long fences may contain shorter fences. An unclosed block extends to the end of the draft.
    private static let literalPattern = try! NSRegularExpression(pattern: [
        #"(?m)^[ \t]{0,3}(\x60{3,})[^\r\n]*\r?\n[\s\S]*?(?:^[ \t]{0,3}\1\x60*[ \t]*\r?$|\z)"#,
        #"(?m)^[ \t]{0,3}(~{3,})[^\r\n]*\r?\n[\s\S]*?(?:^[ \t]{0,3}\2~*[ \t]*\r?$|\z)"#,
        #"(\x60+)(?!\x60)[^\r\n]+?(?<!\x60)\3(?!\x60)"#,
        #"«[^»\r\n]+»|“[^”\r\n]+”|"(?:\\.|[^"\\\r\n])+""#,
        #"(?<![\w/])(?:https?://|(?:[A-Za-z]:\\)|(?:[.~]{0,2}/)|(?:[\w.@+-]+/))[\w./~:@%?&=#+\\-]*[\w/#-]"#
    ].joined(separator: "|"))

    init(_ raw: String) throws {
        guard let first = raw.firstIndex(where: { !$0.isWhitespace }),
              let last = raw.lastIndex(where: { !$0.isWhitespace }) else {
            throw DraftError("Выделите текст запроса.")
        }
        original = raw
        leadingSpace = String(raw[..<first])
        trailingSpace = String(raw[raw.index(after: last)...])
        let body = String(raw[first...last])
        var marker = "⟦K"
        while body.contains(marker) { marker += "K" }
        prefix = marker

        let text = body as NSString
        var parts: [String] = []
        var result = ""
        var cursor = 0
        for match in Self.literalPattern.matches(in: body, range: NSRange(location: 0, length: text.length)) {
            result += text.substring(with: NSRange(location: cursor, length: match.range.location - cursor))
            result += "\(marker)\(parts.count + 1)⟧"
            parts.append(text.substring(with: match.range))
            cursor = NSMaxRange(match.range)
        }
        masked = result + text.substring(from: cursor)
        literals = parts
    }

    var isSingleLiteral: Bool { literals.count == 1 && masked == "\(prefix)1⟧" }

    func restore(_ candidate: String) throws -> String {
        var text = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            throw DraftError("Уточните, что случилось или что нужно сделать. Выделенный текст сохранён.")
        }
        // Validate before replacement. The random-looking text inside a literal is user data too.
        let tokens = literals.indices.map { "\(prefix)\($0 + 1)⟧" }
        guard tokens.allSatisfy({ text.components(separatedBy: $0).count == 2 }),
              text.components(separatedBy: prefix).count == tokens.count + 1 else {
            throw DraftError("Luna изменила буквальный фрагмент. Выделенный текст сохранён.")
        }
        for (token, literal) in zip(tokens, literals) {
            text = text.replacingOccurrences(of: token, with: literal)
        }
        return leadingSpace + text + trailingSpace
    }
}
