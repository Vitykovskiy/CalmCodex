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

    static func markers(in text: String) throws -> [String] {
        let expression = try NSRegularExpression(pattern: "⟦[^⟧]+⟧")
        let source = text as NSString
        return expression.matches(in: text, range: NSRange(location: 0, length: source.length))
            .map { source.substring(with: $0.range) }
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
        let prepared = try decoded.prepareModelInput(protectedDraft: protected, ultracave: true)
        let modelInput = try JSONDecoder().decode(ModelInput.self, from: Data(prepared.json.utf8))
        precondition(modelInput.draft == "Я для красоты указал ⟦K1⟧?")
        precondition(modelInput.ultracave)
        precondition(modelInput.context?.before == before)
        precondition(modelInput.context?.after == ["Объясни, почему ⟦CA1K1⟧ пуст. Код пока не меняй."])
        precondition(!prepared.json.contains("etag") && !prepared.json.contains("без новых зависимостей"))
        precondition(!modelInput.draft.contains("etag") && !modelInput.draft.contains("макет"))
        let restored = try prepared.restore("Соблюдай требование ⟦K1⟧.")
        precondition(restored == " Соблюдай требование «без новых зависимостей».\n")
        // A neighbouring literal cannot silently become an extra target marker.
        rejects { _ = try protected.restore("Соблюдай ⟦K1⟧. Объясни ⟦K2⟧.") }
        rejects { _ = try prepared.restore("Соблюдай ⟦K1⟧. Объясни ⟦CA1K1⟧.") }
        rejects { _ = try prepared.restore("⟦CA1K1⟧", allowEmpty: true) }

        // Review canaries must be absent from the full outbound JSON, regardless of target position.
        let contextCanaries = [
            "src/fixture-only.swift", "REVIEW_CANARY_QUOTED_4351", "CANARY_INLINE_6230",
            "CANARY_FENCE_9102", "CANARY_URL_2046"
        ]
        let canaryRequest = RewriteRequest(draft: " Объясни «TARGET_CANARY_7103».\n", context: RewriteContext(
            before: [
                "Открой src/fixture-only.swift и объясни «REVIEW_CANARY_QUOTED_4351».",
                "Проверь `CANARY_INLINE_6230()`.\n",
                " \t", "", "Отдельно опиши результат."
            ],
            after: [
                "Пример:\n```swift\nCANARY_FENCE_9102()\n```\nОбъясни причину.",
                "Ссылка https://example.invalid/CANARY_URL_2046.",
                "Сохрани API."
            ]))
        let canaryInput = try canaryRequest.prepareModelInput(
            protectedDraft: ProtectedDraft(canaryRequest.draft), ultracave: false)
        for canary in contextCanaries + ["TARGET_CANARY_7103"] {
            precondition(!canaryInput.json.contains(canary), "A protected literal reached the model payload")
        }
        let maskedCanaries = try JSONDecoder().decode(ModelInput.self, from: Data(canaryInput.json.utf8))
        precondition(maskedCanaries.context?.before.count == 5 && maskedCanaries.context?.after.count == 3)
        precondition(maskedCanaries.context?.before[2] == " \t" && maskedCanaries.context?.before[3] == "")
        precondition(maskedCanaries.context?.before[4] == "Отдельно опиши результат.")
        precondition(maskedCanaries.context?.after[2] == "Сохрани API.")
        precondition(maskedCanaries.context?.before[0].hasPrefix("Открой ") == true)
        precondition(maskedCanaries.context?.before[1].hasSuffix("\n") == true)
        precondition(maskedCanaries.context?.after[0].hasPrefix("Пример:\n") == true)
        precondition(maskedCanaries.context?.after[0].hasSuffix("\nОбъясни причину.") == true)
        let targetMarkers = try markers(in: maskedCanaries.draft)
        let contextMarkers = try markers(in: (maskedCanaries.context!.before + maskedCanaries.context!.after).joined(separator: "\n"))
        precondition(contextMarkers.count == contextCanaries.count)
        precondition(Set(contextMarkers).count == contextMarkers.count)
        precondition(Set(contextMarkers).isDisjoint(with: Set(targetMarkers)))
        for marker in contextMarkers {
            rejects { _ = try canaryInput.restore("Объясни \(targetMarkers[0]). \(marker)") }
        }
        let restoredCanary = try canaryInput.restore("Объясни \(targetMarkers[0]).")
        precondition(restoredCanary == canaryRequest.draft)

        // User text that resembles a namespace cannot collide with generated context markers.
        let collisionRequest = RewriteRequest(draft: "Сохрани ⟦CB1K1⟧ и объясни «TARGET_COLLISION».",
            context: RewriteContext(before: ["Метка ⟦CCB1K1⟧. Открой src/before-canary.swift."],
                                    after: ["Объясни «AFTER_COLLISION»."]))
        let collisionInput = try collisionRequest.prepareModelInput(
            protectedDraft: ProtectedDraft(collisionRequest.draft), ultracave: false)
        let maskedCollision = try JSONDecoder().decode(ModelInput.self, from: Data(collisionInput.json.utf8))
        precondition(maskedCollision.context?.before[0] == "Метка ⟦CCB1K1⟧. Открой ⟦CCCB1K1⟧.")
        precondition(maskedCollision.context?.after[0] == "Объясни ⟦CCCA1K1⟧.")
        let restoredCollision = try collisionInput.restore(maskedCollision.draft)
        precondition(restoredCollision == collisionRequest.draft)
        rejects { _ = try collisionInput.restore(maskedCollision.draft + " ⟦CCCA1K1⟧") }

        let noContext = try RewriteRequest(data: Data(#"{"draft":"Настоящий вопрос?"}"#.utf8), format: .json)
        precondition(noContext.context == nil)
        // The text envelope cannot override the application's compression setting.
        for enabled in [false, true] {
            let untrusted = "{\"draft\":\"Настоящий вопрос?\",\"ultracave\":\(!enabled)}"
            let envelope = try RewriteRequest(data: Data(untrusted.utf8), format: .json)
            for request in [envelope, legacy] {
                let protectedInput = try ProtectedDraft(request.draft)
                let output = try request.prepareModelInput(protectedDraft: protectedInput, ultracave: enabled)
                let configuredInput = try JSONDecoder().decode(ModelInput.self, from: Data(output.json.utf8))
                precondition(configuredInput.ultracave == enabled)
                precondition(configuredInput.draft == protectedInput.masked && configuredInput.context == nil)
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
