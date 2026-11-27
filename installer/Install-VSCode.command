#!/bin/zsh
set -eu
root=$(cd "$(dirname "$0")" && pwd -P)
cli='/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'
if [[ ! -x "$cli" ]]; then cli=$(command -v code); fi
codex_root=$("$cli" --locate-extension openai.chatgpt)
if [[ ! -f "$codex_root/package.json" ]]; then
  print -u2 'Сначала установите Codex в VS Code.'
  exit 1
fi
"$cli" --install-extension "$root/CalmCodex.vsix" --force
addon=$("$cli" --locate-extension local-calmcodex.calmcodex)
runtime='/Applications/Visual Studio Code.app/Contents/MacOS/Code'
if [[ -x "$runtime" ]]; then
  ELECTRON_RUN_AS_NODE=1 "$runtime" "$addon/install-adapter.cjs" install "$codex_root"
else
  node "$addon/install-adapter.cjs" install "$codex_root"
fi
print 'CalmCodex установлен. Если чат Codex уже был открыт, один раз перезагрузите окно командой Developer: Reload Window.'
