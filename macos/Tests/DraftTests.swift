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

        for invalid in ["", "⟦K1⟧", draft.masked + "⟦K1⟧", draft.masked + "⟦K5⟧"] {
            do { _ = try draft.restore(invalid); fatalError("Accepted an invalid rewrite") }
            catch is DraftError {}
        }
        let collision = try ProtectedDraft("Оставь ⟦K1⟧ и \(tick)x\(tick).")
        let roundTrip = try collision.restore(collision.masked)
        precondition(collision.masked.contains("⟦KK1⟧") && roundTrip == collision.original)
        let standalone = try ProtectedDraft(" \n\(code)\n")
        precondition(standalone.isSingleLiteral)
        print("Draft tests passed")
    }
}
