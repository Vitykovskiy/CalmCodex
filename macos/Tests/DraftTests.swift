import Foundation

@main
struct DraftTests {
    static func main() throws {
        let tick = "\u{60}"
        let fence = String(repeating: tick, count: 4)
        let code = "\(fence)sh\nprintf '%s\\n' '\(tick)\(tick)\(tick)'\n\(fence)"
        let raw = " \nБлин, сохрани «HTTP 429», \(tick)retry_count\(tick) и src/Login.tsx.\n\(code)\n "
        let draft = try ProtectedDraft(raw)
        precondition(draft.masked == "Блин, сохрани ⟦K1⟧, ⟦K2⟧ и ⟦K3⟧.\n⟦K4⟧")
        let restored = try draft.restore("Сохрани ⟦K1⟧, ⟦K2⟧ и ⟦K3⟧.\n⟦K4⟧")
        precondition(restored == raw.replacingOccurrences(of: "Блин, сохрани", with: "Сохрани"))
        let noise = try ProtectedDraft("Блин!")
        let removed = try noise.restore(" \n", allowEmpty: true)
        precondition(removed.isEmpty)
        do {
            _ = try draft.restore("", allowEmpty: true)
            fatalError("Dropped protected fragments from an empty region")
        } catch is DraftError {}

        for invalid in [
            "", "⟦K1⟧", draft.masked + "⟦K1⟧", draft.masked + "⟦K5⟧",
            "Сохрани ⟦K2⟧, ⟦K1⟧ и ⟦K3⟧.\n⟦K4⟧",
            "Сохрани ⟦K1⟧, ⟦K2⟧ и ⟦K3⟧. ⟦K4⟧",
            "Сохрани ⟦K1⟧, ⟦K2⟧ и ⟦K3⟧.\n⟦K4⟧."
        ] {
            do { _ = try draft.restore(invalid); fatalError("Accepted an invalid rewrite") }
            catch is DraftError {}
        }
        let collision = try ProtectedDraft("Оставь ⟦K1⟧ и \(tick)x\(tick).")
        let roundTrip = try collision.restore(collision.masked)
        precondition(collision.masked.contains("⟦KK1⟧") && roundTrip == collision.original)
        let standalone = try ProtectedDraft(" \n\(code)\n")
        precondition(standalone.isSingleLiteral)

        let correction = try ProtectedDraft("Открой \(tick)archive.csv\(tick). Нет, только \(tick)active.csv\(tick).")
        let corrected = try correction.restore("Открой ⟦K1⟧. Нет, только ⟦K2⟧.")
        precondition(corrected == correction.original)

        for changedWhitespace in ["    ⟦K4⟧", "\t⟦K4⟧", "  ⟦K4⟧  \t"] {
            let repaired = try draft.restore("Сохрани ⟦K1⟧, ⟦K2⟧ и ⟦K3⟧.\n\(changedWhitespace)")
            precondition(repaired == restored)
        }

        let windowsLines = try ProtectedDraft("Покажи:\r\n  «HTTP 429»   \r\nЗатем объясни.")
        precondition(windowsLines.masked == "Покажи:\r\n  ⟦K1⟧   \r\nЗатем объясни.")
        let windowsRestored = try windowsLines.restore("Покажи:\r\n⟦K1⟧\r\nЗатем объясни.")
        precondition(windowsRestored == windowsLines.original)
        do {
            _ = try windowsLines.restore("Покажи: ⟦K1⟧\r\nЗатем объясни.")
            fatalError("Accepted a merged standalone literal")
        } catch is DraftError {}

        let spacedRaw = "Блин, найди причину ошибки.\n  \(tick)error.log\(tick)   \nТолько объясни, ничего не меняй."
        let spaced = try ProtectedDraft(spacedRaw)
        let expectedSpaced = spacedRaw.replacingOccurrences(of: "Блин, найди", with: "Найди")
        for outputLine in ["⟦K1⟧", "  ⟦K1⟧   ", "\t    ⟦K1⟧\t"] {
            let repaired = try spaced.restore("Найди причину ошибки.\n\(outputLine)\nТолько объясни, ничего не меняй.")
            precondition(repaired == expectedSpaced)
        }
        for outputLine in ["Ошибка: ⟦K1⟧", "⟦K1⟧."] {
            do {
                _ = try spaced.restore("Найди причину ошибки.\n\(outputLine)\nТолько объясни, ничего не меняй.")
                fatalError("Accepted text joined to a standalone literal")
            } catch is DraftError {}
        }

        let edgeWhitespace = try ProtectedDraft(" \t\(tick)first.log\(tick)   \nТолько объясни.\n  \(tick)last.log\(tick) \t\n")
        let edgeRestored = try edgeWhitespace.restore("⟦K1⟧\nТолько объясни.\n⟦K2⟧")
        precondition(edgeRestored == edgeWhitespace.original)
        print("Draft tests passed")
    }
}
