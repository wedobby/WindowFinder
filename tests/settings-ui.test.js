'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const start = source.indexOf('async function settingsModal()');
const settings = source.slice(start, source.indexOf('async function openWithModal(', start));

test('native settings event preserves an open operation dialog and its cleanup', async () => {
  for (const toolWindow of [false, true]) {
    let replacements = 0, cancellations = 0;
    const notices = [];
    const context = vm.createContext({
      IN_TOOL: toolWindow,
      $: () => ({ classList: { contains: () => false } }),
      toast: (message) => notices.push(message),
      hideMenus() {},
      openModal() { replacements++; context.modalCleanup(); },
      modalCleanup() { cancellations++; },
    });
    vm.runInContext(settings, context);
    await context.settingsModal();
    assert.equal(replacements, 0);
    assert.equal(cancellations, 0);
    assert.equal(notices.length, 1);
    assert.match(notices[0], toolWindow ? /파일 탐색기 창/ : /열린 작업창/);
  }
});
