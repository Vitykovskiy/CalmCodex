'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const extensionPath = path.resolve(__dirname, '../extension');
const source = readFileSync(path.join(extensionPath, 'extension.cjs'), 'utf8');

function harness(settings = {}, outcome = { text: 'Готовый текст.' }) {
  const commands = new Map();
  const calls = [];
  const messages = [];
  const view = { async postMessage(message) { messages.push(message); } };
  const vscode = {
    commands: { registerCommand(name, handler) { commands.set(name, handler); return { dispose() {} }; } },
    extensions: { getExtension() {} },
    workspace: { getConfiguration() { return { get(key, fallback) { return settings[key] ?? fallback; } }; } }
  };
  function spawn(binary, args) {
    const call = { binary, args: Array.from(args) };
    calls.push(call);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = text => {
      call.input = text;
      queueMicrotask(() => {
        if (outcome.error) child.emit('error', new Error(outcome.error));
        else {
          if (outcome.text) child.stdout.emit('data', Buffer.from(outcome.text));
          if (outcome.diagnostic) child.stderr.emit('data', Buffer.from(outcome.diagnostic));
          child.emit('close', outcome.code ?? 0);
        }
      });
    };
    return child;
  }
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, __dirname: extensionPath, Buffer, WeakRef, process: { platform: 'linux' },
    require(name) {
      if (name === 'vscode') return vscode;
      if (name === 'node:child_process') return { spawn };
      if (name === './install-adapter.cjs') return { install() { assert.fail('Unexpected adapter installation'); } };
      throw new Error('Unexpected dependency: ' + name);
    }
  }, { filename: 'extension.cjs' });
  const api = module.exports.activate({
    subscriptions: [],
    asAbsolutePath(relative) { return path.join(extensionPath, relative); }
  });
  async function receive(options = {}) {
    await api.receive(view, { kind: 'rewrite', id: 'request', text: 'Исходный черновик.', auto: true, ...options });
    return messages.at(-1);
  }
  return { api, calls, commands, messages, receive, view };
}

test('automatic processing defaults to the existing rewrite mode', async () => {
  const h = harness();
  const reply = await h.receive();
  assert.deepEqual(h.calls[0].args, ['--stdin']);
  assert.equal(h.calls[0].input, 'Исходный черновик.');
  assert.equal(reply.text, 'Готовый текст.');
});

test('automatic processing selects its configured mode instead of a message override', async () => {
  const h = harness({ mode: 'prompt' });
  const reply = await h.receive({ mode: 'rewrite' });
  assert.deepEqual(h.calls[0].args, ['--stdin', '--mode', 'prompt']);
  assert.equal(reply.text, 'Готовый текст.');
});

test('manual commands select either mode even with automatic processing disabled', async () => {
  for (const mode of ['rewrite', 'prompt']) {
    const h = harness({ mode: mode === 'prompt' ? 'rewrite' : 'prompt', rewriteOnSend: false });
    const reply = await h.receive({ auto: false, mode });
    assert.deepEqual(h.calls[0].args, mode === 'prompt' ? ['--stdin', '--mode', 'prompt'] : ['--stdin']);
    assert.equal(reply.text, 'Готовый текст.');
    assert.equal(reply.bypass, undefined);
  }
});

test('a legacy preview without a mode still rewrites, regardless of automatic mode', async () => {
  const h = harness({ mode: 'prompt' });
  await h.receive({ auto: false });
  assert.deepEqual(h.calls[0].args, ['--stdin']);
});

test('disabled automatic processing bypasses the engine', async () => {
  const h = harness({ rewriteOnSend: false, mode: 'prompt' });
  const reply = await h.receive();
  assert.equal(reply.bypass, true);
  assert.equal(reply.text, undefined);
  assert.equal(h.calls.length, 0);
});

test('unknown manual and configured modes fail without starting the engine', async () => {
  for (const options of [
    { settings: {}, message: { auto: false, mode: 'unknown' } },
    { settings: { mode: 'unknown' }, message: {} }
  ]) {
    const h = harness(options.settings);
    const reply = await h.receive(options.message);
    assert.match(reply.error, /режим обработки/);
    assert.equal(reply.text, undefined);
    assert.equal(h.calls.length, 0);
  }
});

test('context commands address the registered field with their explicit mode', async () => {
  const h = harness();
  await h.api.receive(h.view, { kind: 'register', key: 'view-key' });
  for (const [command, mode] of [['calmCodex.preview', 'rewrite'], ['calmCodex.optimize', 'prompt']]) {
    await h.commands.get(command)({ calmCodexView: 'view-key', calmCodexField: 'field-key' });
    const message = h.messages.at(-1);
    assert.equal(message.type, 'calmcodex/preview');
    assert.equal(message.key, 'field-key');
    assert.equal(message.mode, mode);
  }
  assert.equal(h.calls.length, 0);
});

test('engine failures return an error without replacement text in prompt mode', async () => {
  for (const outcome of [
    { code: 1, diagnostic: 'Модель недоступна.' },
    { error: 'Движок не найден.' }
  ]) {
    const h = harness({ mode: 'prompt' }, outcome);
    const reply = await h.receive();
    assert.equal(reply.error, outcome.diagnostic || outcome.error);
    assert.equal(reply.text, undefined);
  }
});
