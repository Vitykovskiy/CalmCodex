'use strict';
const vscode = require('vscode');
module.exports = async function receive(webview, message) {
  try {
    const addon = vscode.extensions.getExtension('local-calmcodex.calmcodex');
    if (!addon) {
      if (message.kind === 'rewrite') await webview.postMessage({type: 'calmcodex/result', id: message.id, bypass: true});
      return;
    }
    const api = await addon.activate();
    await api.receive(webview, message);
  } catch {
    if (message.kind === 'rewrite') {
      await webview.postMessage({type: 'calmcodex/result', id: message.id, error: 'CalmCodex не запустился. Черновик сохранён.'});
    }
  }
};
