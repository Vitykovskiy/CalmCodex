'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const enabled = process.env.CALMCODEX_TEST_LIVE === '1';
const binary = process.env.CALMCODEX_ENGINE || path.resolve(__dirname,
  '../macos/build/CalmCodex.service/Contents/MacOS/CalmCodex');
const repetitions = Number(process.env.CALMCODEX_LIVE_REPETITIONS || 3);
if (enabled) {
  assert.ok(existsSync(binary), 'Build the current service with zsh macos/build.command or set CALMCODEX_ENGINE.');
  assert.ok(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 10,
    'CALMCODEX_LIVE_REPETITIONS must be an integer from 1 to 10.');
}

function preparePrompt(draft) {
  return new Promise((resolve, reject) => {
    const child = execFile(binary, ['--stdin', '--mode', 'prompt'], {
      timeout: 70000, maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout.trim());
    });
    child.stdin.on('error', () => {});
    child.stdin.end(draft);
  });
}

const cases = [
  {
    name: 'audience question preserves the question and the author’s cover purpose',
    draft: 'Да для кого, блядь, эта памятка по релизам? Мне нужно указать аудиторию на обложке.',
    check(answer) {
      assert.match(answer, /\?/);
      assert.match(answer, /памятк/iu);
      assert.match(answer, /мне\s+(?:нужно|необходимо|надо)/iu);
      assert.match(answer, /аудитор/iu);
      assert.match(answer, /обложк/iu);
      assert.doesNotMatch(answer, /(?:^|[.!?\n]\s*)(?:укажи|добавь|впиши|напиши|размести|измени|исправь|отредактируй)(?=\s|[.!?,]|$)/iu);
    }
  },
  {
    name: 'a different document question retains its stated purpose',
    draft: 'Кому адресована инструкция по миграции? Мне нужно описать читателей в карточке документа.',
    check(answer) {
      assert.match(answer, /\?/);
      assert.match(answer, /миграци/iu);
      assert.match(answer, /мне\s+(?:нужно|необходимо|надо)/iu);
      assert.match(answer, /карточк/iu);
      assert.doesNotMatch(answer, /(?:^|[.!?\n]\s*)(?:опиши|укажи|добавь|впиши|напиши|размести|измени|исправь|отредактируй)(?=\s|[.!?,]|$)/iu);
    }
  },
  {
    name: 'an explicit request to edit the cover remains an action',
    draft: 'Укажи аудиторию памятки по релизам на обложке.',
    check(answer) {
      assert.match(answer, /^(?:Укажи|Обозначь|Добавь|Напиши)\s/iu);
      assert.match(answer, /аудитор/iu);
      assert.match(answer, /обложк/iu);
      assert.doesNotMatch(answer, /\?/);
    }
  },
  {
    name: 'the author’s standalone rhetorical instruction complaint remains a requirement',
    draft: 'Для кого, блядь, написаны инструкции?',
    check(answer) {
      assert.match(answer, /(?:соблюдай|следуй|руководствуйся)/iu);
      assert.match(answer, /инструкци/iu);
      assert.doesNotMatch(answer, /\?/);
    }
  }
];

for (const scenario of cases) {
  test(scenario.name, { skip: !enabled, timeout: repetitions * 75000 }, async t => {
    for (let attempt = 1; attempt <= repetitions; attempt++) {
      const answer = await preparePrompt(scenario.draft);
      t.diagnostic(`${attempt}/${repetitions}: ${answer}`);
      assert.ok(answer);
      scenario.check(answer);
    }
  });
}
