'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const open = '/*<calmcodex:2>*/', close = '/*</calmcodex:2>*/';
const marked = value => open + value + close;
function original(text) {
  const chunks = text.split(open);
  return chunks[0] + chunks.slice(1).map(chunk => {
    const i = chunk.indexOf(close);
    if (i < 0) throw new Error('Незавершённый фрагмент CalmCodex.');
    return chunk.slice(i + close.length);
  }).join('');
}
function only(matches, purpose) {
  if (matches.length !== 1) throw new Error('Несовместимая версия расширения Codex ('+purpose+').');
  return matches[0];
}
function read(file) { return fs.readFileSync(file, 'utf8'); }
function atomic(file, next) {
  const temp = file + '.calm-' + crypto.randomUUID();
  try {
    fs.writeFileSync(temp, next, { mode: fs.existsSync(file) ? fs.statSync(file).mode : 0o644 });
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}
function inspect(root) {
  const meta = JSON.parse(read(path.join(root,'package.json')));
  if (meta.publisher !== 'openai' || meta.name !== 'chatgpt') throw new Error('Требуется расширение openai.chatgpt.');
  const host = path.join(root, meta.main), assets = path.join(root,'webview','assets');
  const paths = fs.readdirSync(assets);
  const composers = paths.filter(n => /^composer-content-.*\.js$/.test(n))
    .map(name=>({ name, source:original(read(path.join(assets,name))) }))
    .filter(x=>x.source.includes('getMentionedComputerUseApps') && x.source.includes('confirmedGoalReplacementDraft'));
  const composer = only(composers,'поле сообщения');
  const apis = [];
  for (const name of paths.filter(n => /^app-initial-.*\.js$/.test(n))) {
    const s = read(path.join(assets,name));
    const local = s.match(/\b([\w$]+)=acquireVsCodeApi\(\)/)?.[1];
    if (!local) continue;
    const exports = s.slice(s.lastIndexOf('export{'));
    const exposed = exports.split(/[,{}]/).find(v=>v.startsWith(local+' as '));
    if (exposed) apis.push({name, exported:exposed.split(' as ')[1]});
  }
  const api = only(apis,'канал VS Code');
  const bind = only([...composer.source.matchAll(/\{hasText:[\w$]+,hasSendableText:[\w$]+\}=[\w$]+\(([\w$]+)\)/g)],'редактор');
  const begin = only([...composer.source.matchAll(/let\{followUpSubmitAction:[\w$]+=[\w$]+,confirmedGoalReplacementDraft:/g)],'отправка');
  const headerAt = composer.source.lastIndexOf('async function ',begin.index);
  const header = composer.source.slice(headerAt,begin.index).split('}){')[0];
  const controller = header.match(/\bcomposerController:([\w$]+)/)?.[1];
  const opts = header.match(/\boptions:([\w$]+)=\{\}/)?.[1];
  const current = header.match(/\bisCurrentSubmission:([\w$]+)/)?.[1];
  if (!controller || !opts || !current) throw new Error('Не удалось определить обработчик отправки Codex.');
  const preamble = '\nimport { bind as ccBind, prepare as ccPrepare, connect as ccConnect } from "./calmcodex-v2.js";'
    +'\nimport { '+api.exported+' as ccApi } from "./'+api.name+'";\nccConnect(message=>ccApi.postMessage(message));\n';
  const edits = [
    [0, marked(preamble)],
    [bind.index+bind[0].length-1-bind[1].length,marked('ccBind(')],
    [bind.index+bind[0].length-1,marked(')')],
    [begin.index,marked(opts+'=await ccPrepare('+controller+','+opts+',()=>'+current+'?.()!==false);if('+opts+'===null)return;')]
  ];
  let ui = composer.source;
  for (const [at,insertion] of edits.sort((a,b)=>b[0]-a[0])) ui=ui.slice(0,at)+insertion+ui.slice(at);
  const hostSource = original(read(host));
  const entry = only([...hostSource.matchAll(/\.workerBusMessageHandler\.registerWebview\(([\w$]+)\);let [\w$]+=\1\.onDidReceiveMessage\(([\w$]+)=>\{/g)],'сообщения панели');
  const [, view, msg] = entry;
  const at = entry.index+entry[0].length;
  const handler = 'if('+msg+'?.type==="calmcodex/request"){void require("./calmcodex-v2.cjs")('+view+','+msg+');return;}';
  return {host, assets, uiFile:path.join(assets,composer.name), ui, hostCode:hostSource.slice(0,at)+marked(handler)+hostSource.slice(at)};
}
function install(root, here=__dirname) {
  const s = inspect(root);
  const changes = [
    [path.join(s.assets,'calmcodex-v2.js'),read(path.join(here,'composer.mjs'))],
    [path.join(path.dirname(s.host),'calmcodex-v2.cjs'),read(path.join(here,'host.cjs'))],
    [s.host,s.hostCode], [s.uiFile,s.ui]
  ].filter(([file, value])=>!fs.existsSync(file) || read(file)!==value);
  const applied = [];
  try {
    for (const [file,value] of changes) {
      const before=fs.existsSync(file)?read(file):undefined;
      atomic(file,value);
      applied.push([file,before]);
    }
  } catch (e) {
    for (const [file,old] of applied.reverse()) { if(old===undefined) fs.rmSync(file,{force:true}); else atomic(file,old); }
    throw e;
  }
  return changes.length > 0;
}
function remove(root) {
  const assets=path.join(root,'webview','assets'), out=path.join(root,'out');
  for (const file of [path.join(out,'extension.js'), ...fs.readdirSync(assets).filter(n=>/^composer-content-.*\.js$/.test(n)).map(n=>path.join(assets,n))]) {
    const before=read(file); if(before.includes(open)) atomic(file,original(before));
  }
  for(const file of [path.join(assets,'calmcodex-v2.js'),path.join(out,'calmcodex-v2.cjs')])fs.rmSync(file,{force:true});
}
module.exports = { install, remove };
if (require.main===module) {
  const [mode,root] = process.argv.slice(2);
  if (!root || !['install','remove'].includes(mode)) process.exit(2);
  if(mode==='remove') remove(root); else console.log(install(root)?'CalmCodex подключён.':'CalmCodex уже подключён.');
}
