import Foundation

@main
struct ProcessingModeTests {
    static func main() throws {
        let implicit = try ProcessingMode.fromCommandLine(["--stdin"])
        let explicit = try ProcessingMode.fromCommandLine(["--stdin", "--mode", "rewrite"])
        let prompt = try ProcessingMode.fromCommandLine(["--stdin", "--mode", "prompt"])
        let region = try ProcessingMode.fromCommandLine(["--stdin", "--mode", "prompt", "--allow-empty"])
        precondition(implicit.mode == .rewrite && explicit.mode == .rewrite)
        precondition(prompt.mode == .prompt && region.mode == .prompt)
        precondition(!implicit.allowEmpty && !explicit.allowEmpty && !prompt.allowEmpty && region.allowEmpty)
        precondition(implicit.mode.resourceName == "editor" && prompt.mode.resourceName == "prompt")

        for invalid in [
            [], ["--mode", "prompt"], ["--stdin", "--mode"],
            ["--stdin", "--mode", ""], ["--stdin", "--mode", "other"],
            ["--stdin", "--mode", "prompt", "--mode", "rewrite"],
            ["--stdin", "--mode", "rewrite", "--allow-empty"], ["--stdin", "--allow-empty"],
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
