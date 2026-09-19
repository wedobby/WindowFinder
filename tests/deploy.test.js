'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);

// Exercise the real deployment script against a temporary local bare origin.
// Build/compiler work and every GitHub call are mocked; no network is used.
const supported = process.platform === 'darwin';
const script = path.join(__dirname, '..', 'deploy.sh');
const initialFeed = '{ "version": "1.0.0", "zip": "previous.zip" }\n';

async function fixture(t, inheritedEnv = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'windowfinder-deploy-test-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const dir = path.join(base, 'work'), remote = path.join(base, 'origin.git'), bin = path.join(base, 'bin');
  const zshConfig = path.join(base, 'zsh-config');
  await Promise.all([fs.mkdir(dir), fs.mkdir(bin), fs.mkdir(zshConfig)]);
  const log = path.join(base, 'calls.ndjson');
  const env = {
    ...process.env, ...inheritedEnv,
    PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    // Personal .zshenv can prepend a real gh before the fixture's mock PATH.
    // The empty ZDOTDIR is inherited by build.sh/ditto shell subprocesses too.
    ZDOTDIR: zshConfig,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    WF_DEPLOY_TEST_LOG: log, WF_DEPLOY_TEST_FAIL: '',
  };
  const git = async (...args) => (await execFile('/usr/bin/git', args, { cwd: dir, env })).stdout.trim();
  const writeExecutable = async (file, text) => { await fs.writeFile(file, text); await fs.chmod(file, 0o755); };
  await execFile('/usr/bin/git', ['init', '--bare', '-q', remote], { env });
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.name', 'WindowFinder deployment test');
  await git('config', 'user.email', 'deployment-test@example.invalid');
  await git('config', 'commit.gpgsign', 'false');
  await git('config', 'tag.gpgsign', 'false');
  await git('remote', 'add', 'origin', remote);
  await fs.copyFile(script, path.join(dir, 'deploy.sh'));
  await fs.chmod(path.join(dir, 'deploy.sh'), 0o755);
  await Promise.all([
    fs.writeFile(path.join(dir, '.gitignore'), 'dist/\n'),
    fs.writeFile(path.join(dir, 'VERSION'), '1.0.0\n'),
    fs.writeFile(path.join(dir, 'latest.json'), initialFeed),
    fs.writeFile(path.join(dir, 'source.js'), 'const feature = "committed feature";\n'),
  ]);
  await writeExecutable(path.join(dir, 'build.sh'), `#!/bin/zsh
set -e
echo '{"command":"build"}' >> "$WF_DEPLOY_TEST_LOG"
[ "$WF_DEPLOY_TEST_FAIL" != build ] || exit 23
mkdir -p dist/WindowFinder.app
cp source.js VERSION dist/WindowFinder.app/
git rev-parse HEAD > dist/WindowFinder.app/build-commit
if [ "$WF_DEPLOY_TEST_FAIL" = mutate ]; then echo "changed during build" >> source.js; fi
`);
  await writeExecutable(path.join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.WF_DEPLOY_TEST_LOG, JSON.stringify({command:'gh',args})+'\\n');
if (args[0] === 'auth') process.exit(process.env.WF_DEPLOY_TEST_FAIL === 'auth' ? 11 : 0);
if (args[0] === 'release' && args[1] === 'create') {
  if (!args.includes('--verify-tag')) process.exit(13);
  if (!fs.existsSync(args[3])) process.exit(14);
  process.exit(process.env.WF_DEPLOY_TEST_FAIL === 'upload' ? 12 : 0);
}
process.exit(15);
`);
  await writeExecutable(path.join(bin, 'ditto'), `#!/bin/zsh
echo '{"command":"archive"}' >> "$WF_DEPLOY_TEST_LOG"
[ "$WF_DEPLOY_TEST_FAIL" != archive ] || exit 24
exec /usr/bin/ditto "$@"
`);
  // Their existence is checked before the build; the fixture never runs them.
  for (const name of ['npx', 'swiftc', 'clang', 'codesign', 'curl', 'tar']) {
    await writeExecutable(path.join(bin, name), '#!/bin/zsh\nexit 99\n');
  }
  await git('add', '.');
  await git('commit', '-qm', 'initial committed source');
  await git('push', '-q', 'origin', 'main');
  const initialCommit = await git('rev-parse', 'HEAD');
  const deploy = async (args = [], failure = '') => {
    try {
      const result = await execFile('/bin/zsh', ['-f', './deploy.sh', ...args], {
        cwd: dir, env: { ...env, WF_DEPLOY_TEST_FAIL: failure }, timeout: 20000,
      });
      return { code: 0, ...result };
    } catch (e) { return { code: e.code, stdout: e.stdout, stderr: e.stderr }; }
  };
  const calls = async () => {
    try { return (await fs.readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  };
  const remoteFeed = () => git('--git-dir', remote, 'show', 'main:latest.json');
  return { base, dir, remote, bin, env, git, deploy, calls, initialCommit, remoteFeed };
}

test('deployment fixtures keep mock gh ahead of installed tools and isolate personal zsh startup files', { skip: !supported }, async (t) => {
  const personal = await fs.mkdtemp(path.join(os.tmpdir(), 'windowfinder-personal-shell-test-'));
  t.after(() => fs.rm(personal, { recursive: true, force: true }));
  const startupMarker = path.join(personal, 'startup-loaded');
  const competitor = path.join(personal, 'bin');
  await fs.mkdir(competitor);
  await fs.writeFile(path.join(competitor, 'gh'), '#!/bin/sh\nexit 97\n', { mode: 0o755 });
  await fs.writeFile(path.join(personal, '.zshenv'),
    `print -r -- loaded > '${startupMarker}'\nexport PATH='${competitor}':$PATH\n`);
  const f = await fixture(t, { ZDOTDIR: personal, PATH: `${competitor}:${process.env.PATH || ''}` });
  // No -f here: descendants with plain #!/bin/zsh must be isolated as well.
  const resolved = await execFile('/bin/zsh', ['-c', 'command -v gh'], { env: f.env });
  assert.equal(resolved.stdout.trim(), path.join(f.bin, 'gh'));
  const result = await f.deploy();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual((await f.calls()).map((call) => call.command), ['gh', 'build', 'archive', 'gh']);
  await assert.rejects(fs.access(startupMarker), { code: 'ENOENT' });
});

test('deploy rejects tracked, staged, and untracked edits before changing VERSION', { skip: !supported }, async (t) => {
  for (const kind of ['tracked', 'staged', 'untracked']) {
    await t.test(kind, async (t) => {
      const f = await fixture(t);
      await fs.writeFile(path.join(f.dir, kind === 'untracked' ? 'new.js' : 'source.js'), 'uncommitted source\n');
      if (kind === 'staged') await f.git('add', 'source.js');
      const result = await f.deploy();
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /깨끗한 작업 트리/);
      assert.equal(await fs.readFile(path.join(f.dir, 'VERSION'), 'utf8'), '1.0.0\n');
      assert.equal(await f.git('rev-parse', 'HEAD'), f.initialCommit);
      assert.equal((await f.calls()).length, 0);
      assert.equal(await f.remoteFeed(), initialFeed.trim());
    });
  }
});

test('deploy validates branch, version, authentication, and local/remote duplicate tags before mutation', { skip: !supported }, async (t) => {
  const cases = [
    { name: 'wrong branch', prepare: (f) => f.git('checkout', '-qb', 'feature'), args: [], error: /main 브랜치/ },
    { name: 'malformed version', args: ['1.1'], error: /형식/ },
    { name: 'noncanonical version', args: ['01.1.0'], error: /형식/ },
    { name: 'same version', args: ['1.0.0'], error: /커야/ },
    { name: 'older version', args: ['0.9.0'], error: /커야/ },
    { name: 'authentication failure', args: [], fail: 'auth', error: /gh auth login/ },
    { name: 'local tag', prepare: (f) => f.git('tag', 'v1.0.1'), args: [], error: /로컬 태그/ },
    { name: 'remote tag', prepare: async (f) => {
      await f.git('tag', 'v1.0.1');
      await f.git('push', '-q', 'origin', 'v1.0.1');
      await f.git('tag', '-d', 'v1.0.1');
    }, args: [], error: /원격 태그/ },
  ];
  for (const item of cases) {
    await t.test(item.name, async (t) => {
      const f = await fixture(t);
      if (item.prepare) await item.prepare(f);
      const result = await f.deploy(item.args, item.fail);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, item.error);
      assert.equal(await fs.readFile(path.join(f.dir, 'VERSION'), 'utf8'), '1.0.0\n');
      assert.equal(await f.git('rev-parse', 'HEAD'), f.initialCommit);
      assert.ok(!(await f.calls()).some((call) => call.command === 'build'));
      assert.equal(await f.remoteFeed(), initialFeed.trim());
    });
  }
});

test('deploy builds and tags the same versioned commit before publishing the update feed', { skip: !supported }, async (t) => {
  const f = await fixture(t);
  const result = await f.deploy();
  assert.equal(result.code, 0, result.stderr);
  const releaseCommit = await f.git('rev-parse', 'v1.0.1');
  assert.notEqual(releaseCommit, f.initialCommit);
  assert.equal(await f.git('show', 'v1.0.1:VERSION'), '1.0.1');
  const extracted = path.join(f.base, 'extracted');
  await execFile('/usr/bin/ditto', ['-x', '-k', path.join(f.dir, 'dist/WindowFinder-1.0.1.zip'), extracted]);
  const artifact = path.join(extracted, 'WindowFinder.app');
  assert.equal((await fs.readFile(path.join(artifact, 'build-commit'), 'utf8')).trim(), releaseCommit);
  assert.equal((await fs.readFile(path.join(artifact, 'VERSION'), 'utf8')).trim(), '1.0.1');
  assert.equal((await fs.readFile(path.join(artifact, 'source.js'), 'utf8')).trim(), await f.git('show', 'v1.0.1:source.js'));
  assert.equal(await f.git('--git-dir', f.remote, 'rev-parse', 'v1.0.1'), releaseCommit);
  assert.equal(await f.git('rev-parse', 'HEAD^'), releaseCommit);
  assert.equal(await f.git('status', '--porcelain'), '');
  const feed = JSON.parse(await f.remoteFeed());
  assert.equal(feed.version, '1.0.1');
  assert.match(feed.zip, /\/v1\.0\.1\/WindowFinder-1\.0\.1\.zip$/);
  const calls = await f.calls();
  assert.deepEqual(calls.map((call) => call.command), ['gh', 'build', 'archive', 'gh']);
  assert.deepEqual(calls[3].args.slice(0, 4), ['release', 'create', 'v1.0.1', 'dist/WindowFinder-1.0.1.zip']);
});

test('deploy preserves the old update feed when build, archive, or release upload fails', { skip: !supported }, async (t) => {
  for (const failure of ['build', 'archive', 'upload']) {
    await t.test(failure, async (t) => {
      const f = await fixture(t);
      const result = await f.deploy(['1.2.0'], failure);
      assert.notEqual(result.code, 0);
      assert.equal(await fs.readFile(path.join(f.dir, 'latest.json'), 'utf8'), initialFeed);
      assert.equal(await f.remoteFeed(), initialFeed.trim());
      assert.doesNotMatch(result.stdout, /배포 완료/);
      assert.equal(await f.git('log', '-1', '--format=%s'), 'release v1.2.0');
      if (failure !== 'upload') {
        assert.equal(await f.git('tag', '--list', 'v1.2.0'), '');
        assert.ok(!(await f.calls()).some((call) => call.args?.[0] === 'release'));
      } else {
        assert.ok((await f.calls()).some((call) => call.args?.[0] === 'release'));
        assert.equal(await f.git('--git-dir', f.remote, 'rev-parse', 'main'), await f.git('rev-parse', 'v1.2.0'));
      }
    });
  }
});

test('deploy stops before building when the version commit fails', { skip: !supported }, async (t) => {
  const f = await fixture(t);
  const hook = path.join(f.dir, '.git/hooks/pre-commit');
  await fs.writeFile(hook, '#!/bin/sh\nexit 1\n');
  await fs.chmod(hook, 0o755);
  const result = await f.deploy();
  assert.notEqual(result.code, 0);
  assert.equal(await f.git('rev-parse', 'HEAD'), f.initialCommit);
  assert.equal(await f.git('tag', '--list', 'v1.0.1'), '');
  assert.ok(!(await f.calls()).some((call) => call.command === 'build'));
  assert.equal(await f.remoteFeed(), initialFeed.trim());
});

test('deploy does not tag or publish source modified during the build', { skip: !supported }, async (t) => {
  const f = await fixture(t);
  const result = await f.deploy([], 'mutate');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /깨끗한 작업 트리/);
  assert.equal(await f.git('tag', '--list', 'v1.0.1'), '');
  assert.equal(await f.git('--git-dir', f.remote, 'rev-parse', 'main'), f.initialCommit);
  assert.equal(await f.remoteFeed(), initialFeed.trim());
  assert.ok(!(await f.calls()).some((call) => call.args?.[0] === 'release'));
});
