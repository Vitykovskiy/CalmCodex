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
const documentListeners = new Map();
globalThis.document = {
  addEventListener(type, handler) { documentListeners.set(type, handler); },
  createElement() { return { isConnected: true, style: {}, setAttribute() {} }; }
};
const { bind, connect, prepare } = await import('../extension/composer.mjs');
const paragraph = (...nodes) => schema.node('paragraph', null, nodes);
const text = (value, marks) => schema.text(value, marks);
const doc = (...nodes) => schema.node('doc', null, nodes);

function editor(document) {
  const attributes = new Map();
  const view = {
    dom: {
      isConnected: true, after() {}, addEventListener() {},
      getAttribute(name) { return attributes.get(name); },
      setAttribute(name, value) { attributes.set(name, value); }
    },
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
    Promise.resolve(handler(message.text, message)).then(result => {
      const event = new Event('message');
      event.origin = win.location.origin;
      event.data = {
        type: 'calmcodex/result', id: message.id,
        mode: message.mode ?? 'rewrite',
        ...(typeof result === 'string' ? { text: result } : result)
      };
      win.dispatchEvent(event);
    });
  });
}

function requestPreview(controller, mode) {
  const dom = controller.view.dom;
  documentListeners.get('contextmenu')({ target: { closest() { return dom; } } });
  const { calmCodexField } = JSON.parse(dom.getAttribute('data-vscode-context'));
  const event = new Event('message');
  event.origin = win.location.origin;
  event.data = { type: 'calmcodex/preview', key: calmCodexField, mode };
  win.dispatchEvent(event);
}

test('a full prompt preview routes its mode and is submitted without another rewrite', async () => {
  const requests = [];
  replyWith((raw, message) => {
    requests.push(message);
    return 'Исправь двойное сохранение. API сохрани.';
  });
  const controller = editor(doc(paragraph(text('Блин, сохранение дважды. Почини, API не трогай.'))));
  requestPreview(controller, 'prompt');
  const options = {};
  assert.equal(await prepare(controller, options, () => true), options);
  assert.equal(controller.getText(), 'Исправь двойное сохранение. API сохрани.');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].auto, false);
  assert.equal(requests[0].mode, 'prompt');
});

test('a failed prompt preview preserves the draft and cancels a pending submit', async () => {
  let requests = 0;
  replyWith(() => { requests++; return { error: 'Модель недоступна.' }; });
  const original = 'Почему 403? Код не меняй.';
  const controller = editor(doc(paragraph(text(original))));
  requestPreview(controller, 'prompt');
  assert.equal(await prepare(controller, {}, () => true), null);
  assert.equal(controller.getText(), original);
  assert.equal(requests, 1);
});

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

test('prompt regions keep the example caption and attachment before the following requirements', async () => {
  const caption = 'Импорт падает на пустых строках. Вот пример:';
  const request = 'Поправь чтение. CSV на входе не переделывай, лог оставь прежним';
  const calls = [];
  replyWith((raw, message) => {
    calls.push(message);
    assert.deepEqual(message.parts, [caption, request]);
    return { mode: 'prompt', parts: [caption, 'Исправь чтение. CSV на входе не меняй, лог сохрани.'] };
  });
  const image = schema.nodes.image.create({ src: 'file:///test/example.png' });
  const submitted = doc(paragraph(text(caption), image), paragraph(text(request)));
  const controller = editor(doc(paragraph(text('Живой черновик'))));
  const live = controller.view.state.doc;
  const result = await prepare(controller, {
    submittedDocument: submitted, promptRawOverride: controller.getText(submitted), submittedDocumentFormat: 'markdown'
  }, () => true);
  assert.ok(result);
  assert.equal(result.submittedDocument.child(0).textContent, caption);
  assert.equal(result.submittedDocument.child(0).lastChild, image);
  assert.equal(result.submittedDocument.child(1).textContent, 'Исправь чтение. CSV на входе не меняй, лог сохрани.');
  assert.equal(result.promptRawOverride, result.persistedPromptRawOverride);
  assert.equal(controller.view.state.doc, live);
  assert.equal(calls.length, 1);
});

test('a flattened prompt answer with its boundary moved to the end preserves the whole draft', async () => {
  replyWith((raw, message) => {
    const marker = raw.match(/`CC-[^`]+`/u)?.[0];
    assert.ok(marker);
    return { mode: 'prompt', text: message.parts.join(' ') + '\n' + marker + '\n' };
  });
  const image = schema.nodes.image.create({ src: 'file:///test/example.png' });
  const original = doc(
    paragraph(text('Импорт падает на пустых строках. Вот пример:'), image),
    paragraph(text('Поправь чтение. CSV на входе не переделывай, лог оставь прежним'))
  );
  const controller = editor(original);
  assert.equal(await prepare(controller, {}, () => true), null);
  assert.equal(controller.view.state.doc, original);
});

test('a structured prompt requires a validated mode and a complete region array', async () => {
  const original = doc(paragraph(text('Подпись.')), paragraph(text('Требование.')));
  for (const reply of [
    { mode: undefined, text: 'Слитый текст.' },
    { mode: 'prompt', parts: ['Одна часть.'] },
    { mode: 'prompt', parts: ['', ''] },
    { mode: 'prompt', parts: ['Подпись.', 2] }
  ]) {
    replyWith(() => reply);
    const controller = editor(original);
    assert.equal(await prepare(controller, {}, () => true), null);
    assert.equal(controller.view.state.doc, original);
  }
});

test('an empty prompt region removes noise and allows the remaining task to submit', async () => {
  replyWith((raw, message) => {
    assert.deepEqual(message.parts, ['Блядь!', 'Поправь чтение.']);
    return { mode: 'prompt', parts: ['', 'Исправь чтение.'] };
  });
  const controller = editor(doc(paragraph(text('Блядь!')), paragraph(text('Поправь чтение.'))));
  assert.deepEqual(await prepare(controller, {}, () => true), {});
  assert.equal(controller.view.state.doc.child(0).textContent, '');
  assert.equal(controller.view.state.doc.child(1).textContent, 'Исправь чтение.');
});

test('formatting boundaries keep the negated verb in the same prompt region', async () => {
  const bold = schema.marks.strong.create();
  const image = schema.nodes.image.create({ src: 'file:///test/example.png' });
  const original = doc(paragraph(
    text('Блин, ни в коем случае не '), text('откатывай', [bold]), text('. Вот пример:'), image,
    text('Только объясни причину сбоя.')
  ));
  replyWith((raw, message) => {
    assert.equal(message.parts.length, 2);
    assert.match(message.parts[0], /не `CC-[^`]+`откатывай`CC-[^`]+`\. Вот пример:$/u);
    assert.equal(message.parts[1], 'Только объясни причину сбоя.');
    return { mode: 'prompt', parts: [
      message.parts[0].replace('Блин, ни', 'Ни'), message.parts[1]
    ] };
  });
  const controller = editor(original);
  assert.deepEqual(await prepare(controller, {}, () => true), {});
  const result = controller.view.state.doc.child(0);
  assert.equal(result.textContent, 'Ни в коем случае не откатывай. Вот пример:Только объясни причину сбоя.');
  assert.deepEqual(result.child(1).marks, [bold]);
  assert.equal(result.child(3), image);
});

test('one failed prompt region leaves all editor ranges unchanged', async () => {
  replyWith(() => ({ mode: 'prompt', error: 'Ошибка второй части.' }));
  const original = doc(paragraph(text('Подпись.')), paragraph(text('Требование.')));
  const controller = editor(original);
  assert.equal(await prepare(controller, {}, () => true), null);
  assert.equal(controller.view.state.doc, original);
});

test('an edit while isolated prompt regions are pending survives their result', async () => {
  let finish;
  replyWith(() => new Promise(resolve => { finish = resolve; }));
  const controller = editor(doc(paragraph(text('Подпись.')), paragraph(text('Требование.'))));
  const pending = prepare(controller, {}, () => true);
  controller.view.dispatch(controller.view.state.tr.insertText('Уточнение. ', 1));
  const edited = controller.view.state.doc;
  finish({ mode: 'prompt', parts: ['Другая подпись.', 'Другое требование.'] });
  assert.equal(await pending, null);
  assert.equal(controller.view.state.doc, edited);
});

test('a full isolated prompt preview keeps the attachment and submits without another rewrite', async () => {
  let calls = 0;
  replyWith((raw, message) => {
    calls++;
    assert.equal(message.mode, 'prompt');
    return { mode: 'prompt', parts: ['Пример:', 'Исправь чтение.'] };
  });
  const image = schema.nodes.image.create({ src: 'file:///test/example.png' });
  const controller = editor(doc(paragraph(text('Вот пример:'), image), paragraph(text('Поправь чтение.'))));
  requestPreview(controller, 'prompt');
  const options = {};
  assert.equal(await prepare(controller, options, () => true), options);
  assert.equal(calls, 1);
  assert.equal(controller.view.state.doc.child(0).lastChild, image);
  assert.equal(controller.view.state.doc.child(1).textContent, 'Исправь чтение.');
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
