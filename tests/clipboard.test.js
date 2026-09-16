'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const clipboardSource = app.slice(app.indexOf('let clipboardWrite ='), app.indexOf('async function doTrash()'));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const tick = () => new Promise((r) => setImmediate(r));

function client(overrides = {}) {
  const calls = [], messages = [], modals = [];
  const state = { cwd: '/destination', selection: new Set(['/source/a', '/source/b']), clipboard: null };
  const context = vm.createContext({
    state,
    render() {}, refresh() {},
    toast(...args) { messages.push(args); },
    textModal(...args) { modals.push(args); },
    async apiGet() { return { paths: ['/source/a', '/source/b'], cut: true, readable: true }; },
    async apiOp(body) {
      calls.push(body);
      if (body.op === 'setPasteboard') return { ok: true };
      return { ok: true, results: body.paths.map((source) => ({ source, destination: '/destination/' + source.split('/').pop(), status: 'completed' })) };
    },
    ...overrides,
  });
  vm.runInContext(clipboardSource, context);
  return { context, state, calls, messages, modals };
}

test('immediate paste waits for clipboard write, blocks duplicate paste, and captures destination', async () => {
  const write = deferred();
  const calls = [];
  const c = client({
    async apiOp(body) {
      calls.push(body);
      if (body.op === 'setPasteboard') return write.promise;
      return { results: body.paths.map((source) => ({ source, status: 'completed' })) };
    },
  });
  c.context.doCopy(true);
  const paste = c.context.doPaste();
  await tick();
  await c.context.doPaste();
  assert.equal(calls.length, 1);
  c.state.cwd = '/another-folder';
  write.resolve({ ok: true });
  await paste;
  assert.equal(calls.length, 2);
  assert.equal(calls[1].dest, '/destination');
  assert.equal(calls[1].op, 'move');
  assert.equal(c.state.clipboard, null);
});

test('partial move keeps only failures and displays the failed paths', async () => {
  const c = client({
    async apiOp(body) {
      if (body.op === 'setPasteboard') return { ok: true };
      return { ok: false, results: [
        { source: '/source/a', status: 'completed', destination: '/destination/a copy' },
        { source: '/source/b', status: 'failed', error: 'permission denied' },
      ] };
    },
  });
  c.context.doCopy(true);
  await c.context.doPaste();
  assert.deepEqual(Array.from(c.state.clipboard.paths), ['/source/b']);
  assert.equal(c.state.clipboard.mode, 'cut');
  assert.match(c.modals[0][1], /1개 이동 완료, 1개 실패/);
  assert.match(c.modals[0][1], /\/source\/b\npermission denied/);
});

test('an empty system clipboard never revives a stale local cut selection', async () => {
  const c = client({ async apiGet() { return { paths: [], cut: false, readable: true }; } });
  c.context.doCopy(true);
  await c.context.doPaste();
  assert.equal(c.calls.filter((b) => b.op === 'move').length, 0);
});

test('failed system write uses the complete local selection instead of old system files', async () => {
  const calls = [];
  const c = client({
    async apiGet() { return { paths: ['/old-file'], cut: false, readable: true }; },
    async apiOp(body) {
      calls.push(body);
      if (body.op === 'setPasteboard') throw new Error('unavailable');
      return { results: body.paths.map((source) => ({ source, status: 'completed' })) };
    },
  });
  c.context.doCopy(true);
  await c.context.doPaste();
  assert.equal(calls[1].op, 'move');
  assert.deepEqual(Array.from(calls[1].paths), ['/source/a', '/source/b']);
});

test('copying another selection during a move is not overwritten when the move finishes', async () => {
  const move = deferred();
  const c = client({
    async apiOp(body) {
      if (body.op === 'setPasteboard') return { ok: true };
      return move.promise;
    },
  });
  c.context.doCopy(true);
  const paste = c.context.doPaste();
  await tick();
  c.state.selection = new Set(['/new-file']);
  c.context.doCopy(false);
  move.resolve({ results: [
    { source: '/source/a', status: 'completed' },
    { source: '/source/b', status: 'completed' },
  ] });
  await paste;
  assert.equal(c.state.clipboard.mode, 'copy');
  assert.deepEqual(Array.from(c.state.clipboard.paths), ['/new-file']);
});

test('same-folder cut paste keeps the selection and reports zero moves', async () => {
  const c = client({ async apiOp(body) {
    if (body.op === 'setPasteboard') return { ok: true };
    return { results: body.paths.map((source) => ({ source, status: 'skipped', destination: source })) };
  } });
  c.context.doCopy(true);
  await c.context.doPaste();
  assert.equal(c.state.clipboard.paths.length, 2);
  assert.match(c.messages.at(-1)[0], /0개 이동 완료, 2개는 같은 폴더/);
});

test('rapid successive cuts write in order before pasting the newest selection', async () => {
  const first = deferred(), writes = [], transfers = [];
  const c = client({
    async apiGet() { return { paths: writes.at(-1), cut: true, readable: true }; },
    async apiOp(body) {
      if (body.op === 'setPasteboard') {
        writes.push(body.paths);
        if (writes.length === 1) await first.promise;
        return { ok: true };
      }
      transfers.push(body.paths);
      return { results: body.paths.map((source) => ({ source, status: 'completed' })) };
    },
  });
  c.context.doCopy(true);
  c.state.selection = new Set(['/new-file']);
  c.context.doCopy(true);
  const paste = c.context.doPaste();
  await tick();
  assert.equal(writes.length, 1);
  first.resolve();
  await paste;
  assert.deepEqual(Array.from(transfers[0]), ['/new-file']);
});
