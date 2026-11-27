'use strict';
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { install, remove } = require('../extension/install-adapter.cjs');

test('the adapter installs once and restores the installed Codex version byte for byte', t => {
  const standardCLI = '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
  const cli = fs.existsSync(standardCLI) ? standardCLI : 'code';
  const source = process.env.CALMCODEX_CODEX_EXTENSION ||
    execFileSync(cli, ['--locate-extension', 'openai.chatgpt'], { encoding: 'utf8' }).trim();
  assert.ok(source, 'Install openai.chatgpt or set CALMCODEX_CODEX_EXTENSION.');

  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'calmcodex-adapter-'));
  t.after(() => fs.rmSync(copy, { recursive: true, force: true }));
  const assets = 'webview/assets';
  const inputs = [
    'package.json', 'out/extension.js',
    ...fs.readdirSync(path.join(source, assets))
      .filter(name => /^(app-initial|composer-content)-.*\.js$/.test(name))
      .map(name => path.join(assets, name))
  ];
  for (const name of inputs) {
    const target = path.join(copy, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(source, name), target);
  }
  // A user's installation may already include the adapter. Normalize the copy only.
  remove(copy);
  const hashes = () => inputs.map(name =>
    createHash('sha256').update(fs.readFileSync(path.join(copy, name))).digest('hex'));
  const original = hashes();
  assert.equal(install(copy), true);
  assert.notDeepEqual(hashes(), original);
  assert.equal(install(copy), false);
  remove(copy);
  assert.deepEqual(hashes(), original);
  assert.equal(fs.existsSync(path.join(copy, assets, 'calmcodex-v2.js')), false);
  assert.equal(fs.existsSync(path.join(copy, 'out/calmcodex-v2.cjs')), false);
});
