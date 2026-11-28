import assert from 'node:assert/strict';
import { spawn as nativeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import vm from 'node:vm';
import { schema } from 'prosemirror-schema-basic';
import { EditorState } from 'prosemirror-state';

// The editor and extension host are production code. Only the VS Code surface and,
// in ordinary tests, the native process are substituted. The opt-in test uses the real engine.
const win = globalThis.window = new EventTarget();
win.location = { origin: 'test://context-pipeline' };
globalThis.document = {
  addEventListener() {},
  createElement() { return { isConnected: true, style: {}, setAttribute() {} }; }
};
const { bind, connect, prepare } = await import('../extension/composer.mjs');
const root = fileURLToPath(new URL('..', import.meta.url));
const extensionFile = path.join(root, 'extension/extension.cjs');
const extensionSource = readFileSync(extensionFile, 'utf8');
const extensionRequire = createRequire(extensionFile);
const before = 'Добавь макет карточки. Код не меняй. Сохрани текущее API.';
const target = 'Я должен догадаться, как будет выглядеть результат?';
const after = 'Отдельно объясни, почему изображение исчезло после экспорта.';
const parts = [before, target, after];
const desiredTarget = 'Покажи, как будет выглядеть результат.';

function fixture() {
  const images = [1, 2].map(index => schema.nodes.image.create({ src: `file:///fixture/image-${index}.png` }));
  const paragraph = (...children) => schema.node('paragraph', null, children);
  const doc = schema.node('doc', null, [
    paragraph(schema.text(before), images[0]),
    paragraph(schema.text(target), images[1]),
    paragraph(schema.text(after))
  ]);
  const view = {
    dom: { isConnected: true, after() {}, addEventListener() {}, getAttribute() {}, setAttribute() {} },
    state: EditorState.create({ doc }),
    dispatch(transaction) { this.state = this.state.apply(transaction); }
  };
  const controller = {
    view,
    getText(value = view.state.doc) { return value.textBetween(0, value.content.size, '\n'); },
    getPersistedText(value) { return this.getText(value); }
  };
  bind(controller);
  return { controller, original: doc, images };
}

function pipeline({ respond, binary = '/fixture/CalmCodex', settings = {} } = {}) {
  const calls = [], requests = [], replies = [], deliveryErrors = [];
  const configured = { mode: 'prompt', ultracave: true, ...settings };
  function spawn(file, args, options) {
    const call = { file, args: Array.from(args), output: '', diagnostic: '' };
    calls.push(call);
    let child;
    if (!respond) {
      child = nativeSpawn(file, args, options);
      const end = child.stdin.end.bind(child.stdin);
      child.stdin.end = (input, ...rest) => { call.input = input; return end(input, ...rest); };
    } else {
      child = new EventEmitter();
      child.pid = 10000 + calls.length;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = new EventEmitter();
      let active = true;
      const abort = () => {
        if (!active) return;
        active = false;
        child.emit('error', new Error('The operation was aborted'));
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      child.stdin.end = input => {
        call.input = input;
        queueMicrotask(() => {
          if (!active) return;
          active = false;
          options.signal?.removeEventListener('abort', abort);
          try {
            const answer = respond(JSON.parse(input), call);
            child.stdout.emit('data', Buffer.from(answer));
            child.emit('close', 0);
          } catch (error) { child.emit('error', error); }
        });
      };
    }
    child.stdout.on('data', data => { call.output += data.toString('utf8'); });
    child.stderr.on('data', data => { call.diagnostic += data.toString('utf8'); });
    child.on('error', error => { call.error = error.message; });
    return child;
  }
  const vscode = {
    commands: { registerCommand() { return { dispose() {} }; } },
    extensions: { getExtension() {} },
    workspace: { getConfiguration() { return { get(key, fallback) { return configured[key] ?? fallback; } }; } }
  };
  const module = { exports: {} };
  vm.runInNewContext(extensionSource, {
    module, __dirname: path.dirname(extensionFile), Buffer, WeakRef, AbortController, setTimeout, clearTimeout,
    process: { platform: process.platform, kill: respond ? () => {} : process.kill.bind(process) },
    require(name) {
      if (name === 'vscode') return vscode;
      if (name === 'node:child_process') return { spawn };
      if (name === './install-adapter.cjs') return { install() { assert.fail('The test must not install an adapter.'); } };
      return extensionRequire(name);
    }
  }, { filename: extensionFile });
  const api = module.exports.activate({ subscriptions: [], asAbsolutePath() { return binary; } });
  const webview = {
    async postMessage(reply) {
      replies.push(reply);
      const event = new Event('message');
      event.origin = win.location.origin;
      event.data = reply;
      win.dispatchEvent(event);
    }
  };
  connect(message => {
    requests.push(message);
    void api.receive(webview, message).catch(error => { deliveryErrors.push(error); });
  });
  return { ...fixture(), calls, requests, replies, deliveryErrors };
}

function assertImages(p) {
  assert.equal(p.controller.view.state.doc.child(0).lastChild, p.images[0]);
  assert.equal(p.controller.view.state.doc.child(1).lastChild, p.images[1]);
}

test('editor-to-host transport rejects copied neighbouring tasks and preserves the entire draft', async () => {
  const p = pipeline({ respond(input) {
    if (input.draft === target) {
      return 'Добавь макет карточки, чтобы было видно, как будет выглядеть результат. Код не меняй. Сохрани текущее API.';
    }
    return input.draft;
  } });
  assert.equal(await prepare(p.controller, {}, () => true), null);
  assert.equal(p.controller.view.state.doc, p.original);
  assertImages(p);
  assert.equal(p.deliveryErrors.length, 0);
  assert.ok(p.replies.at(-1).error, 'The rejected process output must reach the editor as an error.');
  assert.equal(p.replies.at(-1).parts, undefined);
  assert.deepEqual(p.requests.find(request => request.kind === 'rewrite').parts, parts);
});

test('editor-to-host transport applies scoped results once and retains attachments', async () => {
  const p = pipeline({ respond: input => input.draft === target ? desiredTarget : input.draft });
  const options = {};
  assert.equal(await prepare(p.controller, options, () => true), options);
  assert.equal(p.deliveryErrors.length, 0);
  assert.equal(p.calls.length, 3);
  for (const [index, call] of p.calls.entries()) {
    assert.deepEqual(JSON.parse(call.input), {
      draft: parts[index], context: { before: parts.slice(0, index), after: parts.slice(index + 1) }
    });
    assert.ok(call.args.includes('--ultracave'));
  }
  assertImages(p);
  assert.equal(p.controller.getText(), [before, desiredTarget, after].join('\n'));
  for (const command of ['Добавь макет карточки.', 'Код не меняй.', 'Сохрани текущее API.', after]) {
    assert.equal(p.controller.getText().split(command).length - 1, 1);
  }
});

const live = process.env.CALMCODEX_TEST_LIVE === '1';
const binary = process.env.CALMCODEX_TEST_BINARY || process.env.CALMCODEX_ENGINE
  || path.join(root, 'macos/build/CalmCodex.service/Contents/MacOS/CalmCodex');
const repetitions = Number(process.env.CALMCODEX_LIVE_REPETITIONS || 3);
const model = process.env.CALMCODEX_TEST_MODEL?.trim() || 'gpt-6-luna';
const reasoningEffort = process.env.CALMCODEX_TEST_REASONING_EFFORT?.trim() || 'medium';

test('live editor-to-host-to-engine flow keeps neighbouring tasks in their own blocks', {
  skip: !live, timeout: Number.isFinite(repetitions) ? repetitions * 85000 : 85000
}, async t => {
  assert.ok(existsSync(binary), 'Build the current service or set CALMCODEX_TEST_BINARY / CALMCODEX_ENGINE.');
  assert.ok(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 10,
    'CALMCODEX_LIVE_REPETITIONS must be an integer from 1 to 10.');
  t.diagnostic(`model=${model}; reasoning=${reasoningEffort}; ultracave=true; source=${JSON.stringify(parts)}`);
  for (let attempt = 1; attempt <= repetitions; attempt++) {
    const p = pipeline({ binary, settings: { model, reasoningEffort, ultracave: true } });
    const started = performance.now();
    const result = await prepare(p.controller, {}, () => true);
    t.diagnostic(`${attempt}/${repetitions}; ${Math.round(performance.now() - started)} ms; reply=${JSON.stringify(p.replies.at(-1))}`);
    t.diagnostic(`engine outputs=${JSON.stringify(p.calls.map(call => ({ text: call.output, error: call.error, diagnostic: call.diagnostic })))}`);
    assert.ok(result, 'A cancelled replacement protects the draft but does not pass the model-quality check.');
    assert.equal(p.deliveryErrors.length, 0);
    assertImages(p);
    const output = Array.from(p.replies.at(-1).parts);
    assert.equal(output.length, 3);
    assert.ok(output.every(part => part.trim()), 'Each source block carries meaning in this scenario.');
    assert.match(output[0], /макет/iu);
    assert.match(output[0], /(?:код\s+(?:пока\s+)?не\s+(?:меняй|изменяй|трогай|правь)|не\s+(?:меняй|изменяй|трогай|правь)\s+код|(?:оставь|сохрани)\s+код\s+(?:неизменным|без\s+изменений))/iu,
      'The original prohibition must remain attached to code.');
    assert.match(output[0], /(?:(?:сохрани|оставь)\s+(?:текущее\s+)?API|API\s+(?:сохрани|оставь|не\s+(?:меняй|изменяй|трогай))|(?:не\s+(?:меняй|изменяй|трогай))\s+(?:текущее\s+)?API|API\s+без\s+изменений)/iu,
      'The existing API must still be preserved.');
    assert.doesNotMatch(output[0], /экспорт/iu);
    assert.doesNotMatch(output[1], /\?|код|API|экспорт/iu);
    assert.match(output[1], /(?:покаж|видно|выгляд|визуал|видеть)/iu);
    assert.doesNotMatch(output[1], /(?:добав|встав|прилож|размест)[^.!?\n]*(?:макет|карточк)/iu,
      'The middle block must not repeat the neighbouring request to add a mockup.');
    assert.match(output[2], /изображен/iu);
    assert.match(output[2], /экспорт/iu);
    assert.match(output[2], /(?:объясни|почему|(?:укажи|назови)\s+причин|причин[^?]*\?)/iu,
      'The last block still asks for an explanation.');
    assert.doesNotMatch(output[2], /(?:исправь|восстанови|удали|добавь)/iu);
    assert.doesNotMatch(output[2], /код|API|макет/iu);
    for (const command of ['Добавь макет карточки', 'Код не меняй', 'Сохрани текущее API']) {
      assert.ok(p.controller.getText().toLocaleLowerCase('ru').split(command.toLocaleLowerCase('ru')).length - 1 <= 1,
        `The assembled message repeats a neighbouring task: ${command}`);
    }
  }
});
