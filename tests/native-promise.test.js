'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const exec = require('node:util').promisify(require('node:child_process').execFile);

test('드래그 생성 범위를 벗어난 뒤에도 5개 파일 약속의 복사 담당 객체를 유지한다', { skip: process.platform !== 'darwin' }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'windowfinder-native-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = await fs.readFile(path.join(__dirname, '../native/main.swift'), 'utf8');
  const swift = source.slice(0, source.indexOf('// dedicated drag source')) + `
let testRoot = URL(fileURLWithPath: CommandLine.arguments[1])
let sourceDir = testRoot.appendingPathComponent("source")
let destDir = testRoot.appendingPathComponent("destination")
try FileManager.default.createDirectory(at: sourceDir, withIntermediateDirectories: true)
try FileManager.default.createDirectory(at: destDir, withIntermediateDirectories: true)
func makeProviders() throws -> [FilePromiseProviderWithURL] {
    return try (1...5).map { index in
        let src = sourceDir.appendingPathComponent("파일 \\(index).txt")
        try "내용 \\(index)".write(to: src, atomically: true, encoding: .utf8)
        return FilePromiseProviderWithURL(sourcePath: src.path, fileType: "public.plain-text")
    }
}
let providers = try autoreleasepool { try makeProviders() }
for (index, provider) in providers.enumerated() {
    guard let writer = provider.delegate else { fatalError("복사 담당 객체가 먼저 해제됨") }
    let name = writer.filePromiseProvider(provider, fileNameForType: "public.plain-text")
    var finished = false
    writer.filePromiseProvider(provider, writePromiseTo: destDir.appendingPathComponent(name)) { error in
        precondition(error == nil)
        finished = true
    }
    precondition(finished)
    precondition(try! String(contentsOf: destDir.appendingPathComponent(name), encoding: .utf8) == "내용 \\(index + 1)")
}
precondition(try! FileManager.default.contentsOfDirectory(atPath: destDir.path).count == 5)
print("5개 지연 복사 완료")
`;
  const file = path.join(dir, 'main.swift'), bin = path.join(dir, 'promise-test');
  await fs.writeFile(file, swift);
  await exec('swiftc', [file, '-o', bin]);
  const result = await exec(bin, [dir]);
  assert.match(result.stdout, /5개 지연 복사 완료/);
});
