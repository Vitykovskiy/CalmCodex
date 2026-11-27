#!/bin/zsh
set -eu
cli='/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'
if [[ ! -x "$cli" ]]; then cli=$(command -v code); fi
codex_root=$("$cli" --locate-extension openai.chatgpt)
addon=$("$cli" --locate-extension local-calmcodex.calmcodex)
if [[ -f "$addon/install-adapter.cjs" && -f "$codex_root/package.json" ]]; then
  runtime='/Applications/Visual Studio Code.app/Contents/MacOS/Code'
  if [[ -x "$runtime" ]]; then
    ELECTRON_RUN_AS_NODE=1 "$runtime" "$addon/install-adapter.cjs" remove "$codex_root"
  else
    node "$addon/install-adapter.cjs" remove "$codex_root"
  fi
fi
if [[ -n "$addon" ]]; then "$cli" --uninstall-extension local-calmcodex.calmcodex; fi
print 'CalmCodex удалён из VS Code. Перезагрузите открытое окно командой Developer: Reload Window.'
