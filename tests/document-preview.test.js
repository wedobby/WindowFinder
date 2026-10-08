'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8').split('// ---------- mode dispatch ----------')[0];
async function fixture(t, fsOverride = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'windowfinder-preview-'));
  const context = vm.createContext({ require: (name) => name === 'fs' ? { ...fs, ...fsOverride } : require(name),
    __dirname: root, process, console, Buffer, URL, URLSearchParams, setTimeout, clearTimeout });
  vm.runInContext(source, context);
  const server = http.createServer(context.handleRequest);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  vm.runInContext(`PORT = ${server.address().port}`, context);
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await fsp.rm(dir, { recursive: true, force: true }); });
  return { dir, origin };
}
const previewURL = (origin, file) => origin + '/preview' + file.split('/').map(encodeURIComponent).join('/');
test('HTML·HTM과 상대 CSS·이미지를 올바른 형식으로 제공하고 문서 스크립트를 격리한다', async (t) => {
  const { dir, origin } = await fixture(t);
  const html = '<link rel="stylesheet" href="style.css"><h1>한글 문서</h1><img src="image.svg"><script>parent.test=true</script>';
  await fsp.writeFile(path.join(dir, 'style.css'), 'h1 { color: red; }');
  await fsp.writeFile(path.join(dir, 'image.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  for (const ext of ['html', 'htm', 'HTML']) {
    const file = path.join(dir, `문서 # ? &.${ext}`); await fsp.writeFile(file, html);
    const url = previewURL(origin, file), response = await fetch(url);
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /^text\/html/);
    assert.equal(await response.text(), html);
    const policy = response.headers.get('content-security-policy');
    assert.match(policy, /^sandbox;/); assert.match(policy, /script-src 'none'/); assert.match(policy, /form-action 'none'/);
    const css = await fetch(new URL('style.css', url)); assert.match(css.headers.get('content-type'), /^text\/css/); assert.match(await css.text(), /color: red/);
    assert.equal((await fetch(new URL('image.svg', url))).status, 200);
    const raw = await fetch(origin + '/api/file?' + new URLSearchParams({ path: file }));
    assert.match(raw.headers.get('content-security-policy'), /sandbox/);
  }
});
test('PDF를 인라인으로 제공하고 전체·앞부분·뒷부분 Range를 정확히 읽는다', async (t) => {
  const { dir, origin } = await fixture(t), file = path.join(dir, 'document.pdf');
  const bytes = Buffer.from('%PDF-1.4\npreview-test\n%%EOF'); await fsp.writeFile(file, bytes);
  const url = origin + '/api/file?' + new URLSearchParams({ path: file });
  const full = await fetch(url); assert.equal(full.headers.get('content-type'), 'application/pdf');
  assert.equal(full.headers.get('content-disposition'), 'inline'); assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
  for (const [range, start, end] of [['bytes=0-7', 0, 7], ['bytes=-5', bytes.length - 5, bytes.length - 1], ['bytes=4-999', 4, bytes.length - 1]]) {
    const response = await fetch(url, { headers: { Range: range } });
    assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${bytes.length}`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(start, end + 1));
  }
  assert.equal((await fetch(url, { headers: { Range: 'bytes=999-' } })).status, 416);
});
test('미리보기 스트림 오류는 서버를 종료하지 않고 해당 요청만 실패한다', async (t) => {
  const { dir, origin } = await fixture(t, { createReadStream() {
    const stream = new (require('node:stream').PassThrough)();
    process.nextTick(() => stream.destroy(new Error('읽는 중 삭제된 파일'))); return stream;
  } });
  const file = path.join(dir, 'removed.pdf'); await fsp.writeFile(file, 'test');
  const response = await fetch(origin + '/api/file?' + new URLSearchParams({ path: file }));
  assert.equal(response.status, 404); assert.match((await response.json()).error, /삭제된 파일/);
  assert.equal((await fetch(origin + '/api/unknown')).status, 404);
});
test('문서가 GET으로 업로드 주소에 이동해도 파일을 만들지 않는다', async (t) => {
  const { dir, origin } = await fixture(t);
  const response = await fetch(origin + '/api/upload?' + new URLSearchParams({ dir, name: 'unexpected.txt' }));
  assert.equal(response.status, 405); assert.equal(fs.existsSync(path.join(dir, 'unexpected.txt')), false);
});
test('HTML·HTM·PDF를 문서 미리보기 종류로 분류한다', () => {
  const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(app.slice(app.indexOf('const EXT_KIND ='), app.indexOf('function svgIcon(')), context);
  for (const ext of ['html', 'htm', 'xhtml']) assert.equal(context.entryKind({ ext }), 'html');
  assert.equal(context.entryKind({ ext: 'pdf' }), 'pdf');
});
