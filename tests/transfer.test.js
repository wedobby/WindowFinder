'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { Readable } = require('node:stream');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8').split('// ---------- mode dispatch ----------')[0];

function server(overrides = {}, clipboardName = null) {
  const pb = { paths: [], changeCount: 0 };
  const context = vm.createContext({
    require(name) {
      if (name === 'fs/promises') return { ...fsp, ...overrides };
      if (name === 'child_process') return {
        ...require(name),
        execFile(cmd, args, opts, callback) {
          assert.equal(cmd, 'osascript');
          if (clipboardName) {
            const isolated = args.map((arg) => arg.replace('$.NSPasteboard.generalPasteboard', `$.NSPasteboard.pasteboardWithName('${clipboardName}')`));
            return require(name).execFile(cmd, isolated, opts, callback);
          }
          if (args[3].includes('pb.writeObjects')) {
            pb.paths = JSON.parse(args[4]);
            callback(null, String(++pb.changeCount), '');
          } else callback(null, JSON.stringify(pb), '');
        },
      };
      return require(name);
    },
    __dirname: root, process, console, Buffer, URL, setTimeout, clearTimeout,
  });
  vm.runInContext(source + '\nglobalThis.handlers = api; globalThis.clipboardScripts = { read: JXA_PB_READ, write: JXA_PB_WRITE };', context);
  async function call(name, body) {
    const req = Readable.from(body ? [JSON.stringify(body)] : []);
    let result;
    await context.handlers[name](req, {
      writeHead(status) { assert.equal(status, 200); },
      end(data) { result = JSON.parse(data); },
    });
    return result;
  }
  return { op: (body) => call('op', body), pasteboard: () => call('pasteboard'), pb, scripts: context.clipboardScripts };
}

async function fixture(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tdfe-transfer-test-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const src = path.join(dir, 'source'), dest = path.join(dir, 'destination');
  await Promise.all([fsp.mkdir(src), fsp.mkdir(dest)]);
  return { src, dest };
}

test('multi-item move continues past missing files and retries only failed cut items', async (t) => {
  const { src, dest } = await fixture(t);
  const paths = ['first.txt', 'missing.txt', 'last.txt'].map((name) => path.join(src, name));
  await Promise.all([fsp.writeFile(paths[0], 'first'), fsp.writeFile(paths[2], 'last')]);
  const app = server();
  await app.op({ op: 'setPasteboard', mode: 'cut', paths });
  const result = await app.op({ op: 'move', paths, dest });
  assert.equal(result.ok, false);
  assert.deepEqual(result.results.map((r) => r.status), ['completed', 'failed', 'completed']);
  assert.equal(await fsp.readFile(path.join(dest, 'last.txt'), 'utf8'), 'last');
  assert.deepEqual((await app.pasteboard()).paths, [paths[1]]);
  await fsp.writeFile(paths[1], 'repaired');
  const retry = await app.op({ op: 'move', paths: (await app.pasteboard()).paths, dest });
  assert.equal(retry.ok, true);
  assert.deepEqual((await app.pasteboard()).paths, []);
  assert.deepEqual((await fsp.readdir(dest)).sort(), ['first.txt', 'last.txt', 'missing.txt']);
});

test('copy continues after an error and preserves every source', async (t) => {
  const { src, dest } = await fixture(t);
  const paths = ['missing', 'a', 'b'].map((name) => path.join(src, name));
  await Promise.all(paths.slice(1).map((p) => fsp.writeFile(p, p)));
  const result = await server().op({ op: 'copy', paths, dest });
  assert.deepEqual(result.results.map((r) => r.status), ['failed', 'completed', 'completed']);
  for (const p of paths.slice(1)) assert.equal(await fsp.readFile(p, 'utf8'), p);
});

test('existing names and broken symlinks are preserved and actual destinations returned', async (t) => {
  const { src, dest } = await fixture(t);
  await fsp.writeFile(path.join(src, 'file.txt'), 'new');
  await fsp.symlink('missing-target', path.join(dest, 'file.txt'));
  const result = await server().op({ op: 'move', paths: [path.join(src, 'file.txt')], dest });
  assert.equal(result.results[0].destination, path.join(dest, 'file copy.txt'));
  assert.equal(await fsp.readlink(path.join(dest, 'file.txt')), 'missing-target');
  assert.equal(await fsp.readFile(path.join(dest, 'file copy.txt'), 'utf8'), 'new');
});

test('same-folder moves are skipped without consuming the cut selection', async (t) => {
  const { src } = await fixture(t);
  const paths = [path.join(src, 'file')];
  await fsp.writeFile(paths[0], 'original');
  const app = server();
  await app.op({ op: 'setPasteboard', mode: 'cut', paths });
  const result = await app.op({ op: 'move', paths, dest: src });
  assert.equal(result.results[0].status, 'skipped');
  assert.deepEqual((await app.pasteboard()).paths, paths);
});

test('Finder copying the same paths again does not inherit an old cut marker', async () => {
  const app = server();
  await app.op({ op: 'setPasteboard', mode: 'cut', paths: ['/tmp/file'] });
  assert.equal((await app.pasteboard()).cut, true);
  app.pb.changeCount++;
  assert.equal((await app.pasteboard()).cut, false);
});

function crossDeviceRename(src) {
  return async (from, to) => {
    if (from.startsWith(src + path.sep)) throw Object.assign(new Error('cross device'), { code: 'EXDEV' });
    return fsp.rename(from, to);
  };
}

test('cross-volume folders preserve nested files and relative symlinks', async (t) => {
  const { src, dest } = await fixture(t);
  const folder = path.join(src, 'folder');
  await fsp.mkdir(path.join(folder, 'nested'), { recursive: true });
  await fsp.writeFile(path.join(folder, 'nested', '한글.txt'), 'contents');
  await fsp.symlink('nested/한글.txt', path.join(folder, 'link'));
  const result = await server({ rename: crossDeviceRename(src) }).op({ op: 'move', paths: [folder], dest });
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(folder), false);
  assert.equal(await fsp.readFile(path.join(dest, 'folder', 'link'), 'utf8'), 'contents');
  assert.equal(await fsp.readlink(path.join(dest, 'folder', 'link')), 'nested/한글.txt');
  assert.deepEqual(await fsp.readdir(dest), ['folder']);
});

test('failed cross-volume copies keep source intact, clean staging, and continue', async (t) => {
  const { src, dest } = await fixture(t);
  const paths = ['bad', 'good'].map((name) => path.join(src, name));
  await Promise.all(paths.map((p) => fsp.writeFile(p, 'original')));
  const app = server({
    rename: crossDeviceRename(src),
    async cp(from, to, options) {
      if (from === paths[0]) {
        await fsp.writeFile(to, 'partial');
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      }
      return fsp.cp(from, to, options);
    },
  });
  const result = await app.op({ op: 'move', paths, dest });
  assert.deepEqual(result.results.map((r) => r.status), ['failed', 'completed']);
  assert.equal(await fsp.readFile(paths[0], 'utf8'), 'original');
  assert.deepEqual(await fsp.readdir(dest), ['good']);
});

test('a file collision during cross-volume copy cannot silently delete the source', async (t) => {
  const { src, dest } = await fixture(t);
  const file = path.join(src, 'file');
  await fsp.writeFile(file, 'original');
  const app = server({
    rename: crossDeviceRename(src),
    async cp(from, to, options) {
      await fsp.writeFile(to, 'collision');
      return fsp.cp(from, to, options);
    },
  });
  const result = await app.op({ op: 'move', paths: [file], dest });
  assert.equal(result.ok, false);
  assert.equal(await fsp.readFile(file, 'utf8'), 'original');
  assert.deepEqual(await fsp.readdir(dest), []);
});

test('macOS cut/paste moves all 150 Unicode paths and consumes the cut selection', { skip: process.platform !== 'darwin' }, async (t) => {
  const { promisify } = require('node:util');
  const exec = promisify(require('node:child_process').execFile);
  const board = `local.tdfe.test.${process.pid}.${Date.now()}`;
  // A named test pasteboard leaves the user's general clipboard untouched.
  const substitute = (script) => script.replace('$.NSPasteboard.generalPasteboard', `$.NSPasteboard.pasteboardWithName('${board}')`);
  t.after(() => exec('osascript', ['-l', 'JavaScript', '-e', `ObjC.import('AppKit'); $.NSPasteboard.pasteboardWithName('${board}').releaseGlobally;`]));
  const { scripts } = server();
  const { src, dest } = await fixture(t);
  const paths = Array.from({ length: 150 }, (_, i) => path.join(src, `한글 파일 ${i} # & %.txt`));
  await Promise.all(paths.map((p) => fsp.writeFile(p, p)));
  const written = await exec('osascript', ['-l', 'JavaScript', '-e', substitute(scripts.write), JSON.stringify(paths)]);
  const read = await exec('osascript', ['-l', 'JavaScript', '-e', substitute(scripts.read)]);
  const snapshot = JSON.parse(read.stdout);
  assert.deepEqual(snapshot.paths.map((p) => p.normalize('NFC')), paths);
  assert.equal(snapshot.changeCount, Number(written.stdout.trim()));
  const nativeApp = server({}, board);
  await nativeApp.op({ op: 'setPasteboard', mode: 'cut', paths });
  const selection = await nativeApp.pasteboard();
  assert.equal(selection.cut, true);
  assert.deepEqual(selection.paths, paths);
  const moved = await nativeApp.op({ op: 'move', paths: selection.paths, dest });
  assert.equal(moved.results.filter((r) => r.status === 'completed').length, 150);
  assert.deepEqual(await fsp.readdir(src), []);
  for (const p of paths) assert.equal(await fsp.readFile(path.join(dest, path.basename(p)), 'utf8'), p);
  assert.deepEqual((await nativeApp.pasteboard()).paths, []);
});
