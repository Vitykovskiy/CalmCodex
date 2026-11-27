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

        for invalid in [
            "", "⟦K1⟧", draft.masked + "⟦K1⟧", draft.masked + "⟦K5⟧",
            "Сохрани ⟦K2⟧, ⟦K1⟧ и ⟦K3⟧.\n⟦K4⟧",
            "Сохрани ⟦K1⟧, ⟦K2⟧ и ⟦K3⟧. ⟦K4⟧",
            "Сохрани ⟦K1⟧, ⟦K2⟧ и ⟦K3⟧.\n⟦K4⟧.",
            "Сохрани ⟦K1⟧, ⟦K2⟧ и ⟦K3⟧.\n    ⟦K4⟧",
            "Сохрани ⟦K1⟧, ⟦K2⟧ и ⟦K3⟧.\n\t⟦K4⟧"
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

        let windowsLines = try ProtectedDraft("Покажи:\r\n«HTTP 429»\r\nЗатем объясни.")
        precondition(windowsLines.masked == "Покажи:\r\n⟦K1⟧\r\nЗатем объясни.")
        let windowsRestored = try windowsLines.restore("Покажи:\r\n⟦K1⟧\r\nЗатем объясни.")
        precondition(windowsRestored == windowsLines.original)
        do {
            _ = try windowsLines.restore("Покажи: ⟦K1⟧\r\nЗатем объясни.")
            fatalError("Accepted a merged standalone literal")
        } catch is DraftError {}

        let indented = try ProtectedDraft("Покажи:\n  «HTTP 429»\nЗатем объясни.")
        let indentedRestored = try indented.restore("Покажи:\n  ⟦K1⟧\nЗатем объясни.")
        precondition(indentedRestored == indented.original)
        do {
            _ = try indented.restore("Покажи:\n⟦K1⟧\nЗатем объясни.")
            fatalError("Accepted a changed standalone indentation")
        } catch is DraftError {}
        print("Draft tests passed")
    }
}
