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
        precondition(implicit.inputFormat == .text && implicit.model == nil && implicit.reasoningEffort == nil)
        precondition(implicit.ultracave == nil && prompt.ultracave == nil)

        let contextual = try ProcessingMode.fromCommandLine([
            "--stdin-json", "--mode", "prompt", "--allow-empty", "--model", "gpt-6.2-sol",
            "--reasoning-effort", "medium"
        ])
        precondition(contextual.inputFormat == .json && contextual.mode == .prompt && contextual.allowEmpty)
        precondition(contextual.model == "gpt-6.2-sol" && contextual.reasoningEffort == .medium)
        for effort in ReasoningEffort.allCases {
            let command = try ProcessingMode.fromCommandLine([
                "--stdin", "--reasoning-effort", effort.rawValue, "--model", "gpt-6-luna", "--mode", "rewrite"
            ])
            precondition(command.mode == .rewrite && command.model == "gpt-6-luna")
            precondition(command.reasoningEffort == effort)
        }
        for format in ["--stdin", "--stdin-json"] {
            for mode in ["rewrite", "prompt"] {
                for (flag, enabled) in [("--ultracave", true), ("--no-ultracave", false)] {
                    let command = try ProcessingMode.fromCommandLine([format, "--mode", mode, flag])
                    precondition(command.ultracave == enabled && command.mode.rawValue == mode)
                    precondition(command.inputFormat.rawValue == format)
                }
            }
        }

        for invalid in [
            [], ["--mode", "prompt"], ["--stdin", "--mode"],
            ["--stdin", "--mode", ""], ["--stdin", "--mode", "other"],
            ["--stdin", "--mode", "prompt", "--mode", "rewrite"],
            ["--stdin", "--mode", "rewrite", "--allow-empty"], ["--stdin", "--allow-empty"],
            ["--stdin", "--other", "prompt"], ["--unknown"],
            ["--stdin", "--stdin-json"], ["--stdin-json", "--stdin"],
            ["--stdin-json", "--allow-empty"],
            ["--stdin", "--model"], ["--stdin", "--model", ""],
            ["--stdin", "--model", "gpt 6"], ["--stdin", "--model", "--other"],
            ["--stdin", "--model", "gpt-6-luna", "--model", "gpt-6.2-sol"],
            ["--stdin", "--reasoning-effort"], ["--stdin", "--reasoning-effort", "none"],
            ["--stdin", "--reasoning-effort", "high", "--reasoning-effort", "low"],
            ["--stdin", "--mode", "prompt", "--allow-empty", "--allow-empty"],
            ["--stdin", "--ultracave", "--no-ultracave"],
            ["--stdin-json", "--no-ultracave", "--ultracave"],
            ["--stdin", "--ultracave", "--ultracave"],
            ["--stdin", "--no-ultracave", "--no-ultracave"],
            ["--stdin", "--ultracave", "false"]
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
