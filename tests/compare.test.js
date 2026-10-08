'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8').split('// ---------- mode dispatch ----------')[0];
const context = vm.createContext({ require, __dirname: root, process, console, Buffer, URL, setTimeout, clearTimeout, AbortController });
vm.runInContext(source, context);
const compare = (left, right, mode = 'auto', offset = 0) => context.compareItems(left, right, mode, offset, new AbortController().signal);
async function fixture(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'windowfinder-compare-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return { dir, left: path.join(dir, 'left'), right: path.join(dir, 'right') };
}
test('텍스트의 추가/삭제/수정/마지막 개행을 좌우에 정확히 정렬한다', async (t) => {
  const { left, right } = await fixture(t);
  await fsp.writeFile(left, 'one\nsame\nold\nend'); await fsp.writeFile(right, 'new\none\nsame\nchanged\nend\n');
  const result = await compare(left, right);
  assert.equal(result.mode, 'text'); assert.equal(result.equal, false);
  assert.equal(result.rows[0].kind, 'right'); assert.equal(result.rows[1].kind, 'equal');
  assert.equal(result.rows.map((r) => r.left || '').join(''), 'one\nsame\nold\nend');
  assert.equal(result.rows.map((r) => r.right || '').join(''), 'new\none\nsame\nchanged\nend\n');
});
test('다양한 줄 변경은 원본을 빠뜨리거나 같은 줄로 오판하지 않는다', () => {
  let seed = 17;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; };
  for (let n = 0; n < 150; n++) {
    const a = Array.from({ length: rand() % 50 }, () => `${rand() % 10}\n`).join('');
    const b = Array.from({ length: rand() % 50 }, () => `${rand() % 10}\n`).join('');
    const result = context.compareLines(a, b);
    assert.equal(result.rows.map((r) => r.left || '').join(''), a);
    assert.equal(result.rows.map((r) => r.right || '').join(''), b);
    result.rows.filter((r) => r.kind === 'equal').forEach((r) => assert.equal(r.left, r.right));
  }
});
test('큰 변경도 줄 누락 없이 표시하며 단순화 여부를 알려준다', () => {
  const a = Array.from({ length: 700 }, (_, n) => `old ${n}\n`).join('');
  const b = Array.from({ length: 700 }, (_, n) => `new ${n}\n`).join('');
  const result = context.compareLines(a, b);
  assert.equal(result.simplified, true);
  assert.equal(result.rows.map((r) => r.left || '').join(''), a);
  assert.equal(result.rows.map((r) => r.right || '').join(''), b);
});
test('UTF-16, BOM, CRLF 차이를 텍스트와 바이트 단위로 구분한다', async (t) => {
  const { left, right } = await fixture(t);
  await fsp.writeFile(left, Buffer.concat([Buffer.from([255, 254]), Buffer.from('한글\r\n', 'utf16le')]));
  await fsp.writeFile(right, '한글\n');
  const result = await compare(left, right);
  assert.equal(result.leftEncoding, 'utf-16le'); assert.equal(result.equal, false);
  assert.equal(result.rows[0].kind, 'changed');
});
test('Hex는 첫 페이지 밖의 변경도 전체 해시로 찾아내며 마지막 페이지까지 읽는다', async (t) => {
  const { left, right } = await fixture(t);
  const bytes = Buffer.alloc(2500, 0); await fsp.writeFile(left, bytes);
  bytes[2200] = 255; await fsp.writeFile(right, bytes);
  const first = await compare(left, right);
  assert.equal(first.mode, 'hex'); assert.equal(first.equal, false);
  assert.deepEqual(first.leftBytes, first.rightBytes);
  const last = await compare(left, right, 'hex', 2048);
  assert.equal(last.rightBytes[152], 255); assert.equal(last.leftBytes.length, 452);
});
test('빈 파일은 동일하며 큰 텍스트는 자르지 않고 Hex로 전환한다', async (t) => {
  const { left, right } = await fixture(t);
  await fsp.writeFile(left, ''); await fsp.writeFile(right, '');
  assert.equal((await compare(left, right)).equal, true);
  await fsp.writeFile(left, Buffer.alloc(1024 * 1024 + 1, 65));
  assert.equal((await compare(left, right)).mode, 'hex');
  await assert.rejects(compare(left, right, 'text'), /1 MiB/);
});
test('폴더는 중첩/빈 폴더/동일 크기 변경/한쪽 전용/유형 차이/링크를 비교한다', async (t) => {
  const { left, right } = await fixture(t);
  for (const p of [left, right]) {
    await fsp.mkdir(path.join(p, 'nested'), { recursive: true });
    await fsp.mkdir(path.join(p, 'empty'));
    await fsp.writeFile(path.join(p, 'same'), 'same');
    await fsp.symlink('missing', path.join(p, 'broken'));
    await fsp.symlink('..', path.join(p, 'cycle'));
  }
  await fsp.writeFile(path.join(left, 'nested', 'edit'), 'aa'); await fsp.writeFile(path.join(right, 'nested', 'edit'), 'bb');
  await fsp.writeFile(path.join(left, 'leftOnly'), 'a'); await fsp.writeFile(path.join(right, 'rightOnly'), 'b');
  await fsp.mkdir(path.join(left, 'type')); await fsp.writeFile(path.join(right, 'type'), 'file');
  const result = await compare(left, right), rows = new Map(result.rows.map((r) => [r.relative, r]));
  for (const name of ['empty', 'same', 'broken', 'cycle']) assert.equal(rows.get(name).status, 'equal');
  for (const name of ['nested', 'nested/edit']) assert.equal(rows.get(name).status, 'changed');
  assert.equal(rows.get('leftOnly').status, 'left'); assert.equal(rows.get('rightOnly').status, 'right'); assert.equal(rows.get('type').status, 'type');
  assert.equal(result.rows.length, 9);
});
test('파일 변경 후 다시 비교하면 해시 캐시를 무효화한다', async (t) => {
  const { left, right } = await fixture(t);
  await fsp.writeFile(left, 'aa'); await fsp.writeFile(right, 'aa'); assert.equal((await compare(left, right)).equal, true);
  await fsp.writeFile(right, 'bb'); assert.equal((await compare(left, right)).equal, false);
});
test('취소된 비교와 없는 파일은 성공으로 처리하지 않는다', async (t) => {
  const { left, right } = await fixture(t);
  await assert.rejects(compare(left, right), /ENOENT/);
  await fsp.writeFile(left, 'a'); await fsp.writeFile(right, 'b');
  const abort = new AbortController(); abort.abort();
  await assert.rejects(context.compareItems(left, right, 'auto', 0, abort.signal), /abort/i);
});
