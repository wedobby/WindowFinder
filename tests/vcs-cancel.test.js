'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const cp = require('node:child_process');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8')
  .split('// ---------- mode dispatch ----------')[0];

// Exercise the real HTTP response lifetime and handler. Substitute only the
// Git/SVN executable, so these tests never contact a remote or modify a repo.
async function fixture(t, script) {
  const calls = [], signals = [], children = [];
  let finished;
  const handlerDone = new Promise((resolve) => { finished = resolve; });
  const context = vm.createContext({
    require(name) {
      if (name !== 'child_process') return require(name);
      return {
        ...cp,
        spawn(command, args, options) {
          calls.push({ command, args });
          const child = script === null
            ? cp.spawn('/windowfinder-test-no-such-executable', [], options)
            : cp.spawn(process.execPath, ['-e', script], options);
          const record = { child, closed: false, output: '' };
          children.push(record);
          child.stdout.on('data', (data) => { record.output += data; });
          child.stderr.on('data', (data) => { record.output += data; });
          child.once('close', () => { record.closed = true; });
          return child;
        },
      };
    },
    __dirname: root,
    process: {
      ...process,
      kill(pid, signal) {
        signals.push({ pid, signal });
        return process.kill(pid, signal);
      },
    },
    console, Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval,
  });
  vm.runInContext(source + '\nglobalThis.handler = api.vcsstream;', context);
  const server = http.createServer((req, res) => {
    context.handler(req, res).then(() => finished(), (error) => {
      res.destroy(error);
      finished(error);
    });
  });
  t.after(async () => {
    for (const { child, closed } of children) {
      if (!closed && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const request = (payload, abortAfter = null) => new Promise((resolve, reject) => {
    let output = '', aborted = false;
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (data) => {
        output += data;
        if (!aborted && abortAfter && output.includes(abortAfter)) {
          aborted = true;
          res.destroy();
          req.destroy();
          resolve({ output, status: res.statusCode });
        }
      });
      res.on('end', () => resolve({ output, status: res.statusCode }));
      res.on('error', (error) => { if (!aborted) reject(error); });
    });
    req.on('error', (error) => { if (!aborted) reject(error); });
    req.end(JSON.stringify({ root, ...payload }));
  });
  return { request, calls, signals, children, handlerDone };
}

test('normal HTTP body completion and response completion do not terminate a VCS job', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, "console.log('started'); setTimeout(() => console.log('finished'), 50);");
  const response = await f.request({ tool: 'git', action: 'fetch' });
  assert.equal(await f.handlerDone, undefined);
  assert.equal(response.status, 200);
  assert.match(response.output, /started\nfinished\n\n__DONE__:0\n$/);
  assert.equal(f.children[0].child.exitCode, 0);
  assert.deepEqual(f.signals, []);
});

test('normal multi-step operation runs both commands and retains the completion marker', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, "console.log('step finished');");
  const response = await f.request({ tool: 'git', action: 'commitAll', message: 'test only' });
  assert.equal(await f.handlerDone, undefined);
  assert.equal(f.calls.length, 2);
  assert.match(response.output, /step finished\nstep finished\n\n__DONE__:0\n$/);
  assert.deepEqual(f.signals, []);
});

test('disconnect terminates the process group, including a helper that ignores SIGTERM', {
  timeout: 6000, skip: process.platform === 'win32',
}, async (t) => {
  const helper = `
    process.on('SIGTERM', () => console.log('helper received SIGTERM'));
    console.log('helper ready');
    setInterval(() => {}, 1000);
  `;
  const script = `
    process.on('SIGTERM', () => {});
    require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(helper)}], {
      stdio: ['ignore', 'inherit', 'inherit']
    });
    setInterval(() => {}, 1000);
  `;
  const f = await fixture(t, script);
  const response = await f.request({ tool: 'git', action: 'fetch' }, 'helper ready');
  assert.equal(await f.handlerDone, undefined);
  const { child, output, closed } = f.children[0];
  assert.equal(closed, true);
  assert.equal(child.signalCode, 'SIGKILL');
  assert.match(output, /helper received SIGTERM/);
  assert.ok(f.signals.some((entry) => entry.pid === -child.pid && entry.signal === 'SIGTERM'));
  assert.ok(f.signals.some((entry) => entry.pid === -child.pid && entry.signal === 'SIGKILL'));
  assert.doesNotMatch(response.output, /__DONE__:/);
});

for (const payload of [
  { tool: 'git', action: 'commitAll', message: 'test only' },
  { tool: 'svn', action: 'cleanup', basic: true, removeIgnored: true },
]) {
  test(`${payload.tool} cancellation during the first step prevents the next command even after exit 0`, {
    timeout: 5000,
  }, async (t) => {
    const f = await fixture(t, `
      process.on('SIGTERM', () => process.exit(0));
      console.log('first step ready');
      setInterval(() => {}, 1000);
    `);
    await f.request(payload, 'first step ready');
    assert.equal(await f.handlerDone, undefined);
    assert.equal(f.calls.length, 1);
    assert.equal(f.children[0].child.exitCode, 0);
    assert.ok(f.signals.some((entry) => entry.signal === 'SIGTERM'));
  });
}

test('failure to spawn completes the response with exit code 127', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, null);
  const response = await f.request({ tool: 'svn', action: 'update' });
  assert.equal(await f.handlerDone, undefined);
  assert.match(response.output, /ENOENT/);
  assert.match(response.output, /__DONE__:127\n$/);
  assert.deepEqual(f.signals, []);
});
