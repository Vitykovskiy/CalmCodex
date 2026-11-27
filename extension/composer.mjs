const fields = new WeakMap();
const roots = new WeakMap();
const pending = new Map();
const viewKey = crypto.randomUUID();
let post;
let registered = false;
let contextTarget;
let pointerSelection;

export function connect(send) { post = send; }

function request(text, auto, mode, parts) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Модель не ответила. Черновик сохранён.'));
    }, 80000);
    pending.set(id, msg => {
      clearTimeout(timer);
      if (msg.error) reject(new Error(msg.error));
      else if (msg.bypass) resolve(msg);
      else if (parts && (msg.mode !== 'rewrite' && msg.mode !== 'prompt' || mode && msg.mode !== mode)) {
        reject(new Error('Не удалось проверить режим обработки. Черновик сохранён.'));
      } else if (parts && msg.mode === 'prompt') {
        if (msg.text !== undefined || !Array.isArray(msg.parts) || msg.parts.length !== parts.length ||
            !msg.parts.every(part => typeof part === 'string') || !msg.parts.some(part => part.trim())) {
          reject(new Error('Модель изменила границы фрагментов. Черновик сохранён.'));
        } else resolve(msg);
      } else if (typeof msg.text === 'string') resolve(msg);
      else reject(new Error('Не удалось получить текст от модели.'));
    });
    try { post({ type: 'calmcodex/request', kind: 'rewrite', id, text, auto,
      ...(mode === undefined ? {} : { mode }), ...(parts ? { parts } : {}) }); }
    catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
  });
}

window.addEventListener('message', event => {
  if (event.origin !== window.location.origin) return;
  const msg = event.data;
  if (msg?.type === 'calmcodex/result') {
    const resolve = pending.get(msg.id);
    pending.delete(msg.id);
    resolve?.(msg);
  } else if (msg?.type === 'calmcodex/preview' && contextTarget?.key === msg.key) {
    const target = contextTarget;
    contextTarget = undefined;
    if (target.slot.busy) return;
    const job = preview({ ...target, mode: msg.mode ?? 'rewrite' });
    target.slot.previewDone = job;
    void job.finally(() => { if (target.slot.previewDone === job) target.slot.previewDone = undefined; });
  }
});

function status(slot, text) {
  if (!slot.view.dom.isConnected) return;
  if (!slot.label?.isConnected) {
    if (!text) return;
    const label = document.createElement('div');
    label.setAttribute('role', 'status');
    label.setAttribute('aria-live', 'polite');
    label.className = 'calmcodex-status';
    label.style.cssText = 'font:inherit;font-size:12px;color:var(--vscode-descriptionForeground,currentColor);padding:2px 6px;pointer-events:none';
    slot.view.dom.after(label);
    slot.label = label;
  }
  slot.label.hidden = !text;
  slot.label.textContent = text;
}

export function bind(controller) {
  const view = controller?.view;
  const dom = view?.dom;
  if (!dom || view.isDestroyed) return controller;
  if (fields.has(view)) return controller;
  const slot = { view, controller, revision: 0 };
  const changed = () => {
    slot.revision++;
    if (!slot.busy && slot.label?.textContent) status(slot, '');
  };
  dom.addEventListener('beforeinput', changed);
  dom.addEventListener('input', changed);
  fields.set(view, slot);
  roots.set(dom, slot);
  if (!registered) {
    post({ type: 'calmcodex/request', kind: 'register', key: viewKey });
    registered = true;
  }
  return controller;
}

document.addEventListener('pointerdown', event => {
  if (event.button !== 2 && !(event.button === 0 && event.ctrlKey)) return;
  const slot = roots.get(event.target?.closest?.('.ProseMirror[contenteditable=true]'));
  pointerSelection = slot && { slot, doc: slot.view.state.doc, selection: slot.view.state.selection, time: performance.now() };
}, true);

document.addEventListener('contextmenu', event => {
  const dom = event.target?.closest?.('.ProseMirror[contenteditable=true]');
  const slot = roots.get(dom);
  if (!slot) return;
  const key = crypto.randomUUID();
  const existing = JSON.parse(dom.getAttribute('data-vscode-context') || '{}');
  dom.setAttribute('data-vscode-context', JSON.stringify({ ...existing, calmCodexComposer: true, calmCodexView: viewKey, calmCodexField: key }));
  const doc = slot.view.state.doc;
  const prior = pointerSelection;
  const selection = prior?.slot === slot && prior.doc === doc && performance.now() - prior.time < 1600
    ? prior.selection : slot.view.state.selection;
  contextTarget = { key, slot, doc, selection };
  pointerSelection = undefined;
}, true);

function plan(doc, from, to) {
  const runs = [];
  const regionStarts = [];
  let protectedBoundary = false;
  doc.nodesBetween(from, to, (node, pos, parent) => {
    if (!node.isText) {
      if (node.type.spec.code || (node.isAtom && !/^(?:hard_?break|hardBreak)$/.test(node.type.name))) {
        protectedBoundary = true;
        return false;
      }
      return;
    }
    if (node.marks.some(mark => mark.type.spec.code || mark.type.name === 'code')) return false;
    const start = Math.max(from, pos);
    const end = Math.min(to, pos + node.nodeSize);
    const text = node.text.slice(start - pos, end - pos);
    if (!text.trim()) return;
    // Inline formatting divides editor ranges, but the model still needs the whole phrase.
    if (protectedBoundary || runs.at(-1)?.parent !== parent) regionStarts.push(runs.length);
    protectedBoundary = false;
    runs.push({ start, end, text, marks: node.marks, parent });
  });
  // Each immutable boundary protects nodes and marks such as file mentions, links, and paragraph breaks.
  const id = crypto.randomUUID().slice(0, 12);
  const separators = runs.slice(1).map((run, index) => {
    const marker = String.fromCharCode(96) + 'CC-' + id + '-' + index + String.fromCharCode(96);
    return run.parent === runs[index].parent ? marker : '\n'+marker+'\n';
  });
  function encode(start, end) {
    return runs.slice(start, end).map((run, index) =>
      (index ? separators[start + index - 1] : '') + run.text).join('');
  }
  const source = encode(0, runs.length);
  const regions = regionStarts.map((start, index) => [start, regionStarts[index + 1] ?? runs.length]);
  const parts = regions.length > 1 ? regions.map(([start, end]) => encode(start, end)) : undefined;
  function decode(answer, start, end) {
    const segments = [];
    let remaining = answer;
    for (const separator of separators.slice(start, end - 1)) {
      const marker = separator.trim();
      const at = remaining.indexOf(marker);
      if (at === -1 || remaining.indexOf(marker, at + marker.length) !== -1) {
        throw new Error('Модель изменила границы форматирования. Черновик сохранён.');
      }
      let before = remaining.slice(0, at);
      remaining = remaining.slice(at + marker.length);
      if (separator.startsWith('\n')) {
        before = before.replace(/\r?\n$/, '');
        remaining = remaining.replace(/^\r?\n/, '');
      }
      segments.push(before);
    }
    segments.push(remaining);
    return segments;
  }
  function replacement(tr, answer) {
    const segments = Array.isArray(answer)
      ? regions.flatMap(([start, end], index) => decode(answer[index], start, end))
      : decode(answer, 0, runs.length);
    const schema = doc.type.schema;
    const hardBreak = schema.nodes.hard_break || schema.nodes.hardBreak || schema.nodes.hardbreak;
    for (let i = runs.length - 1; i >= 0; --i) {
      const run = runs[i], next = segments[i];
      if (next === run.text) continue;
      const inline = [];
      for (const [index, line] of next.split(/\r\n?|\n/).entries()) {
        if (index) inline.push(hardBreak ? hardBreak.create() : schema.text('\n', run.marks));
        if (line.length) inline.push(schema.text(line, run.marks));
      }
      tr.replaceWith(run.start, run.end, inline);
    }
    return tr;
  }
  return { source, parts, replacement };
}

function promptPlan(doc, from, to) {
  function fixedRange(start, end) {
    const edit = plan(doc, start, end);
    return { parts: edit.parts ?? (edit.source.trim() ? [edit.source] : []), replacement: edit.replacement };
  }
  // A selection owns only its text ranges, not the surrounding paragraph structure.
  if (from !== 0 || to !== doc.content.size) return fixedRange(from, to);

  function isPlainParagraph(node) {
    if (node.type.name !== 'paragraph' || node.type.spec.code || node.marks.length ||
        JSON.stringify(node.attrs) !== JSON.stringify(node.type.defaultAttrs ?? {})) return false;
    let plain = true;
    node.forEach(child => {
      if (child.marks.length || !(child.isText || /^(?:hard_?break|hardBreak)$/.test(child.type.name)) ||
          (!child.isText && JSON.stringify(child.attrs) !== JSON.stringify(child.type.defaultAttrs ?? {}))) plain = false;
    });
    return plain;
  }

  const groups = [];
  doc.forEach((node, pos) => {
    const plain = isPlainParagraph(node);
    let group = groups.at(-1);
    if (!group || group.plain !== plain) {
      group = { plain, from: pos, to: pos, nodes: [] };
      groups.push(group);
    }
    group.nodes.push(node);
    group.to = pos + node.nodeSize;
  });

  const parts = [];
  const edits = [];
  for (const group of groups) {
    const start = parts.length;
    if (!group.plain) {
      const edit = fixedRange(group.from, group.to);
      parts.push(...edit.parts);
      if (edit.parts.length) edits.push({ start, end: parts.length, replacement: edit.replacement });
      continue;
    }
    const source = group.nodes.map(node => node.textBetween(0, node.content.size, '\n', '\n')).join('\n\n');
    if (!source.trim()) continue;
    parts.push(source);
    edits.push({ start, end: parts.length, replacement(tr, answer) {
      const next = answer[0];
      if (next === source) return tr;
      if (!next.trim()) return tr.delete(group.from, group.to);
      const schema = doc.type.schema;
      const hardBreak = schema.nodes.hard_break || schema.nodes.hardBreak || schema.nodes.hardbreak;
      const paragraphs = next.replace(/\r\n?/g, '\n').split('\n\n').map(value => {
        const inline = [];
        for (const [index, line] of value.split('\n').entries()) {
          if (index) inline.push(hardBreak ? hardBreak.create() : schema.text('\n'));
          if (line.length) inline.push(schema.text(line));
        }
        return group.nodes[0].type.create(group.nodes[0].attrs, inline);
      });
      return tr.replaceWith(group.from, group.to, paragraphs);
    } });
  }

  return { parts, replacement(tr, answer) {
    // Original positions remain valid when complete blocks and protected ranges are replaced backwards.
    for (let index = edits.length - 1; index >= 0; index--) {
      const edit = edits[index];
      edit.replacement(tr, answer.slice(edit.start, edit.end));
    }
    return tr;
  } };
}

function ensureCurrent(slot, doc, revision, stillHere, action) {
  if (slot.view.isDestroyed || !slot.view.dom.isConnected || slot.view.state.doc !== doc || slot.revision !== revision || !stillHere()) {
    throw new Error(action);
  }
}

async function preview({ slot, doc, selection, mode }) {
  if (slot.busy || slot.view.state.doc !== doc || !slot.view.dom.isConnected) return;
  const whole = selection.empty || (selection.from <= 1 && selection.to >= doc.content.size - 1);
  slot.busy = true;
  const revision = slot.revision;
  try {
    const from = whole ? 0 : selection.from;
    const to = whole ? doc.content.size : selection.to;
    const edit = plan(doc, from, to);
    if (!edit.source.trim()) return true;
    const prompt = promptPlan(doc, from, to);
    status(slot, mode === 'prompt' ? 'Готовлю промпт…' : 'Переформулирую…');
    const result = await request(edit.source, false, mode, prompt.parts);
    ensureCurrent(slot, doc, revision, () => true, 'Черновик изменился. Ваша правка сохранена.');
    if (!result.bypass) {
      const tr = result.mode === 'prompt'
        ? prompt.replacement(slot.view.state.tr, result.parts)
        : edit.replacement(slot.view.state.tr, result.text);
      if (tr.docChanged) slot.view.dispatch(tr);
      if (whole) slot.cleaned = slot.view.state.doc;
    }
    status(slot, '');
    return true;
  } catch (error) { status(slot, error.message); return false; }
  finally { slot.busy = false; }
}

// Called by Codex after final voice transcription, before native submit snapshots, history and routing.
export async function prepare(controller, options, stillHere) {
  bind(controller);
  const view = controller.view, slot = fields.get(view);
  if (!slot || view.isDestroyed) return options;
  if (slot.previewDone) {
    if (slot.waitingSend) return null;
    slot.waitingSend = true;
    try { if (!await slot.previewDone || !stillHere()) return null; }
    finally { slot.waitingSend = false; }
  }
  if (slot.busy) return null;
  const live = view.state.doc;
  const revision = slot.revision;
  const frozen = options.submittedDocument;
  const override = options.promptRawOverride;
  const raw = override ?? controller.getText();
  if (!raw?.trim() || /^\s*\/[\w:-]+(?:\s|$)/u.test(raw)) return options;
  if (!frozen && override == null && slot.cleaned === live) return options;
  slot.busy = true;
  try {
    const doc = frozen || (override == null ? live : null);
    const edit = doc && plan(doc, 0, doc.content.size);
    const source = edit ? edit.source : raw;
    if (!source.trim()) return options;
    const prompt = doc && promptPlan(doc, 0, doc.content.size);
    status(slot, 'Переформулирую…');
    const answer = await request(source, true, undefined, prompt?.parts);
    ensureCurrent(slot, live, revision, stillHere, 'Черновик изменился. Отправка отменена.');
    status(slot, '');
    if (answer.bypass || answer.text === source) return options;
    if (!doc) {
      // Some voice submissions only supply the finished transcript, without an editor document.
      return { ...options, promptRawOverride: answer.text, persistedPromptRawOverride: answer.text };
    }
    if (frozen) {
      const state = view.state.constructor.create({ schema: doc.type.schema, doc });
      const updated = (answer.mode === 'prompt'
        ? prompt.replacement(state.tr, answer.parts)
        : edit.replacement(state.tr, answer.text)).doc;
      const format = options.submittedDocumentFormat;
      return { ...options, submittedDocument: updated,
        promptRawOverride: controller.getText(updated, { format }),
        persistedPromptRawOverride: controller.getPersistedText(updated, { format }) };
    }
    const tr = answer.mode === 'prompt'
      ? prompt.replacement(view.state.tr, answer.parts)
      : edit.replacement(view.state.tr, answer.text);
    if (tr.docChanged) view.dispatch(tr);
    slot.cleaned = view.state.doc;
    return options;
  } catch (error) { status(slot, error.message); return null; }
  finally { slot.busy = false; }
}
