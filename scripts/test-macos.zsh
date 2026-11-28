#!/bin/zsh
set -eu
root=${0:A:h:h}
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
xcrun swiftc -swift-version 5 "$root/macos/Sources/Draft.swift" \
  "$root/macos/Tests/DraftTests.swift" -o "$scratch/draft-tests"
"$scratch/draft-tests"
xcrun swiftc -swift-version 5 "$root/macos/Sources/Draft.swift" \
  "$root/macos/Sources/ProcessingMode.swift" "$root/macos/Sources/RewriteRequest.swift" \
  "$root/macos/Tests/ProcessingModeTests.swift" \
  -o "$scratch/mode-tests"
"$scratch/mode-tests"
xcrun swiftc -swift-version 5 "$root/macos/Sources/Draft.swift" \
  "$root/macos/Sources/ProcessingMode.swift" "$root/macos/Sources/RewriteRequest.swift" \
  "$root/macos/Tests/RewriteRequestTests.swift" -o "$scratch/request-tests"
"$scratch/request-tests"
