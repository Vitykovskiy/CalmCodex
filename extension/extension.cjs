'use strict';

const vscode = require('vscode');
const { spawn } = require('node:child_process');
const { install } = require('./install-adapter.cjs');

function rewrite(binary, text) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['--stdin'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const output = [];
    const diagnostic = [];
    child.stdout.on('data', chunk => output.push(chunk));
    child.stderr.on('data', chunk => diagnostic.push(chunk));
    child.stdin.on('error', () => {}); // close/error reports the process outcome
    child.on('error', reject);
    child.on('close', code => {
      const result = Buffer.concat(output).toString('utf8');
      if (code === 0 && result.trim()) resolve(result);
      else reject(new Error(Buffer.concat(diagnostic).toString('utf8').trim() || 'Luna не вернула текст.'));
    });
    child.stdin.end(text, 'utf8');
  });
}

function activate(context) {
  const views = new Map();
  const engine = context.asAbsolutePath('engine/CalmCodex.service/Contents/MacOS/CalmCodex');

  context.subscriptions.push(vscode.commands.registerCommand('calmCodex.preview', async item => {
    const view = views.get(item?.calmCodexView)?.deref();
    if (view) await view.postMessage({ type: 'calmcodex/preview', key: item.calmCodexField });
  }));
  // The adapter lives at the composer boundary, so native send, queue and dictation use it alike.
  const codex = vscode.extensions.getExtension('openai.chatgpt');
  if (codex && process.platform === 'darwin') {
    try {
      const changed = install(codex.extensionPath, __dirname);
      if (changed && codex.isActive) {
        vscode.window.showInformationMessage('CalmCodex установлен. Перезагрузите окно VS Code, чтобы подключить открытый чат.', 'Перезагрузить окно')
          .then(choice => { if (choice) vscode.commands.executeCommand('workbench.action.reloadWindow'); });
      }
    } catch (err) {
      vscode.window.showErrorMessage('CalmCodex не смог подключиться к полю Codex. ' + err.message);
    }
  }
  return {
    async receive(view, msg) {
      if (msg.kind === 'register') {
        if (typeof msg.key !== 'string' || msg.key.length > 100) return;
        for (const [key, ref] of views) if (!ref.deref() || ref.deref() === view) views.delete(key);
        views.set(msg.key, new WeakRef(view));
        return;
      }
      if (msg.kind !== 'rewrite' || typeof msg.id !== 'string' || typeof msg.text !== 'string') return;
      const reply = { type: 'calmcodex/result', id: msg.id };
      try {
        if (msg.auto && !vscode.workspace.getConfiguration('calmCodex').get('rewriteOnSend', true)) reply.bypass = true;
        else reply.text = await rewrite(engine, msg.text);
      } catch (err) { reply.error = err.message; }
      await view.postMessage(reply);
    }
  };
}

module.exports = { activate };
