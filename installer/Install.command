#!/bin/zsh
set -eu
root=$(cd "$(dirname "$0")" && pwd -P)
source_bundle="$root/CalmCodex.service"
services="$HOME/Library/Services"
target="$services/CalmCodex.service"
mkdir -p "$services"
/usr/bin/codesign --verify --strict "$source_bundle"
stage=$(mktemp -d "$services/.CalmCodex.XXXXXX")
trap 'rmdir "$stage" 2>/dev/null || true' EXIT
if [[ -e "$target" || -L "$target" ]]; then
  id=$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$target/Contents/Info.plist" 2>/dev/null || true)
  if [[ -L "$target" || "$id" != local.calmcodex.service ]]; then
    print -u2 "По пути $target находится другой файл. Переместите его перед установкой."
    exit 1
  fi
fi
if ! /usr/bin/diff -qr "$source_bundle" "$target" >/dev/null 2>&1; then
  /usr/bin/ditto "$source_bundle" "$stage/new.service"
  /usr/bin/codesign --verify --strict "$stage/new.service"
  if [[ -d "$target" ]]; then mv "$target" "$stage/previous.service"; fi
  if ! mv "$stage/new.service" "$target"; then
    if [[ -d "$stage/previous.service" ]]; then mv "$stage/previous.service" "$target"; fi
    exit 1
  fi
  if [[ -d "$stage/previous.service" ]]; then rm -rf "$stage/previous.service"; fi
fi
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$target"
"$target/Contents/MacOS/CalmCodex" --register-shortcut
"$root/Install-VSCode.command"
