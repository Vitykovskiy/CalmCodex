'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const extensionPath = path.resolve(__dirname, '../extension');
const source = readFileSync(path.join(extensionPath, 'extension.cjs'), 'utf8');

function engineInput(call) {
  return call.args.includes('--stdin-json') ? JSON.parse(call.input) : { draft: call.input };
}

function harness(settings = {}, outcome = { text: 'Готовый текст.' }) {
  const commands = new Map();
  const calls = [];
  const killedGroups = [];
  const timers = [];
  const messages = [];
  const view = { async postMessage(message) { messages.push(message); } };
  const vscode = {
    commands: { registerCommand(name, handler) { commands.set(name, handler); return { dispose() {} }; } },
    extensions: { getExtension() {} },
    workspace: { getConfiguration() { return { get(key, fallback) { return settings[key] ?? fallback; } }; } }
  };
  function spawn(binary, args, options) {
    const call = { binary, args: Array.from(args), options, pid: 100 + calls.length, active: true };
    calls.push(call);
    const child = new EventEmitter();
    child.pid = call.pid;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    const abort = () => {
      if (!call.active) return;
      call.active = false;
      call.aborted = true;
      child.emit('error', new Error('The operation was aborted'));
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    call.finish = result => {
      queueMicrotask(() => {
        if (!call.active) return;
        call.active = false;
        options.signal?.removeEventListener('abort', abort);
        if (result.error) child.emit('error', new Error(result.error));
        else {
          if (result.text) child.stdout.emit('data', Buffer.from(result.text));
          if (result.diagnostic) child.stderr.emit('data', Buffer.from(result.diagnostic));
          child.emit('close', result.code ?? 0);
        }
      });
    };
    child.stdin.end = text => {
      call.input = text;
      const result = typeof outcome === 'function' ? outcome(call) : outcome;
      if (result) call.finish(result);
    };
    return child;
  }
  const module = { exports: {} };
  const scope = {
    module, __dirname: extensionPath, Buffer, WeakRef, AbortController,
    process: { platform: 'linux', kill(pid, signal) { killedGroups.push({ pid, signal }); } },
    setTimeout(callback, delay) { const timer = { callback, delay, active: true }; timers.push(timer); return timer; },
    clearTimeout(timer) { timer.active = false; },
    require(name) {
      if (name === 'vscode') return vscode;
      if (name === 'node:child_process') return { spawn };
      if (name === './install-adapter.cjs') return { install() { assert.fail('Unexpected adapter installation'); } };
      throw new Error('Unexpected dependency: ' + name);
    }
  };
  vm.runInNewContext(source, scope, { filename: 'extension.cjs' });
  const api = module.exports.activate({
    subscriptions: [],
    asAbsolutePath(relative) { return path.join(extensionPath, relative); }
  });
  async function receive(options = {}) {
    await api.receive(view, { kind: 'rewrite', id: 'request', text: 'Исходный черновик.', auto: true, ...options });
    return messages.at(-1);
  }
  return { api, calls, commands, messages, receive, view, killedGroups, timers, rewrite: scope.rewrite };
}

test('automatic processing defaults to the existing rewrite mode', async () => {
  const h = harness();
  const reply = await h.receive();
  assert.deepEqual(h.calls[0].args, ['--stdin', '--ultracave']);
  assert.equal(h.calls[0].input, 'Исходный черновик.');
  assert.equal(reply.text, 'Готовый текст.');
});

test('automatic processing selects its configured mode instead of a message override', async () => {
  const h = harness({ mode: 'prompt' });
  const reply = await h.receive({ mode: 'rewrite' });
  assert.deepEqual(h.calls[0].args, ['--stdin', '--mode', 'prompt', '--ultracave']);
  assert.equal(reply.text, 'Готовый текст.');
});

test('model and reasoning settings reach both manual and automatic calls', async () => {
  for (const mode of ['rewrite', 'prompt']) {
    for (const auto of [true, false]) {
      const h = harness({ mode, model: ' gpt-6.2-sol ', reasoningEffort: 'medium' });
      const reply = await h.receive({ auto, mode });
      assert.deepEqual(h.calls[0].args, [
        '--stdin', ...(mode === 'prompt' ? ['--mode', 'prompt'] : []),
        '--model', 'gpt-6.2-sol', '--reasoning-effort', 'medium', '--ultracave'
      ]);
      assert.equal(h.calls[0].input, 'Исходный черновик.');
      assert.equal(reply.error, undefined);
    }
  }
});

test('Ultracave can be disabled in either mode without a second model call', async () => {
  for (const mode of ['rewrite', 'prompt']) {
    for (const ultracave of [true, false]) {
      const h = harness({ mode, ultracave });
      await h.receive();
      assert.equal(h.calls.length, 1);
      assert.equal(h.calls[0].args.at(-1), ultracave ? '--ultracave' : '--no-ultracave');
    }
  }
  const invalid = harness({ ultracave: 'false' });
  assert.match((await invalid.receive()).error, /calmCodex\.ultracave/);
  assert.equal(invalid.calls.length, 0);
});

test('invalid model settings fail before starting the engine', async () => {
  for (const settings of [
    { model: 42 }, { model: 'gpt model' }, { model: '--help' },
    { reasoningEffort: 'turbo' }, { reasoningEffort: 2 }
  ]) {
    const h = harness(settings);
    assert.match((await h.receive()).error, /calmCodex\.(?:model|reasoningEffort)/);
    assert.equal(h.calls.length, 0);
  }
});

test('manual commands select either mode even with automatic processing disabled', async () => {
  for (const mode of ['rewrite', 'prompt']) {
    const h = harness({ mode: mode === 'prompt' ? 'rewrite' : 'prompt', rewriteOnSend: false });
    const reply = await h.receive({ auto: false, mode });
    assert.deepEqual(h.calls[0].args, mode === 'prompt'
      ? ['--stdin', '--mode', 'prompt', '--ultracave'] : ['--stdin', '--ultracave']);
    assert.equal(reply.text, 'Готовый текст.');
    assert.equal(reply.bypass, undefined);
  }
});

test('a legacy preview without a mode still rewrites, regardless of automatic mode', async () => {
  const h = harness({ mode: 'prompt' });
  await h.receive({ auto: false });
  assert.deepEqual(h.calls[0].args, ['--stdin', '--ultracave']);
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

test('prompt regions receive their original neighbours as context and retain result order', async () => {
  const parts = ['Импорт падает. Вот пример:', 'Поправь чтение. CSV не меняй.'];
  const h = harness({ mode: 'prompt' }, call => ({ text: engineInput(call).draft.replace('Поправь', 'Исправь') }));
  const reply = await h.receive({ text: parts.join('\n`CC-boundary`\n'), parts });
  assert.equal(reply.mode, 'prompt');
  assert.equal(reply.text, undefined);
  assert.deepEqual(Array.from(reply.parts), [parts[0], 'Исправь чтение. CSV не меняй.']);
  for (const [index, call] of h.calls.entries()) {
    assert.deepEqual(engineInput(call), {
      draft: parts[index], context: { before: parts.slice(0, index), after: parts.slice(index + 1) }
    });
    assert.deepEqual(call.args, ['--stdin-json', '--mode', 'prompt', '--allow-empty', '--ultracave']);
    assert.equal(call.options.detached, true);
    assert.ok(call.options.signal);
    assert.doesNotMatch(call.input, /CC-boundary/);
  }
});

test('the rhetorical mockup complaint keeps earlier context and later constraints in its own call', async () => {
  const parts = [
    'Снова нет макетов. Добавь к элементу и его описанию фрагмент макета.',
    'Я фантазировать что-ли должен, как это всё выглядит?',
    'Код не меняй. Почему изображение исчезло после экспорта?'
  ];
  const expected = [parts[0], 'Покажи, как это выглядит.', parts[2]];
  const h = harness({ mode: 'prompt', model: 'gpt-6-luna', reasoningEffort: 'medium' }, call => {
    const input = engineInput(call);
    assert.deepEqual(input.context.before.concat(input.draft, input.context.after), parts);
    return { text: expected[parts.indexOf(input.draft)] };
  });
  const reply = await h.receive({ text: parts.join('\n'), parts });
  assert.deepEqual(Array.from(reply.parts), expected);
  assert.equal(h.calls.length, 3);
  for (const call of h.calls) {
    assert.deepEqual(call.args, ['--stdin-json', '--mode', 'prompt', '--allow-empty',
      '--model', 'gpt-6-luna', '--reasoning-effort', 'medium', '--ultracave']);
  }
});

test('rewrite mode retains a single call for a structured editor document', async () => {
  const h = harness({ mode: 'rewrite' });
  const source = 'До\n`CC-boundary`\nПосле';
  const reply = await h.receive({ text: source, parts: ['До', 'После'] });
  assert.equal(reply.mode, 'rewrite');
  assert.equal(reply.parts, undefined);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].input, source);
  assert.equal(h.calls[0].options.signal, undefined);
  assert.equal(h.calls[0].options.detached, undefined);
});

test('a successful empty prompt region is allowed only when another region has content', async () => {
  const parts = ['Блядь!', 'Поправь чтение.'];
  const mixed = harness({ mode: 'prompt' }, call => ({
    text: engineInput(call).draft === parts[0] ? '' : 'Исправь чтение.'
  }));
  const reply = await mixed.receive({ parts });
  assert.deepEqual(Array.from(reply.parts), ['', 'Исправь чтение.']);
  for (const call of mixed.calls) {
    assert.deepEqual(call.args, ['--stdin-json', '--mode', 'prompt', '--allow-empty', '--ultracave']);
  }
  const empty = harness({ mode: 'prompt' }, { text: '' });
  assert.match((await empty.receive({ parts })).error, /Уточните/);
  assert.match((await empty.receive()).error, /не вернула текст/);
});

test('prompt batches run at most three processes and map out-of-order completions', async () => {
  const h = harness({ mode: 'prompt' }, null);
  const parts = ['one', 'two', 'three', 'four', 'five'];
  const pending = h.receive({ parts });
  assert.equal(h.calls.length, 3);
  h.calls[1].finish({ text: 'TWO' });
  await new Promise(setImmediate);
  assert.equal(h.calls.length, 4);
  assert.equal(h.calls.filter(call => call.active).length, 3);
  h.calls[3].finish({ text: 'FOUR' });
  await new Promise(setImmediate);
  assert.equal(h.calls.length, 5);
  assert.equal(h.calls.filter(call => call.active).length, 3);
  for (const call of h.calls.filter(call => call.active)) call.finish({ text: engineInput(call).draft.toUpperCase() });
  const reply = await pending;
  assert.deepEqual(Array.from(reply.parts), parts.map(part => part.toUpperCase()));
  assert.ok(h.timers.every(timer => !timer.active));
});

test('one failed region cancels active process groups and stops the remaining queue', async () => {
  const h = harness({ mode: 'prompt' }, null);
  const pending = h.receive({ parts: ['one', 'two', 'three', 'four', 'five'] });
  h.calls[0].finish({ code: 1, diagnostic: 'Ошибка первой части.' });
  const reply = await pending;
  assert.equal(reply.error, 'Ошибка первой части.');
  assert.equal(reply.parts, undefined);
  assert.equal(h.calls.length, 3);
  assert.ok(h.calls[1].aborted && h.calls[2].aborted);
  assert.deepEqual(h.killedGroups.map(call => call.pid), [-101, -102]);
  assert.ok(h.killedGroups.every(call => call.signal === 'SIGTERM'));
  assert.ok(h.timers.every(timer => !timer.active));
});

test('the shared batch deadline cancels all active groups before the composer timeout', async () => {
  const h = harness({ mode: 'prompt' }, null);
  const pending = h.receive({ parts: ['one', 'two', 'three', 'four'] });
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].delay, 70000);
  h.timers[0].callback();
  const reply = await pending;
  assert.match(reply.error, /не успела/);
  assert.equal(reply.parts, undefined);
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.killedGroups.map(call => call.pid), [-100, -101, -102]);
});

test('an aborted signal never starts a process and a late abort never kills a completed group', async () => {
  const h = harness({}, { text: 'Готово.' });
  const early = new AbortController();
  early.abort(new Error('Остановлено до запуска.'));
  await assert.rejects(h.rewrite('/engine', 'Текст', 'prompt', { signal: early.signal }), /до запуска/);
  assert.equal(h.calls.length, 0);
  const late = new AbortController();
  assert.equal(await h.rewrite('/engine', 'Текст', 'prompt', { signal: late.signal }), 'Готово.');
  late.abort(new Error('Поздняя отмена.'));
  assert.equal(h.killedGroups.length, 0);
});

test('one complete prompt block is processed as a whole', async () => {
  const draft = 'Я думаю взять вариант Б.\n\nРеестр шаблонов, наверное, в администрировании?\n\nСделай такой черновик.';
  const h = harness({ mode: 'prompt', ultracave: false }, { text: 'Сделай черновик на основе варианта Б.\n\nОцени реестр шаблонов в администрировании.' });
  const reply = await h.receive({ text: 'legacy encoded text', parts: [draft] });
  assert.equal(h.calls.length, 1);
  assert.deepEqual(engineInput(h.calls[0]), { draft, context: { before: [], after: [] } });
  assert.deepEqual(h.calls[0].args, ['--stdin-json', '--mode', 'prompt', '--allow-empty', '--no-ultracave']);
  assert.equal(reply.parts.length, 1);
  assert.equal(reply.text, undefined);
});

test('malformed editor parts are rejected before starting the engine', async () => {
  for (const parts of [[], ['one', ''], ['one', 2], 'one']) {
    const h = harness({ mode: 'prompt' });
    const reply = await h.receive({ parts });
    assert.match(reply.error, /фрагменты/);
    assert.equal(h.calls.length, 0);
  }
});
