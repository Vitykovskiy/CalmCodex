import AppKit

func registerServiceShortcut() throws {
    guard let prefs = UserDefaults(suiteName: "pbs") else {
        throw DraftError("Не удалось открыть настройки сочетаний клавиш macOS.")
    }
    let name = "local.calmcodex.service - Переформулировать для Codex - rewriteDraft"
    var services = prefs.dictionary(forKey: "NSServicesStatus") ?? [:]
    var entry = services[name] as? [String: Any] ?? [:]
    // Respect a shortcut the user has changed or explicitly cleared in System Settings.
    if entry["key_equivalent"] == nil {
        entry["key_equivalent"] = "^~@r"
        services[name] = entry
        prefs.set(services, forKey: "NSServicesStatus")
    }
    if let key = entry["key_equivalent"] as? String, !key.isEmpty {
        prefs.set(true, forKey: "ServicesShortcutsPresent")
    }
    guard prefs.synchronize() else {
        throw DraftError("Не удалось сохранить сочетание клавиш.")
    }
    NSUpdateDynamicServices()
    DistributedNotificationCenter.default().postNotificationName(
        Notification.Name("com.apple.ServicesMenu.ServicesChanged"), object: nil,
        userInfo: nil, deliverImmediately: true)
}
