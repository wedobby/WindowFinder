'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const context = vm.createContext({});
vm.runInContext(extract('function esc(s)', '/* ══════════ modal helpers') +
  extract('function gitChangeState(', 'function gitSelectionEntries(') +
  extract('function vcsChangeGroups(', 'async function statusModal(') +
  '\nglobalThis.api = { vcsChangeGroups, svnCommittable, vcsDiffLines, vcsDiffHtml };', context);
const api = context.api;
const plain = (x) => JSON.parse(JSON.stringify(x));

test('change workspace separates partially staged files and SVN property-only changes', () => {
  const git = plain(api.vcsChangeGroups('git', { '/a': 'MM', '/b': '??', '/c': 'D ', '/d': 'UU' }));
  assert.deepEqual(git.staged.map(([p]) => p), ['/a', '/c']);
  assert.deepEqual(git.unstaged.map(([p]) => p), ['/a', '/b', '/d']);
  const svn = plain(api.vcsChangeGroups('svn', { '/a': ' M', '/b': '? ', '/c': ' C' }));
  assert.deepEqual(svn.changes.map(([p]) => p), ['/a', '/c']);
  assert.deepEqual(svn.untracked.map(([p]) => p), ['/b']);
  assert.equal(api.svnCommittable(' M'), true);
  for (const code of ['? ', '! ', '~ ', 'C ', ' C', 'X ', '  ']) assert.equal(api.svnCommittable(code), false);
});

test('unified diff line numbers handle multiple hunks and newline markers', () => {
  const rows = plain(api.vcsDiffLines('--- a/a\n+++ b/a\n@@ -2,2 +2,3 @@\n old\n-before\n+after\n+new\n\\ No newline at end of file\n@@ -20 +21 @@\n-x\n+y'));
  assert.deepEqual(rows.filter((r) => ['add', 'del', 'context'].includes(r.kind)).map((r) => [r.kind, r.oldLine, r.newLine]), [
    ['context', 2, 2], ['del', 3, ''], ['add', '', 3], ['add', '', 4], ['del', 20, ''], ['add', '', 21],
  ]);
  assert.equal(rows[0].kind, 'meta');
  assert.equal(rows[1].kind, 'meta');
  const property = plain(api.vcsDiffLines('Property changes on: docs\n## -1 +1,2 ##\n *.tmp\n+*.cache'));
  assert.equal(property[1].kind, 'hunk');
  assert.equal(property[3].kind, 'add');
  assert.equal(property[3].newLine, 2);
});

test('diff treats document HTML and event attributes as escaped text', () => {
  const html = api.vcsDiffHtml('@@ -0,0 +1 @@\n+<img src=x onerror="alert(1)"> & <script>bad()</script>');
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;img/);
  assert.match(html, /&amp;/);
  assert.match(html, /class="vcs-diff-line add"/);
});
