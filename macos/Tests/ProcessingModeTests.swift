import Foundation

@main
struct ProcessingModeTests {
    static func main() throws {
        let implicit = try ProcessingMode.fromCommandLine(["--stdin"])
        let explicit = try ProcessingMode.fromCommandLine(["--stdin", "--mode", "rewrite"])
        let prompt = try ProcessingMode.fromCommandLine(["--stdin", "--mode", "prompt"])
        precondition(implicit == .rewrite && explicit == .rewrite)
        precondition(prompt == .prompt)
        precondition(implicit.resourceName == "editor" && prompt.resourceName == "prompt")

        for invalid in [
            [], ["--mode", "prompt"], ["--stdin", "--mode"],
            ["--stdin", "--mode", ""], ["--stdin", "--mode", "other"],
            ["--stdin", "--mode", "prompt", "--mode", "rewrite"],
            ["--stdin", "--other", "prompt"], ["--unknown"]
        ] {
            do {
                _ = try ProcessingMode.fromCommandLine(invalid)
                fatalError("Accepted invalid CLI arguments: \(invalid)")
            } catch is DraftError {}
        }
        do {
            _ = try ProcessingMode(argument: "unknown-service-mode")
            fatalError("Accepted an unknown service mode")
        } catch is DraftError {}
        print("Processing mode tests passed")
    }
}
