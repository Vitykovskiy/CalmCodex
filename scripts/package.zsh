#!/bin/zsh
set -eu
root=${0:A:h:h}
out="$root/dist"
mkdir -p "$out"
stage=$(mktemp -d "$out/.package.XXXXXXXX")
trap 'rm -rf "$stage"' EXIT
bundle="$stage/CalmCodex"
extension="$stage/extension"
mkdir -p "$bundle/Source/VSCode" "$extension/engine"

"$root/macos/build.command" "$bundle/CalmCodex.service"
ditto "$bundle/CalmCodex.service" "$extension/engine/CalmCodex.service"
cp "$root/extension/"*.{cjs,mjs,json,md} "$extension/"
(
  cd "$extension"
  "$root/node_modules/.bin/vsce" package --no-dependencies --allow-missing-repository \
    --skip-license --out "$bundle/CalmCodex.vsix"
)

cp -p "$root/installer/"*.command "$bundle/"
cp "$root/docs/installation.md" "$bundle/README.md"
cp -p "$root/macos/"{Info.plist,build.command} "$bundle/Source/"
cp -R "$root/macos/"{Resources,Sources,Tests} "$bundle/Source/"
cp "$extension/"*.{cjs,mjs,json} "$bundle/Source/VSCode/"
ditto -c -k --norsrc --keepParent "$bundle" "$stage/CalmCodex-macOS.zip"
unzip -tq "$stage/CalmCodex-macOS.zip"
mv -f "$bundle/CalmCodex.vsix" "$out/"
mv -f "$stage/CalmCodex-macOS.zip" "$out/"
print "Готово: $out/CalmCodex-macOS.zip и $out/CalmCodex.vsix"
