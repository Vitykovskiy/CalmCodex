'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

// These opt-in checks call the real service and consume the current Codex account's limits.
// The assertions catch known intent regressions; diagnostics remain available for semantic review.
const enabled = process.env.CALMCODEX_TEST_LIVE === '1';
const binary = process.env.CALMCODEX_TEST_BINARY || process.env.CALMCODEX_ENGINE || path.resolve(__dirname,
  '../macos/build/CalmCodex.service/Contents/MacOS/CalmCodex');
const model = process.env.CALMCODEX_TEST_MODEL?.trim();
const effort = process.env.CALMCODEX_TEST_REASONING_EFFORT?.trim();
const repetitions = Number(process.env.CALMCODEX_LIVE_REPETITIONS || 3);
if (enabled) {
  assert.ok(existsSync(binary), 'Build the current service or set CALMCODEX_TEST_BINARY / CALMCODEX_ENGINE.');
  assert.ok(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 10,
    'CALMCODEX_LIVE_REPETITIONS must be an integer from 1 to 10.');
  assert.ok(!effort || ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort),
    'CALMCODEX_TEST_REASONING_EFFORT must be low, medium, high, xhigh or max.');
}

function rewrite(scenario, mode) {
  const args = [scenario.context ? '--stdin-json' : '--stdin', '--mode', mode];
  args.push(scenario.ultracave ? '--ultracave' : '--no-ultracave');
  if (scenario.context && mode === 'prompt') args.push('--allow-empty');
  if (model) args.push('--model', model);
  if (effort) args.push('--reasoning-effort', effort);
  const input = scenario.context
    ? JSON.stringify({ draft: scenario.draft, context: scenario.context })
    : scenario.draft;
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = execFile(binary, args, { timeout: 70000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve({ text: stdout.trim(), elapsedMs: Math.round(performance.now() - started) });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function visualRequest(answer) {
  assert.doesNotMatch(answer, /\?/u, 'The rhetorical complaint must not become a literal question.');
  assert.match(answer, /(?:покажи|добавь|вставь|приложи|размести|предоставь|отобрази|представь|(?:нужно|необходимо|следует)\s+(?:показать|добавить|вставить|приложить|разместить|предоставить|отобразить)|(?:нужен|нужна|нужны|нужно|необходимы?|необходимо)\s+(?:визуал|макет|изображен|фрагмент)|сделай[^.!?;\n]*(?:видно|наглядно))/iu,
    'The missing visual result must remain an actionable requirement.');
  assert.match(answer, /(?:макет|изображен|визуал|фрагмент|выгляд|видно|видеть|вид(?=\s|[.!?,:;]|$))/iu);
  const imagine = String.raw`(?:фантазир\p{L}*|додумыва\p{L}*|догадыва\p{L}*|вообража\p{L}*|представля\p{L}*)`;
  const authorDuty = new RegExp([
    String.raw`(?:^|[^\p{L}\p{N}_])я\s+(?:сам\s+)?(?:должен|буду)\s+(?:сам\s+)?${imagine}`,
    String.raw`(?:^|[^\p{L}\p{N}_])я\s+(?:сам\s+)?${imagine}\s+(?:сам\s+)?должен`,
    String.raw`(?:^|[^\p{L}\p{N}_])мне\s+(?:самому\s+)?(?:нужно|надо|необходимо|предстоит|придётся|придется|приходится|следует)\s+(?:самому\s+)?${imagine}`,
    String.raw`(?<!не )(?<![\p{L}\p{N}_])(?:нужно|надо|необходимо|требуется)\s*,?\s*чтобы\s+я\s+(?:сам\s+)?${imagine}`
  ].join('|'), 'iu');
  assert.doesNotMatch(answer.replace(/\s+/gu, ' '), authorDuty,
    'Removing the question mark must not leave an obligation for the author to imagine the result.');
  assert.doesNotMatch(answer, /(?:не\s+(?:фантазируй|выдумывай|придумывай)|перестань\s+(?:фантазировать|выдумывать))/iu,
    'The author should not have to imagine the result; this is not an accusation of agent fabrication.');
}

function codeUnchanged(answer) {
  const action = '(?:меняй|изменяй|трогай|правь|модифицируй|менять|изменять|трогать|править|модифицировать)';
  const temporal = '(?:\\s+(?:пока|сейчас|вообще|совсем))*';
  const restriction = new RegExp([
    `код${temporal}\\s+не\\s+${action}`,
    `не\\s+${action}${temporal}\\s+(?:(?:исходный|существующий|текущий)\\s+)?код(?=\\s|[.!?,;:]|$)`,
    '(?:оставь|сохрани)\\s+код\\s+(?:без\\s+изменений|неизменным)',
    'код\\s+(?:оставь|сохрани)\\s+(?:без\\s+изменений|неизменным)',
    'без\\s+(?:изменения|изменений|правок|модификации)\\s+кода'
  ].join('|'), 'iu');
  assert.match(answer, restriction, 'The prohibition must apply to code, not to a different object.');
}

const screenshotDraft = [
  'Ну снова нет макетов. У тебя вот есть элемент и его описание. Ну воткни ты блять еще и из макета туда что-нибудь блять',
  'Я даже проверять больше не буду. Один текст блять',
  'Я фантазировать что-ли должен, как это все выглядит блять?'
].join('\n');

const importDraft = [
  'Я все таки думаю, что взять за основу вариант Б с модальным окном, но у нас в постановке вроде как должен быть вариант с созданием шаблона без выбора файла, так?',
  'В ui это нужно продумать. Сделать реестр шаблонов импорта? В администрирование добавить?',
  'Там будет реестр шаблонов наверное и карточки шаблонов. И эта карточка может быть как в модалке импорта, так и как карточка в реестре шаблонов. Что думаешь?',
  'Сделай ка черновик импорта такой'
].join('\n');

function importRequest(answer) {
  const opening = answer.split(/\r?\n/u).map(line => line.trim()
    .replace(/^#{1,6}\s+/u, '').replace(/^(?:[-*+]\s+|\d+[.)]\s+)/u, '').replace(/\*\*/gu, ''))
    .find(line => line && !/^(?:цель|задача|запрос)\s*:?$/iu.test(line)) || '';
  const firstSentence = opening.split(/[.!?]/u)[0];
  assert.match(firstSentence, /(?:сделай|сделать|подготовь|подготовить|создай|создать|разработай|разработать|набросай|набросать|^(?:цель|задача)\s*:|^черновик(?=\s|:|$))/iu);
  assert.match(firstSentence, /черновик/iu, 'The concrete final request must lead the prompt.');
  assert.match(firstSentence, /импорт/iu);
  assert.match(answer, /вариант\s+Б/iu);
  assert.match(answer, /модал/iu);
  assert.match(answer, /(?:без\s+(?:предварительного\s+)?выбора\s+файла|не\s+выбирая\s+файл)/iu);
  const questions = answer.match(/[^.!?\n]*\?/gu) || [];
  assert.ok(questions.some(question => /шаблон/iu.test(question) && /файл/iu.test(question)),
    'Keep the genuine question confirming template creation without a file.');
  assert.ok(questions.some(question => /реестр/iu.test(question)), 'Keep the question proposing a registry.');
  assert.ok(questions.some(question => /администрирован/iu.test(question)), 'Keep the placement question.');
  assert.match(answer, /(?:что\s+думаешь|как\s+(?:ты\s+)?(?:считаешь|думаешь)|твое?\s+мнение|твоё\s+мнение|оцени)/iu);
  const sentences = answer.split(/(?<=[.!?])\s+|\n+/u).filter(Boolean);
  const tentative = /(?:наверное|возможно|предполага|предлож|предлага|думаю|вроде|может|могл[аои]?\s+бы|гипотез|стоит\s+ли|нужен\s+ли)/iu;
  assert.ok(sentences.some(sentence => /реестр/iu.test(sentence) && (tentative.test(sentence) || sentence.includes('?'))),
    'The registry is a tentative proposal, not a settled requirement.');
  assert.ok(sentences.some(sentence => /карточк/iu.test(sentence) && tentative.test(sentence)),
    'Keep the uncertainty associated with the template cards.');
  assert.ok(sentences.some(sentence => /модал/iu.test(sentence) && /реестр/iu.test(sentence)
    && (tentative.test(sentence) || sentence.includes('?'))),
  'Using the card in both locations remains a possibility.');
  for (const sentence of sentences) {
    if (!/(?:реестр|карточк|администрирован)/iu.test(sentence) || tentative.test(sentence) || sentence.includes('?')) continue;
    assert.doesNotMatch(sentence, /(?:добавь|создай|сделай|размести|будет|будут|используется|используются|открывается|открываются)/iu,
      'Do not promote an architectural hypothesis to an instruction or a definite decision.');
  }
}

const conciseDraft = 'Объясни причину ошибки в `src/import.ts` максимум в трёх предложениях. Если причина в API, укажи это. Код не меняй.';

function conciseRequest(answer) {
  assert.match(answer, /объясни[^.!?\n]*причин/iu);
  assert.ok(answer.includes('`src/import.ts`'), 'Preserve the literal file reference.');
  assert.match(answer, /если[^.!?\n]*API[^.!?\n]*(?:укажи|отметь|сообщи)/iu);
  codeUnchanged(answer);
  assert.match(answer, /тр[её]х\s+предложен/iu);
  assert.match(answer, /(?:не\s+больше|не\s+более|максимум|до\s+тр[её]х)/iu);
  assert.doesNotMatch(answer, /\?/u);
}

const cases = [
  {
    name: 'the reported full draft requests a visual result instead of asking the author to imagine it',
    draft: screenshotDraft,
    check(answer) {
      visualRequest(answer);
      assert.match(answer, /макет/iu);
      assert.match(answer, /элемент/iu);
      assert.match(answer, /описан/iu);
      assert.match(answer, /(?:снова|опять|по-прежнему)/iu);
      assert.match(answer, /текст/iu);
    }
  },
  {
    name: 'a final rhetorical fragment uses preceding context without copying neighbouring requests',
    draft: 'Я фантазировать что-ли должен, как это все выглядит блять?',
    context: {
      before: [
        'Снова нет макетов. У тебя есть элемент и его описание. Добавь туда фрагмент макета.',
        'Я даже проверять больше не буду. Один текст.'
      ],
      after: ['Отдельно объясни причину AUTH_731. Сохрани API.']
    },
    check(answer) {
      visualRequest(answer);
      assert.doesNotMatch(answer, /AUTH_731|API|проверять|объясни/iu,
        'Only the target fragment belongs in the replacement.');
    }
  },
  {
    name: 'following context also disambiguates a rhetorical question',
    draft: 'Я сам должен додумывать, как это выглядит?',
    context: {
      before: [],
      after: ['Вместо макета снова только описание. Добавь фрагмент макета рядом с элементом.']
    },
    check: visualRequest
  },
  {
    name: 'a genuine question about creative freedom keeps both alternatives',
    draft: 'При разработке эскиза можно фантазировать или нужно точно повторять макет?',
    check(answer) {
      assert.match(answer, /\?/u);
      assert.match(answer, /эскиз/iu);
      assert.match(answer, /(?:фантазир|свобод|творческ|отступ)/iu);
      assert.match(answer, /(?:точно|строго|повтор|соответств)/iu);
      assert.match(answer, /макет/iu);
      assert.match(answer, /(?:или|либо)/iu);
      assert.doesNotMatch(answer, /(?:^|[.!?\n]\s*)(?:покажи|добавь|создай|разработай|измени)(?=\s|[.!?,]|$)/iu);
    }
  },
  {
    name: 'a mixed complaint retains the independent export question and the code restriction',
    draft: 'Мне самому додумывать вид кнопки? Добавь её из макета. Почему изображение исчезло после экспорта? Код пока не меняй.',
    check(answer) {
      assert.match(answer, /(?:добав|встав|прилож|размест|покаж|отобраз)/iu);
      assert.match(answer, /кнопк/iu);
      assert.match(answer, /макет/iu);
      assert.equal((answer.match(/\?/gu) || []).length, 1,
        'Keep the independent export question, without turning the complaint into another question.');
      assert.match(answer, /(?:почему|из-за чего|по какой причине)[^?]*экспорт[^?]*\?/iu);
      codeUnchanged(answer);
    }
  },
  {
    name: 'a question asking whether a ready-made design exists is not converted into an instruction',
    draft: 'Я должен придумать внешний вид сам или есть готовый макет?',
    check(answer) {
      assert.match(answer, /\?/u);
      assert.match(answer, /(?:придум|разработ|самостоятельн|сам(?=\s|[.!?,:;]|$))/iu);
      assert.match(answer, /(?:или|либо)/iu);
      assert.match(answer, /готов[^?]*макет/iu);
      assert.doesNotMatch(answer, /(?:^|[.!?\n]\s*)(?:покажи|добавь|создай|разработай|предоставь)(?=\s|[.!?,]|$)/iu);
    }
  }
];

cases.push({
  ...cases[0],
  name: 'the reported rhetorical complaint preserves its intent with Ultracave enabled',
  ultracave: true
});

for (const ultracave of [false, true]) {
  cases.push({
    name: `the import UI draft leads with the task and preserves tentative design choices; ultracave=${ultracave}`,
    modes: ['prompt'],
    draft: importDraft,
    ultracave,
    check(answer) {
      importRequest(answer);
      if (ultracave) assert.ok(answer.length < importDraft.length, 'Ultracave should compress this verbose draft.');
    }
  }, {
    name: `a clear request retains its file, condition, code restriction and output limit; ultracave=${ultracave}`,
    draft: conciseDraft,
    ultracave,
    check(answer) {
      conciseRequest(answer);
      if (ultracave) assert.ok(answer.length <= conciseDraft.length, 'Ultracave should preserve or shorten an already compact request.');
      else assert.equal(answer, conciseDraft, 'With Ultracave off, an already clear neutral request stays verbatim.');
    }
  });
}

test('semantic checks reject known intent inversions and definite rewrites of tentative ideas', () => {
  for (const answer of [
    'Нужно, чтобы я сам фантазировал, как это выглядит.',
    'Снова нет макетов. Добавь к элементу и описанию фрагмент макета. Один текст. Я должен фантазировать, как это выглядит.'
  ]) assert.throws(() => visualRequest(answer), { name: 'AssertionError' });
  visualRequest('Добавь к элементу фрагмент макета, чтобы мне не приходилось додумывать, как это выглядит.');
  visualRequest('Покажи, как это выглядит.');
  visualRequest('Нужно изображение элемента, чтобы было видно, как он выглядит.');
  assert.throws(() => codeUnchanged('Код поменяй; не трогай макет.'), { name: 'AssertionError' });
  codeUnchanged('Код пока не меняй.');
  codeUnchanged('Не меняй код.');
  codeUnchanged('Оставь код без изменений.');
  const importAnswer = 'Сделай черновик импорта. За основу предлагаю вариант Б с модальным окном. Верно ли, что по постановке нужно создавать шаблон без выбора файла? Нужен ли реестр шаблонов импорта, и стоит ли добавить его в администрирование? Предполагаю реестр с карточками шаблонов. Карточка может быть как в модалке импорта, так и в реестре шаблонов. Что думаешь?';
  importRequest(importAnswer);
  importRequest('## Задача\n' + importAnswer);
  importRequest(importAnswer.replace('Сделай черновик импорта.', '**Черновик импорта**\n'));
  assert.throws(() => importRequest(importAnswer
    .replace('Предполагаю реестр с карточками шаблонов.', 'Будет реестр с карточками шаблонов.')
    .replace('Карточка может быть', 'Карточка будет')), { name: 'AssertionError' });
});

for (const mode of ['rewrite', 'prompt']) {
  for (const scenario of cases) {
    if (scenario.modes && !scenario.modes.includes(mode)) continue;
    test(`${mode}: ${scenario.name}`, { skip: !enabled, timeout: repetitions * 75000 }, async t => {
      t.diagnostic(`model=${model || 'service setting'}; reasoning=${effort || 'service setting'}; ultracave=${Boolean(scenario.ultracave)}`);
      for (let attempt = 1; attempt <= repetitions; attempt++) {
        const answer = await rewrite(scenario, mode);
        t.diagnostic(`${attempt}/${repetitions}; ${answer.elapsedMs} ms: ${answer.text}`);
        assert.ok(answer.text, 'The target contains a meaningful request or question and must not disappear.');
        scenario.check(answer.text);
      }
    });
  }
}
