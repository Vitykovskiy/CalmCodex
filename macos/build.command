#!/bin/zsh
set -eu
root=$(cd "$(dirname "$0")" && pwd -P)
bundle="$root/build/CalmCodex.service"
if (( $# )); then bundle=$1; fi
mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources"
cp "$root/Info.plist" "$bundle/Contents/Info.plist"
cp "$root/Resources/"* "$bundle/Contents/Resources/"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
for arch in arm64 x86_64; do
  xcrun swiftc -O -swift-version 5 -target "$arch-apple-macos13.0" -framework AppKit \
    "$root/Sources/"*.swift -o "$scratch/CalmCodex-$arch"
done
lipo -create "$scratch/CalmCodex-arm64" "$scratch/CalmCodex-x86_64" -output "$bundle/Contents/MacOS/CalmCodex"
codesign --force --sign - --identifier local.calmcodex.service "$bundle"
codesign --verify --strict "$bundle"
