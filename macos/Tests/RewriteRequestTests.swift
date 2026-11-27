import Foundation

@main
struct RewriteRequestTests {
    private struct ModelInput: Decodable {
        let draft: String
        let context: RewriteContext?
        let ultracave: Bool
    }

    static func rejects(_ operation: () throws -> Void) {
        do {
            try operation()
            fatalError("Expected invalid input to fail")
        } catch is DraftError {
        } catch {
            fatalError("Expected a user-facing DraftError, received \(error)")
        }
    }

    static func main() throws {
        let plain = " \nПочему 403? Код не меняй.\t"
        let legacy = try RewriteRequest(data: Data(plain.utf8), format: .text)
        precondition(legacy.draft == plain && legacy.context == nil)
        rejects { _ = try RewriteRequest(data: Data([0xFF]), format: .text) }

        let before = ["Снова нет макетов — только текст.", "Добавь к элементу фрагмент макета."]
        let after = ["Объясни, почему `etag` пуст. Код пока не меняй."]
        let target = " Я для красоты указал «без новых зависимостей»?\n"
        let source = RewriteRequest(draft: target, context: RewriteContext(before: before, after: after))
        let encoded = try JSONEncoder().encode(source)
        let decoded = try RewriteRequest(data: encoded, format: .json)
        precondition(decoded.draft == target)
        precondition(decoded.context?.before == before && decoded.context?.after == after)
        let protected = try ProtectedDraft(decoded.draft)
        let payload = try decoded.modelPayload(maskedDraft: protected.masked, ultracave: true)
        let modelInput = try JSONDecoder().decode(ModelInput.self, from: Data(payload.utf8))
        precondition(modelInput.draft == "Я для красоты указал ⟦K1⟧?")
        precondition(modelInput.ultracave)
        precondition(modelInput.context == source.context)
        precondition(!modelInput.draft.contains("etag") && !modelInput.draft.contains("макет"))
        let restored = try protected.restore("Соблюдай требование ⟦K1⟧.")
        precondition(restored == " Соблюдай требование «без новых зависимостей».\n")
        // A neighbouring literal cannot silently become an extra target marker.
        rejects { _ = try protected.restore("Соблюдай ⟦K1⟧. Объясни ⟦K2⟧.") }

        let noContext = try RewriteRequest(data: Data(#"{"draft":"Настоящий вопрос?"}"#.utf8), format: .json)
        precondition(noContext.context == nil)
        // The text envelope cannot override the application's compression setting.
        for enabled in [false, true] {
            let untrusted = "{\"draft\":\"Настоящий вопрос?\",\"ultracave\":\(!enabled)}"
            let envelope = try RewriteRequest(data: Data(untrusted.utf8), format: .json)
            for request in [envelope, legacy] {
                let output = try request.modelPayload(maskedDraft: request.draft, ultracave: enabled)
                let configuredInput = try JSONDecoder().decode(ModelInput.self, from: Data(output.utf8))
                precondition(configuredInput.ultracave == enabled)
                precondition(configuredInput.draft == request.draft && configuredInput.context == nil)
            }
        }
        for invalid in [
            "not json", #"{}"#, #"{"draft":5}"#, #"{"draft":null}"#,
            #"{"draft":"text","context":[]}"#,
            #"{"draft":"text","context":{"before":"wrong","after":[]}}"#,
            #"{"draft":"text","context":{"before":[],"after":[5]}}"#,
            #"{"draft":"text","context":{"before":[]}}"#
        ] {
            rejects { _ = try RewriteRequest(data: Data(invalid.utf8), format: .json) }
        }

        let suite = "CalmCodex-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let fallback = try ModelSettings(defaults: defaults)
        precondition(fallback.model == "gpt-6-luna" && fallback.reasoningEffort == .medium && fallback.ultracave)
        defaults.set("gpt-6.2-sol", forKey: "model")
        defaults.set("high", forKey: "reasoningEffort")
        defaults.set(false, forKey: "ultracave")
        let configured = try ModelSettings(defaults: defaults)
        precondition(configured.model == "gpt-6.2-sol" && configured.reasoningEffort == .high && !configured.ultracave)
        let compressed = try ModelSettings(ultracaveOverride: true, defaults: defaults)
        precondition(compressed.ultracave)
        defaults.set(true, forKey: "ultracave")
        let uncompressed = try ModelSettings(ultracaveOverride: false, defaults: defaults)
        precondition(!uncompressed.ultracave)
        for invalidToggle in [0, 1, "true", "false", ""] as [Any] {
            defaults.set(invalidToggle, forKey: "ultracave")
            rejects { _ = try ModelSettings(defaults: defaults) }
        }
        defaults.set(false, forKey: "ultracave")
        let overridden = try ModelSettings(modelOverride: "gpt-6-luna", reasoningOverride: .low, defaults: defaults)
        precondition(overridden.model == "gpt-6-luna" && overridden.reasoningEffort == .low)
        let modelOnly = try ModelSettings(modelOverride: "gpt-6-luna", defaults: defaults)
        precondition(modelOnly.model == "gpt-6-luna" && modelOnly.reasoningEffort == .high)
        let reasoningOnly = try ModelSettings(reasoningOverride: .medium, defaults: defaults)
        precondition(reasoningOnly.model == "gpt-6.2-sol" && reasoningOnly.reasoningEffort == .medium)

        for invalidModel in ["", " ", "gpt-6-luna\n", "--model", "gpt 6"] {
            defaults.set(invalidModel, forKey: "model")
            rejects { _ = try ModelSettings(defaults: defaults) }
        }
        defaults.set(3, forKey: "model")
        rejects { _ = try ModelSettings(defaults: defaults) }
        defaults.set("gpt-6-luna", forKey: "model")
        for invalidEffort in ["", "none", "ultra", " medium"] {
            defaults.set(invalidEffort, forKey: "reasoningEffort")
            rejects { _ = try ModelSettings(defaults: defaults) }
        }
        defaults.set(true, forKey: "reasoningEffort")
        rejects { _ = try ModelSettings(defaults: defaults) }
        defaults.set("invalid model", forKey: "model")
        defaults.set("false", forKey: "ultracave")
        // Only effective settings are validated: a valid explicit selection overrides bad saved values.
        let rescue = try ModelSettings(modelOverride: "gpt-6.2-sol", reasoningOverride: .medium,
                                       ultracaveOverride: false, defaults: defaults)
        precondition(rescue.model == "gpt-6.2-sol" && rescue.reasoningEffort == .medium && !rescue.ultracave)
        print("Rewrite request and model settings tests passed")
    }
}
