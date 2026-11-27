'use strict';

const vscode = require('vscode');
const { spawn } = require('node:child_process');
const { install } = require('./install-adapter.cjs');

function rewrite(binary, text, mode, { signal, allowEmpty = false, context, model, reasoningEffort, ultracave } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const args = [context ? '--stdin-json' : '--stdin'];
    if (mode === 'prompt') args.push('--mode', 'prompt');
    if (allowEmpty) args.push('--allow-empty');
    if (model) args.push('--model', model);
    if (reasoningEffort) args.push('--reasoning-effort', reasoningEffort);
    if (ultracave !== undefined) args.push(ultracave ? '--ultracave' : '--no-ultracave');
    let child;
    // The native engine starts Codex too. Cancel its own process group, not only the wrapper.
    const cancelGroup = () => {
      if (!child?.pid) return;
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    };
    signal?.addEventListener('abort', cancelGroup, { once: true });
    const cleanup = () => signal?.removeEventListener('abort', cancelGroup);
    try {
      child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'],
        ...(signal ? { signal, detached: true } : {}) });
    } catch (error) { cleanup(); reject(error); return; }
    const output = [];
    const diagnostic = [];
    child.stdout.on('data', chunk => output.push(chunk));
    child.stderr.on('data', chunk => diagnostic.push(chunk));
    child.stdin.on('error', () => {}); // close/error reports the process outcome
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', code => {
      cleanup();
      const result = Buffer.concat(output).toString('utf8');
      if (code === 0 && (allowEmpty || result.trim())) resolve(result);
      else reject(new Error(Buffer.concat(diagnostic).toString('utf8').trim() || 'Модель не вернула текст.'));
    });
    child.stdin.end(context ? JSON.stringify({ draft: text, context }) : text, 'utf8');
  });
}

async function rewriteParts(binary, parts, mode, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error('Модель не успела обработать черновик. Текст сохранён.'));
  }, 70000);
  const result = new Array(parts.length);
  let next = 0;
  async function worker() {
    while (!controller.signal.aborted) {
      const index = next++;
      if (index >= parts.length) return;
      try {
        result[index] = await rewrite(binary, parts[index], mode, {
          ...options, signal: controller.signal, allowEmpty: true,
          context: { before: parts.slice(0, index), after: parts.slice(index + 1) }
        });
      }
      catch (error) {
        if (!controller.signal.aborted) controller.abort(error);
        return;
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(3, parts.length) }, worker));
    if (controller.signal.aborted) throw controller.signal.reason;
    if (!result.some(part => part.trim())) {
      throw new Error('Уточните, что случилось или что нужно сделать. Черновик сохранён.');
    }
    return result;
  } finally { clearTimeout(timer); }
}

function processingOptions(config) {
  const rawModel = config.get('model', '');
  const reasoningEffort = config.get('reasoningEffort', '');
  const ultracave = config.get('ultracave', true);
  if (typeof rawModel !== 'string' || (rawModel.trim() && !/^[a-z0-9][a-z0-9._:\/-]*$/i.test(rawModel.trim()))) {
    throw new Error('Укажите идентификатор модели в настройке calmCodex.model.');
  }
  if (!['', 'low', 'medium', 'high', 'xhigh', 'max'].includes(reasoningEffort)) {
    throw new Error('Выберите уровень рассуждений в настройке calmCodex.reasoningEffort.');
  }
  if (typeof ultracave !== 'boolean') {
    throw new Error('Включите или отключите сжатие в настройке calmCodex.ultracave.');
  }
  return { model: rawModel.trim(), reasoningEffort, ultracave };
}

function activate(context) {
  const views = new Map();
  const engine = context.asAbsolutePath('engine/CalmCodex.service/Contents/MacOS/CalmCodex');

  for (const [command, mode] of [['calmCodex.preview', 'rewrite'], ['calmCodex.optimize', 'prompt']]) {
    context.subscriptions.push(vscode.commands.registerCommand(command, async item => {
      const view = views.get(item?.calmCodexView)?.deref();
      if (view) await view.postMessage({ type: 'calmcodex/preview', key: item.calmCodexField, mode });
    }));
  }
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
        const config = vscode.workspace.getConfiguration('calmCodex');
        if (msg.auto && !config.get('rewriteOnSend', true)) reply.bypass = true;
        else {
          // Automatic sends use the setting; a context command selects its own mode.
          const mode = msg.auto ? config.get('mode', 'rewrite') : (msg.mode ?? 'rewrite');
          if (mode !== 'rewrite' && mode !== 'prompt') throw new Error('Выберите режим обработки в настройках CalmCodex.');
          if (msg.parts !== undefined && (!Array.isArray(msg.parts) || msg.parts.length < 1 ||
              !msg.parts.every(part => typeof part === 'string' && part.trim()))) {
            throw new Error('Не удалось прочитать фрагменты черновика. Текст сохранён.');
          }
          reply.mode = mode;
          const options = processingOptions(config);
          // Neighbours explain intent; only the target fragment may be replaced.
          if (mode === 'prompt' && msg.parts) reply.parts = await rewriteParts(engine, msg.parts, mode, options);
          else reply.text = await rewrite(engine, msg.text, mode, options);
        }
      } catch (err) { reply.error = err.message; }
      await view.postMessage(reply);
    }
  };
}

module.exports = { activate };
