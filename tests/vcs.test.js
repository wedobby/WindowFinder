'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const exec = require('node:util').promisify(require('node:child_process').execFile);
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8').split('// ---------- mode dispatch ----------')[0];
const context = vm.createContext({ require, __dirname: root, process, console, Buffer, URL, setTimeout, clearTimeout });
vm.runInContext(source + '\nglobalThis.vcs = api.vcs;', context);
async function info(dir) {
  let output;
  await context.vcs({}, { writeHead(code) { assert.equal(code, 200); }, end(body) { output = JSON.parse(body); } }, new URLSearchParams({ path: dir }));
  return output;
}
async function fixture(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'windowfinder-vcs-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}
test('Git 하위 폴더에서도 첫 커밋 전 브랜치와 한글 변경 경로를 표시한다', async (t) => {
  const dir = await fixture(t);
  const git = (args) => exec('git', ['-C', dir, ...args]);
  await git(['init', '-b', 'preview-test']);
  await fsp.mkdir(path.join(dir, 'nested'));
  const name = '한글 -> 이름\n줄.txt'; await fsp.writeFile(path.join(dir, name), 'text');
  const initial = await info(path.join(dir, 'nested'));
  assert.equal(initial.git.branch, 'preview-test'); assert.equal(initial.git.last, '');
  assert.equal(initial.git.statuses[path.join(dir, name)], '??');
  await git(['add', '.']);
  await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', '미리보기 검증']);
  await git(['remote', 'add', 'origin', 'https://example.invalid/test/repository.git']);
  await git(['mv', name, 'renamed.txt']);
  const result = await info(path.join(dir, 'nested'));
  assert.equal(result.git.statuses[path.join(dir, 'renamed.txt')], 'R ');
  assert.equal(Object.keys(result.git.statuses).length, 1);
  assert.match(result.git.last, /미리보기 검증/);
  assert.equal(result.git.remote, 'https://example.invalid/test/repository.git');
});
test('SVN 하위 폴더에서 저장소 주소와 현재 리비전을 반환한다', async (t) => {
  try { await exec('svnadmin', ['--version', '--quiet']); } catch { t.skip('svnadmin 없음'); return; }
  const dir = await fixture(t), repo = path.join(dir, 'repo'), wc = path.join(dir, 'wc');
  await exec('svnadmin', ['create', repo]);
  await exec('svn', ['checkout', 'file://' + repo, wc]);
  await fsp.mkdir(path.join(wc, 'nested')); await fsp.writeFile(path.join(wc, 'nested', 'test.txt'), 'test');
  await exec('svn', ['add', path.join(wc, 'nested')]);
  await exec('svn', ['commit', wc, '-m', '미리보기 검증']);
  await exec('svn', ['update', wc]);
  await fsp.writeFile(path.join(wc, 'nested', 'test.txt'), 'changed');
  const result = await info(path.join(wc, 'nested'));
  assert.equal(result.svn.root, wc); assert.equal(result.svn.rev, '1'); assert.equal(result.svn.last, '1');
  assert.equal(result.svn.url, 'file://' + repo); assert.equal(result.svn.repository, 'file://' + repo);
  assert.equal(result.svn.statuses[path.join(wc, 'nested', 'test.txt')], 'M ');
});
