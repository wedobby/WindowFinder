'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8').split('// ---------- mode dispatch ----------')[0];
const packageBins = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'];

function server({ bin, platform = 'darwin', home = '/windowfinder-test-home', exec, fsOverrides = {}, fspOverrides = {} } = {}) {
  const calls = [];
  const context = vm.createContext({
    require(name) {
      if (name === 'fs') return { ...fs, existsSync(p) { return !packageBins.includes(p) && fs.existsSync(p); }, ...fsOverrides };
      if (name === 'fs/promises') return { ...fsp, ...fspOverrides };
      if (name === 'os') return { ...os, homedir: () => home };
      if (name === 'child_process') return {
        ...require(name),
        execFile(command, args, options, callback) {
          const call = { command, args: Array.from(args), options };
          calls.push(call);
          // Every OS command is intercepted: these tests never launch GUI apps,
          // query the real pasteboard, or execute developer-tool installer shims.
          if (exec) return exec(call, callback);
          if (command === '/usr/bin/osascript') return callback(null, '[false,false]', '');
          if (path.basename(command) === 'git') return callback(null, 'git version 2.45.0\n', '');
          if (path.basename(command) === 'svn') return callback(null, '1.14.3\n', '');
          callback(null, '', '');
        },
      };
      return require(name);
    },
    __dirname: root, process: { ...process, platform, env: { ...process.env, PATH: bin || '/windowfinder-test-no-bin' } },
    console, Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval,
  });
  vm.runInContext(source + '\nglobalThis.testApi = api; globalThis.testScanApps = scanApplications;', context);
  return {
    calls,
    scan: context.testScanApps,
    async call(name, body, query = {}) {
      const req = new EventEmitter();
      let status, output = '';
      const response = Object.assign(new EventEmitter(), {
        writeHead(code) { status = code; }, write(data) { output += data; }, end(data = '') { output += data; },
      });
      const pending = context.testApi[name](req, response, new URLSearchParams(query));
      if (body) { req.emit('data', JSON.stringify(body)); req.emit('end'); }
      await pending;
      return { status, data: JSON.parse(output) };
    },
  };
}

async function fixture(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'windowfinder-integrations-test-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  await fsp.mkdir(bin);
  const executable = async (name) => { const p = path.join(bin, name); await fsp.writeFile(p, 'fake executable', { mode: 0o755 }); return p; };
  const app = async (name) => {
    const p = path.join(dir, name);
    await fsp.mkdir(path.join(p, 'Contents'), { recursive: true });
    await fsp.writeFile(path.join(p, 'Contents/Info.plist'), '<?xml version="1.0"?><plist><dict><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
    return p;
  };
  return { dir, bin, executable, app };
}

test('integrations probes executable versions once for concurrent callers and supports refresh', async (t) => {
  const f = await fixture(t);
  await f.executable('git');
  await f.executable('svn');
  const app = server({ bin: f.bin });
  const replies = await Promise.all([app.call('integrations'), app.call('integrations'), app.call('integrations')]);
  for (const reply of replies) {
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.data, { git: true, svn: true, editors: { vscode: false, zed: false } });
  }
  assert.equal(app.calls.length, 3);
  assert.ok(app.calls.every((c) => c.options.timeout > 0 && c.options.timeout <= 2500));
  await fsp.unlink(path.join(f.bin, 'svn'));
  assert.equal((await app.call('integrations')).data.svn, true);
  assert.equal((await app.call('integrations', null, { refresh: '1' })).data.svn, false);
  assert.equal(app.calls.length, 5);
});

test('unavailable tools are omitted from repository and directory-info discovery without executing them', async (t) => {
  const f = await fixture(t);
  await fsp.mkdir(path.join(f.dir, '.git'));
  await fsp.mkdir(path.join(f.dir, '.svn'));
  const app = server({ bin: f.bin });
  const vcs = await app.call('vcs', null, { path: f.dir });
  assert.deepEqual(vcs.data, { integrations: { git: false, svn: false, editors: { vscode: false, zed: false } } });
  const info = await app.call('dirinfo', null, { path: f.dir });
  assert.equal(info.data.git, null);
  assert.equal(info.data.svn, null);
  const home = await app.call('home');
  assert.deepEqual(home.data.integrations, vcs.data.integrations);
  assert.equal(app.calls.some((c) => ['git', 'svn'].includes(path.basename(c.command))), false);
});

test('malformed versions and failed or timed-out executables are not exposed', async (t) => {
  const f = await fixture(t);
  await f.executable('git');
  await f.executable('svn');
  const app = server({ bin: f.bin, exec({ command, options }, callback) {
    if (command === '/usr/bin/osascript') return callback(null, '[true,false]', '');
    assert.equal(options.timeout, 2000);
    if (path.basename(command) === 'git') return callback(null, 'not Git', '');
    callback(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), '', '');
  } });
  assert.deepEqual((await app.call('integrations')).data, { git: false, svn: false, editors: { vscode: true, zed: false } });
});

test('macOS Git shim is never run when developer tools are missing', async () => {
  const app = server({ bin: '/usr/bin', exec({ command }, callback) {
    if (command === '/usr/bin/osascript') return callback(null, '[false,false]', '');
    assert.equal(command, '/usr/bin/xcode-select');
    callback(new Error('no active developer directory'), '', '');
  }, fspOverrides: {
    async access(p) { if (p !== '/usr/bin/git') throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    async stat() { return { isFile: () => true }; },
    async realpath(p) { return p; },
  } });
  assert.equal((await app.call('integrations')).data.git, false);
  assert.equal(app.calls.some((c) => c.command === '/usr/bin/git' || c.command === '/usr/bin/xcrun'), false);
});

test('macOS Git shim resolves through existing developer tools before the real version probe', async (t) => {
  const f = await fixture(t), developer = path.join(f.dir, 'Developer');
  const realGit = path.join(developer, 'usr/bin/git');
  await fsp.mkdir(path.dirname(realGit), { recursive: true });
  await fsp.writeFile(realGit, 'fake real git', { mode: 0o755 });
  const app = server({ bin: '/usr/bin', exec({ command, args, options }, callback) {
    if (command === '/usr/bin/osascript') return callback(null, '[false,true]', '');
    if (command === '/usr/bin/xcode-select') return callback(null, developer, '');
    if (command === '/usr/bin/xcrun') {
      assert.deepEqual(args, ['--no-cache', '--find', 'git']);
      assert.equal(options.env.DEVELOPER_DIR, developer);
      return callback(null, realGit, '');
    }
    assert.equal(command, realGit);
    callback(null, 'git version 2.40.0', '');
  }, fspOverrides: {
    async access(p, mode) { if (p === '/usr/bin/git') return; if (p === '/usr/bin/svn') throw new Error('missing'); return fsp.access(p, mode); },
    async stat(p) { return p === '/usr/bin/git' ? { isFile: () => true } : fsp.stat(p); },
    async realpath(p) { return p === '/usr/bin/git' ? p : fsp.realpath(p); },
  } });
  assert.deepEqual((await app.call('integrations')).data, { git: true, svn: false, editors: { vscode: false, zed: true } });
  assert.equal(app.calls.some((c) => c.command === '/usr/bin/git'), false);
});

test('application scan deduplicates aliases, sorts names, limits nesting and never descends into bundles', async (t) => {
  const f = await fixture(t), apps = path.join(f.dir, 'Applications');
  await fsp.mkdir(apps);
  const zed = await f.app('Applications/Zed.app');
  await f.app('Applications/Utilities/Alpha.app');
  await f.app('Applications/Zed.app/Contents/Helper.app');
  await f.app('Applications/a/b/c/d/Too Deep.app');
  await fsp.mkdir(path.join(apps, 'Not An App.app'));
  await fsp.symlink(zed, path.join(apps, 'Zed Alias.app'));
  const app = server();
  const result = JSON.parse(JSON.stringify(await app.scan([apps, apps])));
  assert.equal(result.length, 2);
  assert.equal(result[0].name, 'Alpha');
  assert.equal(result.some((item) => item.name === 'Helper' || item.name === 'Too Deep' || item.name === 'Not An App'), false);
  assert.equal(new Set(await Promise.all(result.map((item) => fsp.realpath(item.path)))).size, 2);
});

test('apps endpoint returns installed bundles from system, user and shared roots', async (t) => {
  const f = await fixture(t);
  await f.app('global/Alpha.app');
  await f.app('user/Zed.app');
  await f.app('system/Utilities/TextEdit.app');
  const remap = (p) => {
    for (const [from, to] of [['/Applications', 'global'], ['/mock-home/Applications', 'user'], ['/System/Applications', 'system']]) {
      if (p === from || p.startsWith(from + '/')) return path.join(f.dir, to, path.relative(from, p));
    }
    return p;
  };
  const app = server({ home: '/mock-home', fspOverrides: {
    stat: (p) => fsp.stat(remap(p)), realpath: (p) => fsp.realpath(remap(p)), readdir: (p, opts) => fsp.readdir(remap(p), opts),
  } });
  const result = await app.call('apps');
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.apps, [
    { name: 'Alpha', path: '/Applications/Alpha.app' },
    { name: 'TextEdit', path: '/System/Applications/Utilities/TextEdit.app' },
    { name: 'Zed', path: '/mock-home/Applications/Zed.app' },
  ]);
});

test('Open With passes the selected app and multiple literal paths to open without a shell', async (t) => {
  const f = await fixture(t);
  const chosen = await f.app('Chosen $(touch nope).app');
  const targets = [path.join(f.dir, 'spaces & "quotes".txt'), path.join(f.dir, '$(touch nope);name.txt')];
  const app = server();
  const result = await app.call('op', { op: 'openWith', app: chosen, paths: [...targets, targets[0]] });
  assert.equal(result.status, 200);
  assert.deepEqual(app.calls.map(({ command, args }) => ({ command, args })), [{ command: 'open', args: ['-a', chosen, ...targets] }]);
  assert.equal(app.calls[0].options.shell, undefined);
  assert.equal(fs.existsSync(path.join(f.dir, 'nope')), false);
  for (const body of [
    { app: 'relative.app', paths: targets }, { app: f.dir, paths: targets }, { app: chosen, paths: [] },
    { app: chosen, paths: ['relative.txt'] }, { app: chosen, paths: [null] }, { app: chosen, paths: ['/bad\0path'] },
    { path: targets[0] },
  ]) assert.equal((await app.call('op', { op: 'openWith', ...body })).status, 400);
  assert.equal(app.calls.length, 1);
});

test('editor operations accept only VS Code or Zed bundle IDs and preserve the legacy VS Code action', async () => {
  const app = server();
  const paths = ['/tmp/a file.txt', '/tmp/another.txt'];
  assert.equal((await app.call('op', { op: 'editor', editor: 'zed', paths })).status, 200);
  assert.equal((await app.call('op', { op: 'editor', editor: 'vscode', paths })).status, 200);
  assert.equal((await app.call('op', { op: 'vscode', path: paths[0] })).status, 200);
  assert.deepEqual(app.calls.map(({ args }) => args), [
    ['-b', 'dev.zed.Zed', ...paths], ['-b', 'com.microsoft.VSCode', ...paths], ['-b', 'com.microsoft.VSCode', paths[0]],
  ]);
  for (const editor of ['__proto__', 'toString', 'arbitrary.app', null]) {
    assert.equal((await app.call('op', { op: 'editor', editor, paths })).status, 400);
  }
  assert.equal((await app.call('op', { op: 'editor', editor: 'zed', paths: ['relative'] })).status, 400);
  assert.equal(app.calls.length, 3);
});
