import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { schema } from 'prosemirror-schema-basic';
import { EditorState } from 'prosemirror-state';

// The composer uses the VS Code webview message API. Tests supply its reply channel.
const win = globalThis.window = new EventTarget();
win.location = { origin: 'test://editor' };
globalThis.document = {
  addEventListener() {},
  createElement() { return { isConnected: true, style: {}, setAttribute() {} }; }
};
const { bind, connect, prepare } = await import('../extension/composer.mjs');
const paragraph = (...nodes) => schema.node('paragraph', null, nodes);
const text = (value, marks) => schema.text(value, marks);
const doc = (...nodes) => schema.node('doc', null, nodes);

function editor(document) {
  const view = {
    dom: { isConnected: true, after() {}, addEventListener() {} },
    state: EditorState.create({ doc: document }),
    dispatch(transaction) { this.state = this.state.apply(transaction); }
  };
  const controller = {
    view,
    getText(value = view.state.doc) { return value.textBetween(0, value.content.size, '\n'); },
    getPersistedText(value) { return this.getText(value); }
  };
  bind(controller);
  return controller;
}

function replyWith(handler) {
  connect(message => {
    if (message.kind !== 'rewrite') return;
    Promise.resolve(handler(message.text)).then(result => {
      const event = new Event('message');
      event.origin = win.location.origin;
      event.data = {
        type: 'calmcodex/result', id: message.id,
        ...(typeof result === 'string' ? { text: result } : result)
      };
      win.dispatchEvent(event);
    });
  });
}

test('final dictation preserves code marks, an inline attachment and the live editor', async () => {
  replyWith(raw => raw.replace('Блин, верни', 'Верни'));
  const image = schema.nodes.image.create({ src: 'file:///test/pic.png' });
  const code = schema.marks.code.create();
  const spoken = doc(paragraph(text('Блин, верни '), text('save()', [code]), image, text(' и проверь 403.')));
  const live = doc(paragraph(text('Черновая расшифровка')));
  const controller = editor(live);
  const result = await prepare(controller, {
    submittedDocument: spoken, promptRawOverride: controller.getText(spoken), submittedDocumentFormat: 'markdown'
  }, () => true);
  assert.equal(result.promptRawOverride, 'Верни save() и проверь 403.');
  assert.deepEqual(result.submittedDocument.child(0).child(1).marks, [code]);
  assert.equal(result.submittedDocument.child(0).child(2), image);
  assert.equal(controller.view.state.doc, live);
});

test('plain dictation uses the same rewrite for display and history', async () => {
  replyWith(() => 'Почему 403?');
  const result = await prepare(editor(doc(paragraph())), {
    promptRawOverride: 'Блин, почему 403?', persistedPromptRawOverride: 'Блин, почему 403?'
  }, () => true);
  assert.equal(result.promptRawOverride, 'Почему 403?');
  assert.equal(result.persistedPromptRawOverride, 'Почему 403?');
});

test('a duplicate submit is ignored and a later edit survives the pending result', async () => {
  let finish;
  let requests = 0;
  replyWith(() => {
    requests++;
    return new Promise(resolve => { finish = resolve; });
  });
  const original = doc(paragraph(text('Блин, верни кнопку')));
  const controller = editor(original);
  const first = prepare(controller, {}, () => true);
  assert.equal(await prepare(controller, {}, () => true), null);
  controller.view.dispatch(controller.view.state.tr.insertText(' раньше', original.content.size - 1));
  finish('Верни кнопку');
  assert.equal(await first, null);
  assert.equal(controller.getText(), 'Блин, верни кнопку раньше');
  assert.equal(requests, 1);
});

test('a model error leaves the draft intact', async () => {
  replyWith(() => ({ error: 'Ошибка модели' }));
  const controller = editor(doc(paragraph(text('Блин, верни кнопку'))));
  assert.equal(await prepare(controller, {}, () => true), null);
  assert.equal(controller.getText(), 'Блин, верни кнопку');
});

test('a slash command and an attachment-only draft pass through without a model call', async () => {
  replyWith(() => assert.fail('Unexpected rewrite'));
  const image = schema.nodes.image.create({ src: 'file:///test/pic.png' });
  for (const node of [paragraph(), paragraph(image), paragraph(text('/review'))]) {
    assert.deepEqual(await prepare(editor(doc(node)), {}, () => true), {});
  }
});

test('installed Luna rewrites a final transcript before submit', {
  skip: process.env.CALMCODEX_TEST_LIVE !== '1'
}, async () => {
  const standardCLI = '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
  const codeCLI = existsSync(standardCLI) ? standardCLI : 'code';
  const addon = execFileSync(codeCLI, ['--locate-extension', 'local-calmcodex.calmcodex'], { encoding: 'utf8' }).trim();
  assert.ok(addon, 'Install CalmCodex in VS Code before running the live check.');
  const binary = path.join(addon, 'engine/CalmCodex.service/Contents/MacOS/CalmCodex');
  replyWith(raw => new Promise(resolve => {
    const child = execFile(binary, ['--stdin'], (error, stdout) => {
      resolve(error ? { error: error.message } : stdout);
    });
    child.stdin.end(raw);
  }));
  const original = doc(paragraph(text('Блин, почему API вернул 403? Код не меняй.')));
  const controller = editor(doc(paragraph()));
  const result = await prepare(controller, {
    submittedDocument: original, promptRawOverride: controller.getText(original)
  }, () => true);
  assert.ok(result);
  assert.doesNotMatch(result.promptRawOverride, /блин/i);
  assert.match(result.promptRawOverride, /403/);
  assert.match(result.promptRawOverride, /\?/);
  assert.match(result.persistedPromptRawOverride, /не (?:меняй|изменяй|трогай)/i);
});
