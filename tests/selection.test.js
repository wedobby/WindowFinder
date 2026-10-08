'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const app = fs.readFileSync(require('node:path').join(__dirname, '../public/app.js'), 'utf8');
function client() {
  let finish;
  const state = { cwd: '/source', selection: new Set(['/source/1', '/source/2']), searchMode: false };
  const context = vm.createContext({ state, listQuery: (path) => ({ path }), render() {}, fetchVcs() {}, toast() {},
    apiGet: () => new Promise((resolve) => { finish = resolve; }) });
  vm.runInContext('let listingToken = 0;\n' + app.slice(app.indexOf('async function refresh()'), app.indexOf('/* ══════════ live folder watch')), context);
  return { state, context, finish: () => finish({ entries: [1, 2, 3, 4, 5].map((n) => ({ path: '/source/' + n })) }) };
}
test('자동 새로고침을 기다리는 동안 추가한 3~5번째 선택을 보존한다', async () => {
  const c = client();
  const pending = c.context.refresh();
  [3, 4, 5].forEach((n) => c.state.selection.add('/source/' + n));
  c.finish(); await pending;
  assert.equal(c.state.selection.size, 5);
});
test('늦게 도착한 이전 폴더 목록은 현재 폴더 선택을 덮어쓰지 않는다', async () => {
  const c = client(); const pending = c.context.refresh();
  c.state.cwd = '/other'; c.state.selection = new Set(['/other/selected']);
  c.finish(); await pending;
  assert.deepEqual([...c.state.selection], ['/other/selected']);
});
