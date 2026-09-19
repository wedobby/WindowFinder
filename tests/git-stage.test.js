'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);

const root = path.join(__dirname, '..');
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8').split('// ---------- mode dispatch ----------')[0];
const context = vm.createContext({
  require, __dirname: root, process: { ...process, env }, console, Buffer, URL,
  setTimeout, clearTimeout, setInterval, clearInterval,
});
vm.runInContext(source + '\nglobalThis.handlers = api;', context);

async function call(name, body, query = {}) {
  const req = new EventEmitter();
  let status, output = '';
  const res = Object.assign(new EventEmitter(), {
    writeHead(code) { status = code; },
    write(data) { output += data; },
    end(data = '') { output += data; },
  });
  const pending = context.handlers[name](req, res, new URLSearchParams(query));
  if (body) {
    req.emit('data', JSON.stringify(body));
    req.emit('end');
  }
  await pending;
  return { status, data: name === 'vcsstream' ? output : JSON.parse(output) };
}

async function fixture(t, seeded = false) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'windowfinder-git-test-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const git = async (...args) => (await execFile('git', ['-C', dir, ...args], { env })).stdout;
  await git('init', '-q');
  await git('config', 'user.name', 'WindowFinder Test');
  await git('config', 'user.email', 'windowfinder-test@example.invalid');
  await git('config', 'commit.gpgsign', 'false');
  await git('config', 'core.hooksPath', '/dev/null');
  const write = async (name, text) => {
    const file = path.join(dir, name);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, text);
    return file;
  };
  if (seeded) {
    await write('a.txt', 'base a');
    await write('b.txt', 'base b');
    await write('nested/deleted.txt', 'base deleted');
    await git('add', '-A');
    await git('commit', '-qm', 'initial');
  }
  const op = async (action, names, extra = {}) => call('vcsop', {
    tool: 'git', action, root: dir, paths: names.map((p) => path.join(dir, p)), ...extra,
  });
  const status = async () => {
    const result = await call('vcs', null, { path: dir });
    assert.equal(result.status, 200);
    assert.ok(result.data.git, 'Git must be detected before the first commit too');
    return result.data.git;
  };
  return { dir, git, write, op, status };
}

test('initial repository stages literal Unicode/special paths and unstages without losing edits', async (t) => {
  const f = await fixture(t);
  const names = ['한글 파일 [1].txt', 'literal*.txt', 'literal-other.txt', 'arrow -> name.txt', 'line\n"quote".txt', 'folder/nested.txt'];
  for (const name of names) await f.write(name, 'original');
  const initial = await f.status();
  assert.deepEqual(Object.keys(initial.statuses).sort(), names.map((p) => path.join(f.dir, p)).sort());
  const selected = names.filter((name) => name !== 'literal-other.txt');
  assert.equal((await f.op('add', selected)).status, 200);
  assert.deepEqual((await f.git('ls-files', '-z')).split('\0').filter(Boolean).sort(), selected.sort());
  await f.write(selected[0], 'edited after staging');
  assert.equal((await f.op('unstage', selected)).status, 200);
  assert.equal(await f.git('ls-files'), '');
  assert.equal(await fsp.readFile(path.join(f.dir, selected[0]), 'utf8'), 'edited after staging');
  for (const code of Object.values((await f.status()).statuses)) assert.equal(code, '??');
});

test('staged-only streamed commit preserves later edits and excludes unstaged/untracked files', async (t) => {
  const f = await fixture(t, true);
  await f.write('a.txt', 'staged version');
  await f.write('b.txt', 'unstaged version');
  await f.write('new.txt', 'untracked');
  await fsp.unlink(path.join(f.dir, 'nested/deleted.txt'));
  assert.equal((await f.op('add', ['a.txt', 'nested/deleted.txt'])).status, 200);
  await f.write('a.txt', 'later worktree edit');
  assert.equal((await f.status()).statuses[path.join(f.dir, 'a.txt')], 'MM');
  assert.equal((await f.op('unstage', ['nested/deleted.txt'])).status, 200);
  assert.equal((await f.status()).statuses[path.join(f.dir, 'nested/deleted.txt')], ' D');
  assert.equal(fs.existsSync(path.join(f.dir, 'nested/deleted.txt')), false);
  assert.equal((await f.op('add', ['nested/deleted.txt'])).status, 200);
  const result = await call('vcsstream', { tool: 'git', action: 'commit', root: f.dir, message: 'selected only' });
  assert.equal(result.status, 200);
  assert.match(result.data, /__DONE__:0/);
  assert.equal(await f.git('show', 'HEAD:a.txt'), 'staged version');
  assert.equal(await f.git('show', 'HEAD:b.txt'), 'base b');
  assert.equal(await fsp.readFile(path.join(f.dir, 'a.txt'), 'utf8'), 'later worktree edit');
  const remaining = (await f.status()).statuses;
  assert.equal(remaining[path.join(f.dir, 'a.txt')], ' M');
  assert.equal(remaining[path.join(f.dir, 'b.txt')], ' M');
  assert.equal(remaining[path.join(f.dir, 'new.txt')], '??');
  assert.equal(remaining[path.join(f.dir, 'nested/deleted.txt')], undefined);
});

test('unstaging a rename restores both index paths while retaining the renamed working file', async (t) => {
  const f = await fixture(t, true);
  const renamed = '새 이름 -> "file".txt';
  await f.git('mv', 'a.txt', renamed);
  await f.write('b.txt', 'staged b');
  await f.op('add', ['b.txt']);
  const before = await f.status();
  assert.equal(before.statuses[path.join(f.dir, renamed)], 'R ');
  assert.equal(before.originalPaths[path.join(f.dir, renamed)], path.join(f.dir, 'a.txt'));
  assert.equal((await f.op('unstage', [renamed])).status, 200);
  assert.equal((await f.git('diff', '--cached', '--name-only')).trim(), 'b.txt');
  assert.equal(await fsp.readFile(path.join(f.dir, renamed), 'utf8'), 'base a');
  assert.equal(fs.existsSync(path.join(f.dir, 'a.txt')), false);
  const after = await f.status();
  assert.equal(after.statuses[path.join(f.dir, 'a.txt')], ' D');
  assert.equal(after.statuses[path.join(f.dir, renamed)], '??');
});

test('folder stage/unstage includes deleted and new children and rejects paths outside the repo', async (t) => {
  const f = await fixture(t, true);
  await fsp.unlink(path.join(f.dir, 'nested/deleted.txt'));
  await f.write('nested/new.txt', 'new');
  await f.write('a.txt', 'separate edit');
  assert.equal((await f.op('add', ['nested'])).status, 200);
  assert.equal((await f.status()).statuses[path.join(f.dir, 'nested/deleted.txt')], 'D ');
  assert.equal((await f.op('unstage', ['nested'])).status, 200);
  assert.equal(await f.git('diff', '--cached'), '');
  assert.equal(await fsp.readFile(path.join(f.dir, 'nested/new.txt'), 'utf8'), 'new');
  assert.equal((await f.op('add', ['../outside'])).status, 500);
  assert.equal(await f.git('diff', '--cached'), '');
});

test('regular commit API commits only the index, including the first commit', async (t) => {
  const f = await fixture(t);
  await f.write('chosen.txt', 'yes');
  await f.write('left.txt', 'no');
  await f.op('add', ['chosen.txt']);
  assert.equal((await f.op('commit', [], { message: '' })).status, 400);
  assert.equal((await f.op('commit', [], { message: 'first' })).status, 200);
  assert.equal((await f.git('ls-tree', '--name-only', 'HEAD')).trim(), 'chosen.txt');
  assert.equal((await f.status()).statuses[path.join(f.dir, 'left.txt')], '??');
});

test('UI separates index/worktree changes and includes changed descendants in folder selection', () => {
  const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
  const state = { vcs: { git: { statuses: {
    '/repo/both.txt': 'MM', '/repo/new.txt': '??', '/repo/folder/deleted.txt': 'D ',
    '/repo/folder2/other.txt': ' M',
  } } } };
  const ui = vm.createContext({ state });
  vm.runInContext(app.slice(app.indexOf('function gitChangeState('), app.indexOf('function vcsLetter(')), ui);
  for (const [code, staged, unstaged, conflict] of [
    ['M ', true, false, false], [' M', false, true, false], ['MM', true, true, false],
    ['AM', true, true, false], ['AD', true, true, false], ['R ', true, false, false],
    ['D ', true, false, false], ['??', false, true, false], ['!!', false, false, false],
    ['UU', false, true, true], ['AA', false, true, true], ['DD', false, true, true],
  ]) {
    assert.deepEqual({ ...ui.gitChangeState(code) }, { staged, unstaged, conflict }, code);
  }
  const entries = [
    { path: '/repo/both.txt', isDir: false }, { path: '/repo/new.txt', isDir: false },
    { path: '/repo/folder', isDir: true },
  ];
  assert.deepEqual(Array.from(ui.gitSelectionEntries('staged', entries), (e) => e.path), ['/repo/both.txt', '/repo/folder']);
  assert.deepEqual(Array.from(ui.gitSelectionEntries('unstaged', entries), (e) => e.path), ['/repo/both.txt', '/repo/new.txt']);
});
