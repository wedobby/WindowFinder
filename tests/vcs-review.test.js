'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { promisify } = require('node:util');
const childProcess = require('node:child_process');
const execFile = promisify(childProcess.execFile);

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8').split('// ---------- mode dispatch ----------')[0];
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const limit = 256 * 1024;

function server(overrides = {}) {
  const context = vm.createContext({
    require(name) { return name === 'child_process' ? { ...childProcess, ...overrides } : require(name); },
    __dirname: root, process: { ...process, env }, console, Buffer, URL,
    setTimeout, clearTimeout, setInterval, clearInterval,
  });
  vm.runInContext(source + '\nglobalThis.review = { api, parseSvnStatus };', context);
  return {
    parse: context.review.parseSvnStatus,
    async call(name, body, query = {}) {
      const req = new EventEmitter();
      let status, output = '';
      const res = Object.assign(new EventEmitter(), {
        writeHead(code) { status = code; },
        write(data) { output += data; },
        end(data = '') { output += data; this.writableEnded = true; },
      });
      const pending = context.review.api[name](req, res, new URLSearchParams(query));
      if (body) { req.emit('data', JSON.stringify(body)); req.emit('end'); }
      await pending;
      return { status, data: name === 'vcsstream' && status === 200 ? output : JSON.parse(output) };
    },
  };
}

async function temporary(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'windowfinder-vcs-review-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function gitFixture(t, seeded = true) {
  const dir = await temporary(t);
  const git = async (...args) => (await execFile('git', ['-C', dir, ...args], { env })).stdout;
  await git('init', '-q');
  await git('config', 'user.name', 'WindowFinder Test');
  await git('config', 'user.email', 'windowfinder-test@example.invalid');
  await git('config', 'commit.gpgsign', 'false');
  await git('config', 'core.hooksPath', '/dev/null');
  const write = async (name, data) => {
    const p = path.join(dir, name);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, data);
    return p;
  };
  if (seeded) {
    await write('a*.txt', 'base\n');
    await write('abc.txt', 'other base\n');
    await git('add', '-A');
    await git('commit', '-qm', 'initial');
  }
  const app = server();
  const diff = (name, staged = false) => app.call('vcsdiff', null, {
    tool: 'git', root: dir, path: path.join(dir, name), ...(staged ? { staged: '1' } : {}),
  });
  return { dir, git, write, app, diff };
}

test('Git diff separates staged content from later worktree edits and treats names literally', async (t) => {
  const f = await gitFixture(t);
  await f.write('a*.txt', 'staged value\n');
  await f.git('--literal-pathspecs', 'add', '--', 'a*.txt');
  await f.write('a*.txt', 'later edit\n');
  await f.write('abc.txt', 'must not appear\n');
  const staged = await f.diff('a*.txt', true), worktree = await f.diff('a*.txt');
  assert.equal(staged.status, 200);
  assert.match(staged.data.diff, /-base\n\+staged value/);
  assert.doesNotMatch(staged.data.diff, /later edit|must not appear/);
  assert.match(worktree.data.diff, /-staged value\n\+later edit/);
  assert.doesNotMatch(worktree.data.diff, /must not appear/);
  assert.equal(worktree.data.binary, false);
  assert.equal(worktree.data.untracked, false);
  assert.equal(worktree.data.truncated, false);
});

test('Git diff previews untracked, deleted, and initial staged files without modifying the index', async (t) => {
  const f = await gitFixture(t, false);
  const name = '한글 [1] @ "line\nfile.txt';
  await f.write(name, 'new file\nsecond line');
  const untracked = await f.diff(name);
  assert.equal(untracked.status, 200);
  assert.equal(untracked.data.untracked, true);
  assert.match(untracked.data.diff, /\+new file\n\+second line\n\\ No newline/);
  assert.equal(await f.git('ls-files'), '');
  assert.equal((await f.diff(name, true)).data.diff, '');
  await f.git('add', '-A');
  assert.match((await f.diff(name, true)).data.diff, /\+new file/);
  await f.git('commit', '-qm', 'initial');
  await fsp.unlink(path.join(f.dir, name));
  assert.match((await f.diff(name)).data.diff, /-new file/);
});

test('Git diff bounds large patches and signals binary and large untracked files', async (t) => {
  const f = await gitFixture(t);
  await f.write('binary.dat', Buffer.from([1, 0, 2, 3]));
  const binary = await f.diff('binary.dat');
  assert.equal(binary.data.binary, true);
  assert.equal(binary.data.untracked, true);
  await f.git('add', 'binary.dat');
  assert.equal((await f.diff('binary.dat', true)).data.binary, true);
  await f.write('large.txt', '큰 파일의 내용\n'.repeat(40000));
  const large = await f.diff('large.txt');
  assert.equal(large.data.truncated, true);
  assert.ok(Buffer.byteLength(large.data.diff) <= limit);
  assert.ok(!large.data.diff.endsWith('\ufffd'));
  await f.git('add', 'large.txt');
  const staged = await f.diff('large.txt', true);
  assert.equal(staged.data.truncated, true);
  assert.ok(Buffer.byteLength(staged.data.diff) <= limit);
});

test('Diff rejects paths outside the repository including symlinked parent directories', async (t) => {
  const f = await gitFixture(t);
  const outside = await temporary(t);
  await fsp.writeFile(path.join(outside, 'secret.txt'), 'not a repository file');
  await fsp.symlink(outside, path.join(f.dir, 'outside'));
  const direct = await f.app.call('vcsdiff', null, { tool: 'git', root: f.dir, path: path.join(outside, 'secret.txt') });
  assert.equal(direct.status, 400);
  assert.equal((await f.diff('outside/secret.txt')).status, 400);
  // A versioned symlink itself is legitimate and must not follow its target.
  const link = await f.diff('outside');
  assert.equal(link.status, 200);
  assert.equal(link.data.untracked, true);
  assert.doesNotMatch(link.data.diff, /not a repository file/);
});

test('Git discard restores only a literal selected path', async (t) => {
  const f = await gitFixture(t);
  await f.write('a*.txt', 'discard this\n');
  await f.write('abc.txt', 'keep this\n');
  const result = await f.app.call('vcsop', { tool: 'git', action: 'discard', root: f.dir, paths: [path.join(f.dir, 'a*.txt')] });
  assert.equal(result.status, 200);
  assert.equal(await fsp.readFile(path.join(f.dir, 'a*.txt'), 'utf8'), 'base\n');
  assert.equal(await fsp.readFile(path.join(f.dir, 'abc.txt'), 'utf8'), 'keep this\n');
});

test('Git diff never runs configured external diff commands', async (t) => {
  const f = await gitFixture(t);
  await f.git('config', 'diff.external', 'false');
  await f.write('a*.txt', 'modified\n');
  const result = await f.diff('a*.txt');
  assert.equal(result.status, 200);
  assert.match(result.data.diff, /\+modified/);
});

test('Git status and staged diff leave the index untouched when stat-cache refresh is possible', async (t) => {
  const f = await gitFixture(t);
  const index = path.join(f.dir, '.git/index');
  const before = await fsp.readFile(index);
  const future = new Date(Date.now() + 60000);
  await fsp.utimes(path.join(f.dir, 'abc.txt'), future, future);
  const status = await f.app.call('vcs', null, { path: f.dir });
  assert.equal(status.status, 200);
  assert.deepEqual(status.data.git.statuses, {});
  assert.deepEqual(await fsp.readFile(index), before, 'status must not refresh or lock the index');
  await fsp.utimes(path.join(f.dir, 'a*.txt'), future, future);
  assert.equal((await f.diff('abc.txt', true)).status, 200);
  assert.deepEqual(await fsp.readFile(index), before, 'staged diff rename detection must not refresh or lock the index');
});

test('staged Git rename diff includes both related names and preserves mode information', async (t) => {
  const f = await gitFixture(t);
  await f.git('mv', 'abc.txt', 'renamed.txt');
  await fsp.chmod(path.join(f.dir, 'renamed.txt'), 0o755);
  await f.git('add', 'renamed.txt');
  await f.write('a*.txt', 'unrelated staged content\n');
  await f.git('--literal-pathspecs', 'add', 'a*.txt');
  const result = await f.diff('renamed.txt', true);
  assert.equal(result.status, 200);
  assert.match(result.data.diff, /rename from abc.txt\nrename to renamed.txt/);
  assert.match(result.data.diff, /old mode 100644\nnew mode 100755/);
  assert.doesNotMatch(result.data.diff, /unrelated staged content/);
});

test('Git commit token detects external restaging with identical XY status before either commit API', async (t) => {
  const f = await gitFixture(t);
  await f.write('abc.txt', 'first staged content\n');
  await f.git('add', 'abc.txt');
  const before = (await f.app.call('vcs', null, { path: f.dir })).data.git;
  assert.match(before.commitToken, /^[0-9a-f]{64}$/);
  await f.write('abc.txt', 'later unstaged content\n');
  assert.equal((await f.app.call('vcs', null, { path: f.dir })).data.git.commitToken, before.commitToken);
  await f.git('add', 'abc.txt');
  const after = (await f.app.call('vcs', null, { path: f.dir })).data.git;
  assert.equal(before.statuses[path.join(f.dir, 'abc.txt')], after.statuses[path.join(f.dir, 'abc.txt')]);
  assert.notEqual(after.commitToken, before.commitToken);
  const head = (await f.git('rev-parse', 'HEAD')).trim();
  for (const name of ['vcsop', 'vcsstream']) {
    const refused = await f.app.call(name, { tool: 'git', action: 'commit', root: f.dir, message: 'stale selection', expectedToken: before.commitToken });
    assert.equal(refused.status, 409);
    assert.equal((await f.git('rev-parse', 'HEAD')).trim(), head);
  }
  const accepted = await f.app.call('vcsstream', { tool: 'git', action: 'commit', root: f.dir, message: 'reviewed selection', expectedToken: after.commitToken });
  assert.match(accepted.data, /__DONE__:0/);
  assert.equal(await f.git('show', 'HEAD:abc.txt'), 'later unstaged content\n');
});

test('Git commit token detects branch changes even with the same HEAD and staged blobs', async (t) => {
  const f = await gitFixture(t);
  await f.write('abc.txt', 'staged content\n');
  await f.git('add', 'abc.txt');
  const before = (await f.app.call('vcs', null, { path: f.dir })).data.git;
  await f.git('checkout', '-qb', 'different-branch');
  const after = (await f.app.call('vcs', null, { path: f.dir })).data.git;
  assert.notEqual(after.commitToken, before.commitToken);
  assert.deepEqual(after.statuses, before.statuses);
  const refused = await f.app.call('vcsstream', { tool: 'git', action: 'commit', root: f.dir, message: 'wrong branch', expectedToken: before.commitToken });
  assert.equal(refused.status, 409);
  assert.equal((await f.git('log', '-1', '--format=%s')).trim(), 'initial');
  const accepted = await f.app.call('vcsop', { tool: 'git', action: 'commit', root: f.dir, message: 'new branch confirmed', expectedToken: after.commitToken });
  assert.equal(accepted.status, 200);
});

const escapeXml = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/\n/g, '&#10;');
const statusEntry = (name, item, props = 'none', extra = '', content = '') =>
  `<entry path="${escapeXml(name)}"><wc-status item="${item}" props="${props}" ${extra}>${content}</wc-status></entry>`;
const lock = (token) => `<lock><token>${token}</token></lock>`;

test('SVN XML preserves property, tree conflict, missing, untracked, Unicode and lock statuses', () => {
  const entries = [
    statusEntry('props.txt', 'normal', 'modified'), statusEntry('prop-conflict.txt', 'normal', 'conflicted'),
    statusEntry('tree.txt', 'normal', 'none', 'tree-conflicted="true"'), statusEntry('missing.txt', 'missing'),
    statusEntry('unknown.txt', 'unversioned'), statusEntry('blocked.txt', 'obstructed'),
    statusEntry('한글 & "\n@.txt', 'modified'), statusEntry('locked.txt', 'normal', 'normal', '', lock('mine')),
    `<entry path="other.txt"><wc-status item="normal" props="none"/><repos-status item="none" props="none">${lock('other')}</repos-status></entry>`,
    `<entry path="stolen.txt"><wc-status item="normal" props="none">${lock('mine')}</wc-status><repos-status item="none" props="none">${lock('other')}</repos-status></entry>`,
    `<entry path="broken.txt"><wc-status item="normal" props="none">${lock('mine')}</wc-status><repos-status item="none" props="none"/></entry>`,
  ];
  const result = JSON.parse(JSON.stringify(server().parse(`<status><target path=".">${entries.join('')}</target></status>`, '/wc')));
  assert.deepEqual(result.statuses, {
    '/wc/props.txt': ' M', '/wc/prop-conflict.txt': ' C', '/wc/tree.txt': 'C ', '/wc/missing.txt': '! ',
    '/wc/unknown.txt': '? ', '/wc/blocked.txt': '~ ', '/wc/한글 & "\n@.txt': 'M ',
  });
  assert.deepEqual(result.locks, { '/wc/locked.txt': 'K', '/wc/other.txt': 'O', '/wc/stolen.txt': 'T', '/wc/broken.txt': 'B' });
});

async function svnMock(t, entries) {
  const dir = await temporary(t);
  await fsp.mkdir(path.join(dir, '.svn'));
  const calls = [];
  const app = server({
    execFile(cmd, args, opts, callback) {
      assert.equal(cmd, 'svn');
      calls.push({ kind: 'exec', args: Array.from(args) });
      callback(null, args[0] === 'info' ? 'file:///test/repository\n' : `<status><target path=".">${entries.join('')}</target></status>`, '');
    },
    spawn(cmd, args) {
      assert.equal(cmd, 'svn');
      calls.push({ kind: 'spawn', args: Array.from(args) });
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
      process.nextTick(() => { child.stdout.end('Index: selected\n+working change\n'); child.emit('close', 0); });
      return child;
    },
  });
  return { dir, calls, app };
}

test('SVN diff uses a literal peg-escaped target and XML status detects untracked files', async (t) => {
  const f = await svnMock(t, [statusEntry('a@name.txt', 'modified')]);
  await fsp.writeFile(path.join(f.dir, 'a@name.txt'), 'new');
  const result = await f.app.call('vcsdiff', null, { tool: 'svn', root: f.dir, path: path.join(f.dir, 'a@name.txt') });
  assert.equal(result.status, 200);
  assert.deepEqual(f.calls.find((c) => c.kind === 'spawn').args.slice(-4), ['--depth', 'empty', '--', path.join(f.dir, 'a@name.txt') + '@']);
  const untracked = await svnMock(t, [statusEntry('new@file.txt', 'unversioned')]);
  await fsp.writeFile(path.join(untracked.dir, 'new@file.txt'), 'untracked content\n');
  const preview = await untracked.app.call('vcsdiff', null, { tool: 'svn', root: untracked.dir, path: path.join(untracked.dir, 'new@file.txt') });
  assert.equal(preview.status, 200);
  assert.equal(preview.data.untracked, true);
  assert.match(preview.data.diff, /\+untracked content/);
  assert.equal(untracked.calls.filter((c) => c.kind === 'spawn').length, 0);
});

test('SVN selected commit is depth empty and rejects empty, outside and omitted added-parent selections', async (t) => {
  const f = await svnMock(t, [statusEntry('folder', 'normal', 'modified'), statusEntry('folder/a@file.txt', 'modified')]);
  await fsp.mkdir(path.join(f.dir, 'folder'));
  const body = { tool: 'svn', action: 'commit', root: f.dir, message: 'selected' };
  const selected = [path.join(f.dir, 'folder'), path.join(f.dir, 'folder/a@file.txt')];
  const result = await f.app.call('vcsstream', { ...body, paths: selected });
  assert.equal(result.status, 200);
  assert.match(result.data, /__DONE__:0/);
  assert.deepEqual(f.calls.find((c) => c.kind === 'spawn').args, ['commit', '-m', 'selected', '--depth', 'empty', '--', ...selected.map((p) => p + '@')]);
  for (const paths of [[], [path.dirname(f.dir)], ['relative.txt'], 'not-an-array', [null]]) {
    assert.equal((await f.app.call('vcsstream', { ...body, paths })).status, 400);
  }
  assert.equal(f.calls.filter((c) => c.kind === 'spawn').length, 1);
  assert.equal((await f.app.call('vcsstream', body)).status, 200);
  assert.deepEqual(f.calls.filter((c) => c.kind === 'spawn').at(-1).args, ['commit', '-m', 'selected']);
  const added = await svnMock(t, [statusEntry('newdir', 'added'), statusEntry('newdir/file.txt', 'added')]);
  await fsp.mkdir(path.join(added.dir, 'newdir'));
  const rejected = await added.app.call('vcsstream', { ...body, root: added.dir, paths: [path.join(added.dir, 'newdir/file.txt')] });
  assert.equal(rejected.status, 400);
  assert.match(rejected.data.error, /상위 폴더/);
});

const hasSvn = ['svn', 'svnadmin'].every((cmd) => childProcess.spawnSync(cmd, ['--version', '--quiet'], { env }).status === 0);
test('real SVN working copy keeps unselected children out of a selected property commit', { skip: !hasSvn && 'svn and svnadmin are not installed' }, async (t) => {
  const dir = await temporary(t), repo = path.join(dir, 'repo'), wc = path.join(dir, 'wc');
  await execFile('svnadmin', ['create', repo], { env });
  await execFile('svn', ['checkout', 'file://' + repo, wc], { env });
  const svn = async (...args) => (await execFile('svn', args, { cwd: wc, env })).stdout;
  await fsp.mkdir(path.join(wc, 'folder'));
  await fsp.writeFile(path.join(wc, 'folder/a@name.txt'), 'base\n');
  await svn('add', 'folder');
  await svn('commit', '-m', 'initial');
  await svn('propset', 'review', 'changed', 'folder');
  await fsp.writeFile(path.join(wc, 'folder/a@name.txt'), 'left uncommitted\n');
  const app = server();
  const before = await app.call('vcs', null, { path: wc });
  assert.equal(before.data.svn.statuses[path.join(wc, 'folder')], ' M');
  assert.equal(before.data.svn.statuses[path.join(wc, 'folder/a@name.txt')], 'M ');
  const diff = await app.call('vcsdiff', null, { tool: 'svn', root: wc, path: path.join(wc, 'folder/a@name.txt') });
  assert.match(diff.data.diff, /\+left uncommitted/);
  const commit = await app.call('vcsstream', { tool: 'svn', action: 'commit', root: wc, paths: [path.join(wc, 'folder')], message: 'only directory property' });
  assert.match(commit.data, /__DONE__:0/);
  assert.equal(await svn('cat', '-r', 'HEAD', path.join(wc, 'folder/a@name.txt') + '@'), 'base\n');
  const after = await app.call('vcs', null, { path: wc });
  assert.equal(after.data.svn.statuses[path.join(wc, 'folder')], undefined);
  assert.equal(after.data.svn.statuses[path.join(wc, 'folder/a@name.txt')], 'M ');
});
