#!/usr/bin/env node
/**
 * FileExplorer — Windows Explorer-style file manager for macOS.
 * Zero-dependency Node.js server: serves the UI and a filesystem API.
 *
 * Usage: node server.js [port]   (default port 8890, binds 127.0.0.1 only)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');

// GUI(launchd)에서 실행되면 PATH가 최소(/usr/bin:/bin…)라 Homebrew의 svn 등을
// 찾지 못한다 — 일반적인 패키지 매니저 경로를 PATH에 보충한다.
for (const extra of ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin']) {
  if (fs.existsSync(extra) && !(process.env.PATH || '').split(':').includes(extra)) {
    process.env.PATH = `${process.env.PATH || ''}:${extra}`;
  }
}

let PORT = 8890; // set by the mode dispatch at the bottom of this file
const PUBLIC_DIR = path.join(__dirname, 'public');
const HOME = os.homedir();

// ---------- helpers ----------

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function fail(res, code, message) {
  json(res, code, { error: message });
}

// Only allow absolute, normalized paths. This server binds to localhost and
// is a personal tool, but still reject anything that isn't a clean abs path.
function safePath(p) {
  if (typeof p !== 'string' || !p) return null;
  if (!path.isAbsolute(p)) return null;
  const norm = path.normalize(p);
  return norm;
}

// 자식 프로세스 공통 로케일: svn 이 C 로케일에서 한글을 {U+1105}… 로 이스케이프하는 것 방지.
// (앱 번들/launchd 로 뜨면 LANG 이 비어 있어 svn 메시지·경로의 비ASCII 가 전부 깨진다)
const UTF8_ENV = { LANG: 'ko_KR.UTF-8', LC_ALL: 'ko_KR.UTF-8' };

function execFileP(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...UTF8_ENV, ...(opts.env || {}) };
    execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024, ...opts, env }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || '') + (stdout || '') || err.message));
      else resolve(stdout + (stderr || ''));
    });
  });
}

// walk up from dir looking for a marker (.git / .svn)
function findRoot(dir, marker) {
  let p = dir;
  for (;;) {
    if (fs.existsSync(path.join(p, marker))) return p;
    const parent = path.dirname(p);
    if (parent === p) return null;
    p = parent;
  }
}

async function statEntry(dir, name) {
  const full = path.join(dir, name);
  let st;
  try {
    st = await fsp.stat(full); // follow symlinks for type/size
  } catch {
    try {
      st = await fsp.lstat(full); // broken symlink
    } catch {
      return null;
    }
  }
  let lst = null;
  try { lst = await fsp.lstat(full); } catch { /* ignore */ }
  const isDir = st.isDirectory();
  return {
    name,
    path: full,
    isDir,
    size: isDir ? null : st.size,
    mtime: st.mtimeMs,
    ctime: st.birthtimeMs || st.ctimeMs,
    hidden: name.startsWith('.'),
    symlink: !!(lst && lst.isSymbolicLink()),
    ext: isDir ? '' : path.extname(name).slice(1).toLowerCase(),
  };
}

// macOS bookkeeping files — shown only with the separate "system files" toggle
const SYSTEM_JUNK = new Set([
  '.DS_Store', '.localized', 'Icon\r', '.VolumeIcon.icns',
  '.Spotlight-V100', '.Trashes', '.fseventsd', '.TemporaryItems',
  '.DocumentRevisions-V100', '.com.apple.timemachine.donotpresent',
]);
function entryVisible(e, showHidden, showSystem) {
  if (SYSTEM_JUNK.has(e.name)) return showSystem;
  if (e.hidden) return showHidden;
  return true;
}

async function listDir(dir, { showHidden = false, showSystem = false } = {}) {
  const names = await fsp.readdir(dir);
  const entries = await Promise.all(names.map((n) => statEntry(dir, n)));
  return entries.filter((e) => e && entryVisible(e, showHidden, showSystem));
}

// ── Finder-localized display names (게임, 음악, 유틸리티 …) via NSFileManager ──
const JXA_DISPNAMES = `
ObjC.import('Foundation');
function run(argv) {
  const paths = JSON.parse(argv[0]);
  const fm = $.NSFileManager.defaultManager;
  return JSON.stringify(paths.map((p) => fm.displayNameAtPath(p).js));
}`;
const dispNameCache = new Map(); // path -> localized display name (or null)
const openerCache = new Map();   // ext(or path) -> { app, name }

async function localizedNames(paths) {
  const need = paths.filter((p) => !dispNameCache.has(p));
  for (let i = 0; i < need.length; i += 60) {
    const chunk = need.slice(i, i + 60);
    try {
      const out = await execFileP('osascript', ['-l', 'JavaScript', '-e', JXA_DISPNAMES, JSON.stringify(chunk)]);
      const names = JSON.parse(out.trim());
      chunk.forEach((p, j) => dispNameCache.set(p, typeof names[j] === 'string' ? names[j] : null));
    } catch {
      chunk.forEach((p) => dispNameCache.set(p, null));
    }
  }
  return paths.map((p) => dispNameCache.get(p));
}

// entries whose on-screen name Finder localizes: app bundles, and folders
// carrying a .localized marker (Desktop, Documents, Utilities, …)
async function attachDisplayNames(entries) {
  const targets = entries.filter((e) =>
    e.isDir && (e.name.endsWith('.app') || fs.existsSync(path.join(e.path, '.localized'))));
  if (!targets.length) return;
  const names = await localizedNames(targets.map((e) => e.path));
  targets.forEach((e, i) => { if (names[i]) e.dname = names[i]; });
}

// Unique destination name: "file.txt" -> "file copy.txt", "file copy 2.txt", ...
function uniqueDest(dir, name) {
  // existsSync follows symlinks, so it misses occupied names with broken links.
  const exists = (p) => { try { fs.lstatSync(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
  let candidate = path.join(dir, name);
  if (!exists(candidate)) return candidate;
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  candidate = path.join(dir, `${base} copy${ext}`);
  let i = 2;
  while (exists(candidate)) {
    candidate = path.join(dir, `${base} copy ${i}${ext}`);
    i++;
  }
  return candidate;
}

// 볼륨이 추출(마운트 해제) 가능한지: 내장 물리 디스크만 false (외장·DMG·기타는 true)
const volEjectCache = new Map(); // mountpoint -> boolean
let netBrowseCache = null; // { t, servers } — SMB 서버 탐색 캐시(30초)
async function isEjectableVolume(p) {
  if (volEjectCache.has(p)) return volEjectCache.get(p);
  let ejectable = true;
  try {
    const out = await execFileP('diskutil', ['info', '-plist', p], { timeout: 5000 });
    const boolOf = (k) => new RegExp(`<key>${k}</key>\\s*<(true|false)/>`).exec(out)?.[1] === 'true';
    const virtual = /<key>VirtualOrPhysical<\/key>\s*<string>Virtual<\/string>/.test(out);
    const internal = boolOf('Internal');
    const removable = boolOf('RemovableMediaOrExternalDevice') || boolOf('Removable') || boolOf('Ejectable');
    ejectable = virtual || removable || !internal;
  } catch { /* diskutil 실패 시 추출 허용 유지 */ }
  volEjectCache.set(p, ejectable);
  return ejectable;
}

// 폴더 요약: git/svn 저장소 정보 + 프로젝트 종류(열 수 있는 IDE)
async function dirInfo(p) {
  const out = { git: null, svn: null, openers: [] };
  if (fs.existsSync(path.join(p, '.git'))) {
    const g = {};
    try { g.branch = (await execFileP('git', ['-C', p, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5000 })).trim(); } catch { /* */ }
    try { g.remote = (await execFileP('git', ['-C', p, 'remote', 'get-url', 'origin'], { timeout: 5000 })).trim(); } catch { /* */ }
    try { g.last = (await execFileP('git', ['-C', p, 'log', '-1', '--pretty=%h %s'], { timeout: 5000 })).trim(); } catch { /* */ }
    if (g.branch || g.remote) out.git = g;
  }
  if (fs.existsSync(path.join(p, '.svn'))) {
    const v = {};
    try { v.url = (await execFileP('svn', ['info', '--show-item', 'url'], { cwd: p, timeout: 5000 })).trim(); } catch { /* */ }
    try { v.rev = (await execFileP('svn', ['info', '--show-item', 'revision'], { cwd: p, timeout: 5000 })).trim(); } catch { /* */ }
    if (v.url || v.rev) out.svn = v;
  }
  // 프로젝트 감지 → IDE로 열기
  try {
    const names = await fsp.readdir(p);
    const has = (f) => names.includes(f);
    const findExt = (ext) => names.find((n) => n.endsWith(ext));
    const AS = '/Applications/Android Studio.app';
    if ((has('build.gradle') || has('build.gradle.kts') || has('settings.gradle') || has('settings.gradle.kts'))
        && fs.existsSync(AS)) {
      out.openers.push({ label: 'Android Studio로 열기', app: AS, target: p });
    }
    const XC = '/Applications/Xcode.app';
    if (fs.existsSync(XC)) {
      const ws = findExt('.xcworkspace') || findExt('.xcodeproj');
      if (ws) out.openers.push({ label: 'Xcode로 열기', app: XC, target: path.join(p, ws) });
      else if (p.endsWith('.xcodeproj') || p.endsWith('.xcworkspace')) {
        out.openers.push({ label: 'Xcode로 열기', app: XC, target: p });
      }
    }
  } catch { /* ignore */ }
  return out;
}

// Move to macOS Trash (reversible) via Finder.
async function moveToTrash(paths) {
  const lines = paths.map(
    (p) => `move (POSIX file ${JSON.stringify(p)} as alias) to trash`
  );
  const script = `tell application "Finder"\n${lines.join('\n')}\nend tell`;
  await execFileP('osascript', ['-e', script]);
}

async function copyRecursive(src, dest) {
  await fsp.cp(src, dest, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
}

// A failed item must not prevent the rest of a selection from being transferred.
async function transferItems(op, paths, destDir) {
  const results = [];
  const marker = cutMarker;
  for (const src of [...new Set(paths)]) {
    let dest;
    try {
      await fsp.lstat(src);
      if (op === 'move' && path.dirname(src) === destDir) {
        results.push({ source: src, destination: src, status: 'skipped' });
        continue;
      }
      dest = uniqueDest(destDir, path.basename(src));
      if (op === 'copy') await copyRecursive(src, dest);
      else {
        try { await fsp.rename(src, dest); }
        catch (e) {
          if (e.code !== 'EXDEV') throw e;
          // Never remove the source unless every entry was copied successfully.
          const staging = await fsp.mkdtemp(path.join(destDir, '.tdfe-move-'));
          try {
            const staged = path.join(staging, 'item');
            await copyRecursive(src, staged);
            await fsp.rename(staged, dest);
            await fsp.rm(src, { recursive: true });
          } finally {
            await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
          }
        }
      }
      results.push({ source: src, destination: dest, status: 'completed' });
      if (op === 'move' && marker && cutMarker === marker) {
        marker.pendingPaths = marker.pendingPaths.filter((p) => p !== src);
      }
    } catch (e) {
      results.push({ source: src, destination: dest, status: 'failed', error: e.message });
    }
  }
  return { ok: results.every((r) => r.status !== 'failed'), results };
}

// Recursive filename search with limits.
async function searchDir(root, query, { showHidden = false, showSystem = false, limit = 500, deadline }) {
  const results = [];
  const q = query.toLowerCase();
  const stack = [root];
  while (stack.length && results.length < limit && Date.now() < deadline) {
    const dir = stack.pop();
    let names;
    try { names = await fsp.readdir(dir); } catch { continue; }
    for (const name of names) {
      if (SYSTEM_JUNK.has(name) && !showSystem) continue;
      if (!showHidden && name.startsWith('.')) continue;
      const full = path.join(dir, name);
      let st;
      try { st = await fsp.lstat(full); } catch { continue; }
      if (name.toLowerCase().includes(q)) {
        results.push({
          name,
          path: full,
          isDir: st.isDirectory(),
          size: st.isDirectory() ? null : st.size,
          mtime: st.mtimeMs,
          hidden: name.startsWith('.'),
          symlink: st.isSymbolicLink(),
          ext: st.isDirectory() ? '' : path.extname(name).slice(1).toLowerCase(),
          parent: dir,
        });
        if (results.length >= limit) break;
      }
      if (st.isDirectory() && !st.isSymbolicLink()) stack.push(full);
    }
  }
  return results;
}

// Folder size (recursive), bounded by deadline.
async function dirSize(root, deadline) {
  let bytes = 0, files = 0, dirs = 0, partial = false;
  const stack = [root];
  while (stack.length) {
    if (Date.now() > deadline) { partial = true; break; }
    const dir = stack.pop();
    let names;
    try { names = await fsp.readdir(dir); } catch { continue; }
    for (const name of names) {
      const full = path.join(dir, name);
      let st;
      try { st = await fsp.lstat(full); } catch { continue; }
      if (st.isDirectory()) { dirs++; stack.push(full); }
      else { files++; bytes += st.size; }
    }
  }
  return { bytes, files, dirs, partial };
}

const appIconCache = new Map(); // `${path}|${size}|${mtime}` -> PNG buffer

// ── native Finder icons via NSWorkspace (JXA) ──
// Renders the exact icon macOS shows for any path, including Assets.car-only
// apps. Cached aggressively: apps per-path, plain files per-extension.
const JXA_ICON = `
ObjC.import('AppKit');
function run(argv) {
  const src = argv[0], out = argv[1], sz = Number(argv[2]);
  const icon = $.NSWorkspace.sharedWorkspace.iconForFile(src);
  const img = $.NSImage.alloc.initWithSize($.NSMakeSize(sz, sz));
  img.lockFocus;
  icon.drawInRectFromRectOperationFraction(
    $.NSMakeRect(0, 0, sz, sz), $.NSMakeRect(0, 0, 0, 0), $.NSCompositingOperationCopy, 1);
  img.unlockFocus;
  const rep = $.NSBitmapImageRep.imageRepWithData(img.TIFFRepresentation);
  const png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary);
  png.writeToFileAtomically(out, true);
  return 'ok';
}`;
const sysIconCache = new Map();   // key -> PNG buffer
const sysIconPending = new Map(); // key -> Promise (dedupe concurrent renders)

async function renderSysIcon(p, size) {
  const px = Math.min(size * 2, 512); // 2x for retina
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'fx-sysicon-'));
  try {
    const out = path.join(tmp, 'icon.png');
    await execFileP('osascript', ['-l', 'JavaScript', '-e', JXA_ICON, p, out, String(px)]);
    return await fsp.readFile(out);
  } finally {
    fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// ── system clipboard (NSPasteboard) interop: Finder ⌘C ↔ app ⌘V both ways ──
const JXA_PB_WRITE = `
ObjC.import('AppKit');
function run(argv) {
  const paths = JSON.parse(argv[0]);
  const pb = $.NSPasteboard.generalPasteboard;
  pb.clearContents;
  const urls = paths.map((p) => $.NSURL.fileURLWithPath(p));
  if (!pb.writeObjects($(urls))) throw new Error('클립보드 쓰기 실패');
  return String(pb.changeCount);
}`;
const JXA_PB_READ = `
ObjC.import('AppKit');
function run() {
  const pb = $.NSPasteboard.generalPasteboard;
  const items = pb.pasteboardItems;
  const out = [];
  for (let i = 0; i < items.count; i++) {
    const s = items.objectAtIndex(i).stringForType('public.file-url');
    if (!s.isNil()) {
      const u = $.NSURL.URLWithString(s);
      if (!u.isNil() && !u.path.isNil()) out.push(u.path.js);
    }
  }
  return JSON.stringify({ paths: out, changeCount: Number(pb.changeCount) });
}`;
// cut-mode marker survives across explorer windows (the pasteboard itself
// carries no cut/copy distinction)
let cutMarker = null; // { paths: [...], pendingPaths: [...], changeCount }
let pasteboardQueue = Promise.resolve();
function withPasteboard(task) {
  const pending = pasteboardQueue.then(task);
  pasteboardQueue = pending.catch(() => {});
  return pending;
}

// Finder merges system app folders into /Applications — do the same.
const MERGE_DIRS = {
  '/Applications': ['/System/Applications'],
  '/Applications/Utilities': ['/System/Applications/Utilities'],
};

const MIME = {
  html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', json: 'application/json',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon',
  bmp: 'image/bmp', avif: 'image/avif', heic: 'image/heic',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', flac: 'audio/flac',
  ogg: 'audio/ogg', aac: 'audio/aac',
  pdf: 'application/pdf', txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 50 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ---------- API handlers ----------

const api = {
  // GET /api/home — home dir + standard sidebar places + mounted volumes
  async home(_req, res) {
    const places = [
      { name: '홈', path: HOME, icon: 'home' },
      { name: '데스크탑', path: path.join(HOME, 'Desktop'), icon: 'desktop' },
      { name: '문서', path: path.join(HOME, 'Documents'), icon: 'documents' },
      { name: '다운로드', path: path.join(HOME, 'Downloads'), icon: 'downloads' },
      { name: '사진', path: path.join(HOME, 'Pictures'), icon: 'pictures' },
      { name: '음악', path: path.join(HOME, 'Music'), icon: 'music' },
      { name: '동영상', path: path.join(HOME, 'Movies'), icon: 'videos' },
      { name: '응용 프로그램', path: '/Applications', icon: 'apps' },
    ].filter((p) => fs.existsSync(p.path));
    let volumes = [];
    try {
      // 네트워크 마운트(smb/afp/nfs/webdav) 구분 — 사이드바에서 별도 그룹으로 표시
      const netMounts = new Set();
      try {
        for (const line of (await execFileP('mount', [])).split('\n')) {
          const mm = / on (.+) \(([^,)]+)/.exec(line);
          if (mm && /smbfs|afpfs|nfs|webdav/i.test(mm[2])) netMounts.add(mm[1].trim());
        }
      } catch { /* ignore */ }
      volumes = (await listDir('/Volumes', { showHidden: false }))
        .filter((e) => e.isDir)
        .map((e) => ({ name: e.name, path: e.path, icon: 'drive', net: netMounts.has(e.path) }));
      // 내장(기본) 볼륨은 추출 대상이 아님 — diskutil로 판별(결과 캐시)
      await Promise.all(volumes.map(async (v) => {
        v.ejectable = v.net ? true : await isEjectableVolume(v.path);
      }));
    } catch { /* ignore */ }
    json(res, 200, {
      home: HOME, places, volumes, root: '/',
      fork: fs.existsSync('/Applications/Fork.app'),
      version: APP_VERSION,
    });
  },

  // GET /api/list?path=&hidden=1
  async list(req, res, q) {
    const dir = safePath(q.get('path'));
    if (!dir) return fail(res, 400, 'invalid path');
    try {
      const entries = await listDir(dir, {
        showHidden: q.get('hidden') === '1',
        showSystem: q.get('system') === '1',
      });
      for (const extra of MERGE_DIRS[dir] || []) {
        try {
          const names = new Set(entries.map((e) => e.name));
          const more = (await listDir(extra, { showHidden: false }))
            .filter((e) => !names.has(e.name));
          entries.push(...more);
        } catch { /* system dir unreadable — skip */ }
      }
      await attachDisplayNames(entries);
      let disk = null;
      try {
        const s = await fsp.statfs(dir);
        disk = { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
      } catch { /* ignore */ }
      json(res, 200, { path: dir, entries, disk });
    } catch (e) {
      fail(res, e.code === 'EACCES' || e.code === 'EPERM' ? 403 : 404, e.message);
    }
  },

  // GET /api/sysicon?path=&size= — the icon macOS/Finder shows for this path
  async sysicon(req, res, q) {
    const p = safePath(q.get('path'));
    if (!p) return fail(res, 400, 'invalid path');
    const size = Math.min(parseInt(q.get('size'), 10) || 64, 512);
    let st;
    try { st = await fsp.stat(p); } catch { return fail(res, 404, 'not found'); }
    const isDir = st.isDirectory();
    const isApp = isDir && p.endsWith('.app');
    const ext = isDir ? '' : path.extname(p).slice(1).toLowerCase();
    // apps & dirs can have custom icons → per-path; plain files → per-extension
    const key = isApp ? `app|${p}|${st.mtimeMs}|${size}`
      : isDir ? `dir|${p}|${size}`
      : `ext|${ext}|${size}`;
    let buf = sysIconCache.get(key);
    if (!buf) {
      let pend = sysIconPending.get(key);
      if (!pend) {
        pend = renderSysIcon(p, size)
          .then((b) => {
            sysIconCache.set(key, b);
            if (sysIconCache.size > 1000) sysIconCache.delete(sysIconCache.keys().next().value);
            return b;
          })
          .finally(() => sysIconPending.delete(key));
        sysIconPending.set(key, pend);
      }
      try { buf = await pend; } catch { return fail(res, 404, 'no icon'); }
    }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=3600' });
    res.end(buf);
  },

  // GET /api/watch?path= — SSE stream: emits an event whenever the folder changes
  async watch(req, res, q) {
    const dir = safePath(q.get('path'));
    if (!dir) return fail(res, 400, 'invalid path');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    let watcher = null;
    try {
      watcher = fs.watch(dir, { persistent: false }, () => {
        res.write('data: change\n\n');
      });
    } catch {
      res.write('data: unwatchable\n\n');
    }
    const ping = setInterval(() => res.write(': ping\n\n'), 30000);
    req.on('close', () => { clearInterval(ping); watcher?.close(); });
  },

  // GET /api/tree?path= — subdirectories only (for sidebar tree expansion)
  async tree(req, res, q) {
    const dir = safePath(q.get('path'));
    if (!dir) return fail(res, 400, 'invalid path');
    try {
      const entries = (await listDir(dir, { showHidden: false }))
        .filter((e) => e.isDir)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      json(res, 200, { path: dir, entries });
    } catch (e) {
      fail(res, 403, e.message);
    }
  },

  // GET /api/search?path=&q=&hidden=1
  async search(req, res, q) {
    const dir = safePath(q.get('path'));
    const query = (q.get('q') || '').trim();
    if (!dir || !query) return fail(res, 400, 'invalid path or query');
    const results = await searchDir(dir, query, {
      showHidden: q.get('hidden') === '1',
      showSystem: q.get('system') === '1',
      limit: 500,
      deadline: Date.now() + 8000,
    });
    json(res, 200, { path: dir, query, results });
  },

  // GET /api/file?path= — raw file content (previews). Supports Range for media.
  async file(req, res, q) {
    const p = safePath(q.get('path'));
    if (!p) return fail(res, 400, 'invalid path');
    let st;
    try { st = await fsp.stat(p); } catch { return fail(res, 404, 'not found'); }
    if (st.isDirectory()) return fail(res, 400, 'is a directory');
    const ext = path.extname(p).slice(1).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (isNaN(start) || isNaN(end) || start > end || end >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${st.size}`,
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(p, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': st.size,
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(p).pipe(res);
    }
  },

  // GET /api/opener?path= — 이 파일을 여는 기본 연결 앱 (경로 + 현지화 이름)
  async opener(req, res, q) {
    const p = safePath(q.get('path'));
    if (!p) return fail(res, 400, 'invalid path');
    const ext = path.extname(p).slice(1).toLowerCase();
    const key = ext || p;
    const cached = openerCache.get(key);
    if (cached) return json(res, 200, cached);
    try {
      const appPath = (await execFileP('osascript', ['-l', 'JavaScript', '-e', `
        ObjC.import('AppKit');
        function run(argv) {
          const app = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.fileURLWithPath(argv[0]));
          return app.isNil() ? '' : app.path.js;
        }`, p], { timeout: 10000 })).trim();
      if (!appPath) return json(res, 200, { app: null });
      const names = await localizedNames([appPath]);
      const out = { app: appPath, name: names[0] || path.basename(appPath, '.app') };
      openerCache.set(key, out);
      json(res, 200, out);
    } catch {
      json(res, 200, { app: null });
    }
  },

  // GET /api/head?path=&limit= — 파일 앞부분을 바이너리 그대로(base64) 반환
  // (텍스트 판별/hex 뷰어용 — /api/text는 utf-8 변환이라 바이너리가 깨짐)
  async head(req, res, q) {
    const p = safePath(q.get('path'));
    if (!p) return fail(res, 400, 'invalid path');
    const limit = Math.min(parseInt(q.get('limit'), 10) || 65536, 262144);
    try {
      const fd = await fsp.open(p, 'r');
      const buf = Buffer.alloc(limit);
      const { bytesRead } = await fd.read(buf, 0, limit, 0);
      await fd.close();
      const st = await fsp.stat(p);
      json(res, 200, {
        b64: buf.subarray(0, bytesRead).toString('base64'),
        size: st.size,
        truncated: st.size > bytesRead,
      });
    } catch (e) { fail(res, 404, e.message); }
  },

  // GET /api/text?path= — first 256KB as text (text preview)
  async text(req, res, q) {
    const p = safePath(q.get('path'));
    if (!p) return fail(res, 400, 'invalid path');
    try {
      const fd = await fsp.open(p, 'r');
      const buf = Buffer.alloc(256 * 1024);
      const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
      await fd.close();
      const st = await fsp.stat(p);
      json(res, 200, {
        text: buf.slice(0, bytesRead).toString('utf-8'),
        truncated: st.size > bytesRead,
      });
    } catch (e) { fail(res, 404, e.message); }
  },

  // GET /api/appicon?path=/Applications/Foo.app&size=64 — real app icon as PNG.
  // Extracts the bundle's .icns (via Info.plist CFBundleIconFile) and converts
  // with sips; falls back to a Quick Look thumbnail. Cached in memory by mtime.
  async appicon(req, res, q) {
    const p = safePath(q.get('path'));
    if (!p || !p.endsWith('.app')) return fail(res, 400, 'not an app bundle');
    const size = Math.min(parseInt(q.get('size'), 10) || 64, 512);
    let st;
    try { st = await fsp.stat(p); } catch { return fail(res, 404, 'not found'); }
    const key = `${p}|${size}|${st.mtimeMs}`;
    const cached = appIconCache.get(key);
    if (cached) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=3600' });
      return res.end(cached);
    }

    // locate the .icns file
    let icns = null;
    try {
      const name = (await execFileP('plutil', [
        '-extract', 'CFBundleIconFile', 'raw', '-o', '-',
        path.join(p, 'Contents/Info.plist'),
      ])).trim();
      if (name) {
        const c = path.join(p, 'Contents/Resources', name.endsWith('.icns') ? name : name + '.icns');
        if (fs.existsSync(c)) icns = c;
      }
    } catch { /* key missing */ }
    if (!icns) {
      try {
        const files = await fsp.readdir(path.join(p, 'Contents/Resources'));
        const f = files.find((n) => n.endsWith('.icns'));
        if (f) icns = path.join(p, 'Contents/Resources', f);
      } catch { /* no Resources */ }
    }

    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'fx-appicon-'));
    try {
      const out = path.join(tmp, 'icon.png');
      if (icns) {
        await execFileP('sips', ['-s', 'format', 'png', '-Z', String(size), icns, '--out', out]);
      } else {
        // modern apps with Assets.car only: Quick Look renders the icon
        await execFileP('qlmanage', ['-t', '-s', String(size), '-o', tmp, p]);
        await fsp.rename(path.join(tmp, path.basename(p) + '.png'), out);
      }
      const buf = await fsp.readFile(out);
      appIconCache.set(key, buf);
      if (appIconCache.size > 300) appIconCache.delete(appIconCache.keys().next().value);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=3600' });
      res.end(buf);
    } catch {
      fail(res, 404, 'no icon');
    } finally {
      fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  },

  // GET /api/thumb?path=&size= — Quick Look thumbnail via qlmanage
  async thumb(req, res, q) {
    const p = safePath(q.get('path'));
    if (!p) return fail(res, 400, 'invalid path');
    const size = Math.min(parseInt(q.get('size'), 10) || 128, 512);
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'fx-thumb-'));
    try {
      await execFileP('qlmanage', ['-t', '-s', String(size), '-o', tmp, p]);
      const out = path.join(tmp, path.basename(p) + '.png');
      const buf = await fsp.readFile(out);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=300' });
      res.end(buf);
    } catch {
      fail(res, 404, 'no thumbnail');
    } finally {
      fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  },

  // GET /api/props?path= — properties dialog data (folder size computed)
  async props(req, res, q) {
    const p = safePath(q.get('path'));
    if (!p) return fail(res, 400, 'invalid path');
    try {
      const st = await fsp.stat(p);
      const lst = await fsp.lstat(p);
      const base = {
        path: p,
        name: path.basename(p) || p,
        isDir: st.isDirectory(),
        size: st.size,
        mtime: st.mtimeMs,
        ctime: st.birthtimeMs || st.ctimeMs,
        atime: st.atimeMs,
        mode: (st.mode & 0o777).toString(8),
        symlink: lst.isSymbolicLink(),
        target: lst.isSymbolicLink() ? await fsp.readlink(p) : null,
      };
      if (st.isDirectory()) {
        base.sizePending = true; // 크기는 /api/dirsize 스트림으로 별도 계산
        Object.assign(base, await dirInfo(p)); // git/svn/프로젝트 요약
      }
      json(res, 200, base);
    } catch (e) { fail(res, 404, e.message); }
  },

  // GET /api/dirinfo?path= — 폴더의 저장소/프로젝트 요약 (미리보기용)
  async dirinfo(req, res, q) {
    const p = safePath(q.get('path'));
    if (!p) return fail(res, 400, 'invalid path');
    json(res, 200, await dirInfo(p));
  },

  // GET /api/dirsize?path= — 폴더 크기를 계산하며 진행 상황을 ndjson으로 스트리밍
  async dirsize(req, res, q) {
    const p = safePath(q.get('path'));
    if (!p) return fail(res, 400, 'invalid path');
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
    let bytes = 0, files = 0, dirs = 0, closed = false, lastEmit = 0;
    req.on('close', () => { closed = true; });
    const stack = [p];
    while (stack.length && !closed) {
      const dir = stack.pop();
      let names;
      try { names = await fsp.readdir(dir); } catch { continue; }
      for (const name of names) {
        const full = path.join(dir, name);
        let st;
        try { st = await fsp.lstat(full); } catch { continue; }
        if (st.isDirectory()) { dirs++; stack.push(full); }
        else { files++; bytes += st.size; }
      }
      const now = Date.now();
      if (now - lastEmit > 300) {
        lastEmit = now;
        res.write(`${JSON.stringify({ bytes, files, dirs, done: false })}\n`);
      }
    }
    res.end(`${JSON.stringify({ bytes, files, dirs, done: !closed })}\n`);
  },

  // GET /api/pasteboard — file references currently on the macOS clipboard
  async pasteboard(req, res) {
    return withPasteboard(async () => {
      let snapshot;
      try {
        snapshot = JSON.parse((await execFileP('osascript', ['-l', 'JavaScript', '-e', JXA_PB_READ], { timeout: 10000 })).trim());
      } catch { return json(res, 200, { paths: [], cut: false, readable: false }); }
      const paths = snapshot.paths.filter((p) => typeof p === 'string' && path.isAbsolute(p));
      // NSURL decomposes Korean/other Unicode names. Compare canonically but
      // retain the original selected paths for filesystem operations.
      const canonicalPaths = new Set(paths.map((p) => p.normalize('NFC')));
      const cut = !!(cutMarker && cutMarker.changeCount === snapshot.changeCount && paths.length &&
        cutMarker.paths.length === paths.length &&
        cutMarker.paths.every((p) => canonicalPaths.has(p.normalize('NFC'))));
      json(res, 200, { paths: cut ? cutMarker.pendingPaths : paths, cut, readable: true });
    });
  },

  // POST /api/upload?dir=&name= — raw body → file (Finder drag-drop copy-in).
  // `name` may contain subdirectories for folder drops.
  async upload(req, res, q) {
    const dir = safePath(q.get('dir'));
    const rel = (q.get('name') || '').replace(/^\/+/, '');
    if (!dir || !rel || rel.split('/').some((s) => s === '..' || s === '')) {
      req.resume();
      return fail(res, 400, 'invalid upload target');
    }
    const target = path.join(dir, rel);
    if (!target.startsWith(dir + '/')) { req.resume(); return fail(res, 400, 'invalid path'); }
    try {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const dest = fs.existsSync(target)
        ? uniqueDest(path.dirname(target), path.basename(target))
        : target;
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(dest, { flags: 'wx' });
        req.pipe(ws);
        ws.on('finish', resolve);
        ws.on('error', reject);
        req.on('error', reject);
      });
      json(res, 200, { ok: true, path: target });
    } catch (e) {
      fail(res, 500, e.message);
    }
  },

  // GET /api/netbrowse — Bonjour(_smb._tcp)로 네트워크의 SMB 서버 탐색
  async netbrowse(req, res) {
    const now = Date.now();
    if (netBrowseCache && now - netBrowseCache.t < 30000) {
      return json(res, 200, { servers: netBrowseCache.servers });
    }
    const out = await new Promise((resolve) => {
      let buf = '';
      let child;
      try { child = spawn('dns-sd', ['-B', '_smb._tcp', 'local.']); }
      catch { return resolve(''); }
      child.stdout.on('data', (d) => { buf += d; });
      child.on('error', () => resolve(buf));
      setTimeout(() => { try { child.kill(); } catch { /* */ } resolve(buf); }, 1300);
    });
    const servers = new Set();
    for (const line of out.split('\n')) {
      const cols = line.trim().split(/\s+/);
      // "<time> Add <flags> <if> local. _smb._tcp. <Instance Name...>"
      const i = cols.indexOf('_smb._tcp.');
      if (cols[1] === 'Add' && i > 0 && cols.length > i + 1) {
        servers.add(cols.slice(i + 1).join(' '));
      }
    }
    netBrowseCache = { t: now, servers: [...servers].sort() };
    json(res, 200, { servers: netBrowseCache.servers });
  },

  // GET /api/vcs?path=dir — git/svn detection + working-copy status for badges
  async vcs(req, res, q) {
    const dir = safePath(q.get('path'));
    if (!dir) return fail(res, 400, 'invalid path');
    const out = {};
    const gitRoot = findRoot(dir, '.git');
    if (gitRoot) {
      try {
        const branch = (await execFileP('git', ['-C', gitRoot, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim();
        const st = await execFileP('git', ['-C', gitRoot, '-c', 'core.quotepath=false', 'status', '--porcelain']);
        const statuses = {};
        for (const line of st.split('\n')) {
          if (!line) continue;
          const code = line.slice(0, 2);
          let rel = line.slice(3);
          if (rel.includes(' -> ')) rel = rel.split(' -> ')[1];
          statuses[path.join(gitRoot, rel.replace(/\/$/, ''))] = code;
        }
        out.git = { root: gitRoot, branch, statuses };
      } catch { /* git missing or broken repo — hide */ }
    }
    const svnRoot = findRoot(dir, '.svn');
    if (svnRoot) {
      try {
        const st = await execFileP('svn', ['status'], { cwd: svnRoot });
        const statuses = {};
        const locks = {}; // 6번째 칼럼: K=내 잠금, O=타인, T=탈취됨, B=깨짐
        for (const line of st.split('\n')) {
          const m = /^([MADR?!C~])[ MCL+SKX]{0,7}\s+(.+)$/.exec(line);
          if (m) statuses[path.resolve(svnRoot, m[2])] = m[1] + ' ';
          const lk = /^.{5}([KOTB])[ C]?\s+(.+)$/.exec(line);
          if (lk) locks[path.resolve(svnRoot, lk[2])] = lk[1];
        }
        let url = null;
        try {
          url = (await execFileP('svn', ['info', '--show-item', 'url'], { cwd: svnRoot })).trim() || null;
        } catch { /* ignore */ }
        out.svn = { root: svnRoot, statuses, locks, url };
      } catch { /* svn binary missing — hide */ }
    }
    json(res, 200, out);
  },

  // GET /api/gitgraph?root= — commit graph + branch list for the graph view
  async gitgraph(req, res, q) {
    const root = safePath(q.get('root'));
    if (!root) return fail(res, 400, 'invalid root');
    try {
      const branchOut = await execFileP('git', ['-C', root, 'branch', '-a', '--no-color']);
      const branches = [];
      for (const line of branchOut.split('\n')) {
        if (!line.trim() || line.includes('->')) continue; // skip HEAD alias
        const current = line.startsWith('*');
        let name = line.replace(/^\*?\s+/, '').trim();
        const remote = name.startsWith('remotes/');
        if (remote) name = name.slice(8);
        branches.push({ name, current, remote });
      }
      let tags = [];
      try {
        tags = (await execFileP('git', ['-C', root, 'tag', '--list']))
          .split('\n').map((t) => t.trim()).filter(Boolean);
      } catch { /* ignore */ }
      let commits = [];
      try {
        const out = await execFileP('git', [
          '-C', root, 'log', '--all', '--date-order', '--no-color',
          '--pretty=format:%H%x09%P%x09%D%x09%an%x09%at%x09%s', '-100',
        ]);
        commits = out.split('\n').filter(Boolean).map((l) => {
          const [hash, parents, refs, author, date, ...s] = l.split('\t');
          return {
            hash,
            parents: parents ? parents.split(' ') : [],
            refs: refs ? refs.split(', ').filter(Boolean) : [],
            author, date,
            subject: s.join('\t'),
          };
        });
      } catch { /* empty repo */ }
      json(res, 200, { branches, tags, commits });
    } catch (e) {
      fail(res, 500, e.message);
    }
  },

  // GET /api/gitshow?root=&hash= — files changed by one commit
  async gitshow(req, res, q) {
    const root = safePath(q.get('root'));
    const hash = q.get('hash') || '';
    if (!root || !/^[0-9a-f]{7,40}$/.test(hash)) return fail(res, 400, 'invalid');
    try {
      const out = await execFileP('git', [
        '-C', root, '-c', 'core.quotepath=false',
        'show', '--name-status', '--pretty=format:', hash,
      ]);
      const changed = [];
      for (const line of out.split('\n')) {
        const m = /^([A-Z])\d*\t(.+)$/.exec(line);
        if (m) {
          const parts = m[2].split('\t'); // renames: old<TAB>new
          changed.push({ action: m[1], path: parts[parts.length - 1] });
        }
      }
      json(res, 200, { changed });
    } catch (e) {
      fail(res, 500, e.message);
    }
  },

  // GET /api/svnlog?root=&limit=&before=&from=&to= — structured svn log.
  // `before`: page downward from that revision; `from`/`to`: YYYY-MM-DD range.
  async svnlog(req, res, q) {
    const root = safePath(q.get('root'));
    if (!root) return fail(res, 400, 'invalid root');
    const limit = Math.min(parseInt(q.get('limit'), 10) || 100, 500);
    const before = q.get('before');
    const from = q.get('from'), to = q.get('to');
    const dateOk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
    let hi = 'HEAD', lo = '1';
    if (to && dateOk(to)) hi = `{${to} 23:59:59}`;
    if (from && dateOk(from)) lo = `{${from}}`;
    if (before && /^\d+$/.test(before)) hi = before; // paging overrides the upper bound
    try {
      const xml = await execFileP('svn',
        ['log', '--xml', '-v', '-l', String(limit), '-r', `${hi}:${lo}`], { cwd: root });
      const unesc = (s) => s
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
      const entries = [];
      const re = /<logentry\s+revision="(\d+)">([\s\S]*?)<\/logentry>/g;
      let m;
      while ((m = re.exec(xml))) {
        const body = m[2];
        const g = (tag) => {
          const mm = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(body);
          return mm ? unesc(mm[1]) : '';
        };
        const changed = [];
        const pre = /<path[^>]*\baction="([A-Z])"[^>]*>([^<]*)<\/path>/g;
        let pm;
        while ((pm = pre.exec(body))) changed.push({ action: pm[1], path: unesc(pm[2]) });
        entries.push({ rev: +m[1], author: g('author'), date: g('date'), msg: g('msg'), changed });
      }
      let current = null;
      try {
        const cur = parseInt((await execFileP('svn', ['info', '--show-item', 'revision'], { cwd: root })).trim(), 10);
        current = Number.isFinite(cur) ? cur : null;
      } catch { /* ignore */ }
      json(res, 200, { entries, current, hasMore: entries.length >= limit });
    } catch (e) {
      fail(res, 500, e.message);
    }
  },

  // POST /api/vcsop  { tool, action, root, paths?, message?, branch?, rev? } — whitelisted commands
  async vcsop(req, res) {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return fail(res, 400, 'bad json'); }
    const root = safePath(body.root);
    const paths = (body.paths || []).map(safePath).filter(Boolean);
    const msg = String(body.message || '').slice(0, 4000);
    if (!root) return fail(res, 400, 'invalid root');
    const GIT = {
      pull: ['pull'],
      push: ['push'],
      fetch: ['fetch', '--all'],
      status: ['status'],
      log: ['log', '--oneline', '--graph', '--decorate', '-25'],
      diff: ['diff', '--stat'],
      add: ['add', '--', ...paths],
      unstage: ['restore', '--staged', '--', ...paths],
      discard: ['checkout', '--', ...paths],
      commitAll: null, // handled specially below
      checkout: null,  // handled specially below (branch name validated)
    };
    const SVN = {
      update: ['update'],
      status: ['status'],
      log: ['log', '-l', '15'],
      add: ['add', ...paths],
      revert: ['revert', '-R', ...paths],   // recursive: dirs revert everything under them
      revertAll: ['revert', '-R', '.'],     // whole working copy
      commit: ['commit', '-m', msg, ...paths],
      updateRev: null, // handled specially (revision validated)
      lock: ['lock', ...(body.force ? ['--force'] : []), ...(msg ? ['-m', msg] : []), ...paths],
      unlock: ['unlock', ...(body.force ? ['--force'] : []), ...paths],
    };
    try {
      let output;
      if (body.tool === 'git') {
        if (!(body.action in GIT)) return fail(res, 400, 'unknown action');
        if (body.action === 'checkout') {
          const br = String(body.branch || '');
          if (!/^[A-Za-z0-9][A-Za-z0-9._/@-]*$/.test(br)) return fail(res, 400, '잘못된 브랜치 이름');
          output = await execFileP('git', ['-C', root, 'checkout', br]);
        } else if (body.action === 'commitAll') {
          if (!msg) return fail(res, 400, '커밋 메시지가 필요합니다');
          await execFileP('git', ['-C', root, 'add', '-A']);
          output = await execFileP('git', ['-C', root, 'commit', '-m', msg]);
        } else if (['add', 'unstage', 'discard'].includes(body.action) && !paths.length) {
          return fail(res, 400, 'no paths');
        } else {
          output = await execFileP('git', ['-C', root, ...GIT[body.action]]);
        }
      } else if (body.tool === 'svn') {
        if (!(body.action in SVN)) return fail(res, 400, 'unknown action');
        if (body.action === 'commit' && !msg) return fail(res, 400, '커밋 메시지가 필요합니다');
        if (['add', 'revert', 'lock', 'unlock'].includes(body.action) && !paths.length) return fail(res, 400, 'no paths');
        if (body.action === 'updateRev') {
          const rev = String(body.rev || '');
          if (!/^(\d+|HEAD)$/.test(rev)) return fail(res, 400, '잘못된 리비전');
          output = await execFileP('svn', ['update', '-r', rev], { cwd: root });
        } else {
          output = await execFileP('svn', SVN[body.action], { cwd: root });
        }
      } else return fail(res, 400, 'unknown tool');
      json(res, 200, { ok: true, output: output || '(출력 없음)' });
    } catch (e) {
      fail(res, 500, e.message);
    }
  },

  // POST /api/vcsstream — run a long VCS command and stream its output live.
  // The response body is raw stdout+stderr (git --progress uses \r updates),
  // terminated by a "__DONE__:<exitcode>" line. Closing the request kills the child.
  async vcsstream(req, res) {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return fail(res, 400, 'bad json'); }
    const root = safePath(body.root);
    const msg = String(body.message || '').slice(0, 4000);
    const rev = String(body.rev || '');
    const branch = String(body.branch || '');
    const url = String(body.url || '').trim();
    if (!root) return fail(res, 400, 'invalid root');
    const urlOk = /^(https?:\/\/|git@|ssh:\/\/|svn:\/\/|svn\+ssh:\/\/|file:\/\/)\S+$/.test(url);
    let cmd, preArgs = null, args;
    if (body.tool === 'git') {
      cmd = 'git';
      switch (body.action) {
        case 'pull': args = ['-C', root, 'pull', '--progress']; break;
        case 'push': args = ['-C', root, 'push', '--progress']; break;
        case 'fetch': args = ['-C', root, 'fetch', '--all', '--progress']; break;
        case 'checkout':
          if (!/^[A-Za-z0-9][A-Za-z0-9._/@-]*$/.test(branch)) return fail(res, 400, '잘못된 브랜치 이름');
          args = ['-C', root, 'checkout', '--progress', branch];
          break;
        case 'commitAll':
          if (!msg) return fail(res, 400, '커밋 메시지가 필요합니다');
          preArgs = ['-C', root, 'add', '-A'];
          args = ['-C', root, 'commit', '-m', msg];
          break;
        case 'clone':
          if (!urlOk) return fail(res, 400, '잘못된 저장소 URL');
          args = ['-C', root, 'clone', '--progress', url];
          break;
        default: return fail(res, 400, 'unknown action');
      }
    } else if (body.tool === 'svn') {
      cmd = 'svn';
      switch (body.action) {
        case 'update': args = ['update']; break;
        case 'updateRev':
          if (!/^(\d+|HEAD)$/.test(rev)) return fail(res, 400, '잘못된 리비전');
          args = ['update', '-r', rev];
          break;
        case 'commit':
          if (!msg) return fail(res, 400, '커밋 메시지가 필요합니다');
          args = ['commit', '-m', msg];
          break;
        case 'revertAll': args = ['revert', '-R', '.']; break;
        case 'switch':
          if (!urlOk) return fail(res, 400, '잘못된 저장소 URL');
          args = ['switch', url];
          break;
        case 'cleanup': {
          // TortoiseSVN식 옵션 조합: 기본 정리(잠금 해제)와 삭제 작업을 순차 실행
          const ext2 = body.externals ? ['--include-externals'] : [];
          const flags = [];
          if (body.removeUnversioned) flags.push('--remove-unversioned');
          if (body.removeIgnored) flags.push('--remove-ignored');
          if (body.vacuum) flags.push('--vacuum-pristines');
          if (body.basic && flags.length) {
            preArgs = ['cleanup', ...ext2];
            args = ['cleanup', ...flags, ...ext2];
          } else if (flags.length) {
            args = ['cleanup', ...flags, ...ext2];
          } else {
            args = ['cleanup', ...ext2];
          }
          break;
        }
        case 'checkout':
          if (!urlOk) return fail(res, 400, '잘못된 저장소 URL');
          args = ['checkout', url];
          break;
        default: return fail(res, 400, 'unknown action');
      }
    } else return fail(res, 400, 'unknown tool');

    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    const runOne = (a) => new Promise((resolve) => {
      const child = spawn(cmd, a, { cwd: root, env: { ...process.env, ...UTF8_ENV, GIT_TERMINAL_PROMPT: '0' } });
      child.stdout.on('data', (d) => res.write(d));
      child.stderr.on('data', (d) => res.write(d));
      child.on('close', (code) => resolve(code ?? 1));
      child.on('error', (e) => { res.write(`오류: ${e.message}\n`); resolve(127); });
      req.on('close', () => child.kill('SIGTERM'));
    });
    let code = 0;
    if (preArgs) code = await runOne(preArgs);
    if (code === 0) code = await runOne(args);
    res.end(`\n__DONE__:${code}\n`);
  },

  // POST /api/op  { op, ... }
  async op(req, res) {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return fail(res, 400, 'bad json'); }
    const op = body.op;
    try {
      switch (op) {
        case 'mkdir': {
          const dir = safePath(body.dir);
          if (!dir) throw new Error('invalid dir');
          let name = body.name || '새 폴더';
          let dest = path.join(dir, name);
          let i = 2;
          while (fs.existsSync(dest)) dest = path.join(dir, `${name} ${i++}`);
          await fsp.mkdir(dest);
          return json(res, 200, { ok: true, path: dest });
        }
        case 'newfile': {
          const dir = safePath(body.dir);
          if (!dir) throw new Error('invalid dir');
          let name = body.name || '새 파일.txt';
          const ext = path.extname(name);
          const base = path.basename(name, ext);
          let dest = path.join(dir, name);
          let i = 2;
          while (fs.existsSync(dest)) dest = path.join(dir, `${base} ${i++}${ext}`);
          await fsp.writeFile(dest, '', { flag: 'wx' });
          return json(res, 200, { ok: true, path: dest });
        }
        case 'rename': {
          const src = safePath(body.path);
          const newName = body.name;
          if (!src || !newName || newName.includes('/')) throw new Error('invalid rename');
          const dest = path.join(path.dirname(src), newName);
          if (fs.existsSync(dest) && dest !== src) throw new Error('같은 이름의 항목이 이미 있습니다');
          await fsp.rename(src, dest);
          return json(res, 200, { ok: true, path: dest });
        }
        case 'trash': {
          const paths = (body.paths || []).map(safePath).filter(Boolean);
          if (!paths.length) throw new Error('no paths');
          await moveToTrash(paths);
          return json(res, 200, { ok: true });
        }
        case 'copy':
        case 'move': {
          const destDir = safePath(body.dest);
          const paths = (body.paths || []).map(safePath).filter(Boolean);
          if (!destDir || !paths.length) throw new Error(`invalid ${op}`);
          return json(res, 200, await transferItems(op, paths, destDir));
        }
        case 'open': {
          const p = safePath(body.path);
          if (!p) throw new Error('invalid path');
          await execFileP('open', [p]);
          return json(res, 200, { ok: true });
        }
        case 'openWith': {
          const p = safePath(body.path);
          if (!p) throw new Error('invalid path');
          // Show the macOS "Open With" via Finder is not scriptable simply;
          // open -a TextEdit style requires app name. Fallback: reveal.
          await execFileP('open', ['-R', p]);
          return json(res, 200, { ok: true });
        }
        case 'reveal': {
          const p = safePath(body.path);
          if (!p) throw new Error('invalid path');
          await execFileP('open', ['-R', p]);
          return json(res, 200, { ok: true });
        }
        case 'setPasteboard': {
          return withPasteboard(async () => {
            const paths = (body.paths || []).map(safePath).filter(Boolean);
            if (!paths.length) throw new Error('no paths');
            const out = await execFileP('osascript', ['-l', 'JavaScript', '-e', JXA_PB_WRITE, JSON.stringify(paths)], { timeout: 10000 });
            const changeCount = Number(out.trim());
            if (!Number.isInteger(changeCount)) throw new Error('클립보드 쓰기 실패');
            cutMarker = body.mode === 'cut' ? { paths, pendingPaths: [...paths], changeCount } : null;
            return json(res, 200, { ok: true });
          });
        }
        case 'openApp': {
          // 지정한 /Applications 앱으로 대상 열기 (dirinfo가 알려준 조합만)
          const app = safePath(body.app);
          const target = safePath(body.target);
          if (!app || !app.startsWith('/Applications/') || !app.endsWith('.app') || !target)
            throw new Error('잘못된 요청');
          await execFileP('open', ['-a', app, target], { timeout: 20000 });
          return json(res, 200, { ok: true });
        }
        case 'openNet': {
          const url = String(body.url || '').trim();
          if (!/^(smb|afp|nfs|cifs):\/\/\S+$/i.test(url))
            throw new Error('smb:// 형식의 주소가 아닙니다');
          await execFileP('open', [url], { timeout: 20000 });
          return json(res, 200, { ok: true });
        }
        case 'mountNet': {
          // Finder 경유 마운트: 자격 증명이 필요하면 시스템 인증 창이 뜬다
          const url = String(body.url || '').trim();
          if (!/^(smb|afp|nfs|cifs):\/\/\S+$/i.test(url))
            throw new Error('smb:// afp:// nfs:// 형식의 주소를 입력하세요');
          await execFileP('osascript', ['-e', `mount volume ${JSON.stringify(url)}`], { timeout: 90000 });
          return json(res, 200, { ok: true });
        }
        case 'eject': {
          const p = safePath(body.path);
          if (!p || !p.startsWith('/Volumes/') || p === '/Volumes')
            throw new Error('볼륨만 추출할 수 있습니다');
          // Finder first (works from any session context, like our Trash op),
          // then hdiutil (DMG mounts) and diskutil (physical disks) as fallbacks.
          const volName = path.basename(p);
          const finderEject = ['osascript', ['-e',
            `tell application "Finder" to eject disk ${JSON.stringify(volName)}`]];
          const attempts = body.force
            ? [['hdiutil', ['detach', '-force', p]], ['diskutil', ['unmountDisk', 'force', p]], finderEject]
            : [finderEject, ['hdiutil', ['detach', p]], ['diskutil', ['eject', p]], ['diskutil', ['unmount', p]]];
          let lastErr = null;
          for (const [c, a] of attempts) {
            try {
              await execFileP(c, a, { timeout: 30000 });
              return json(res, 200, { ok: true });
            } catch (e) { lastErr = e; }
          }
          throw lastErr || new Error('추출 실패');
        }
        case 'fork': {
          const p = safePath(body.path);
          if (!p) throw new Error('invalid path');
          try { await execFileP('open', ['-a', 'Fork', p]); }
          catch { throw new Error('Fork가 설치되어 있지 않습니다'); }
          return json(res, 200, { ok: true });
        }
        case 'vscode': {
          const p = safePath(body.path);
          if (!p) throw new Error('invalid path');
          try {
            await execFileP('open', ['-a', 'Visual Studio Code', p]);
          } catch {
            try { await execFileP('open', ['-b', 'com.microsoft.VSCode', p]); }
            catch { throw new Error('Visual Studio Code가 설치되어 있지 않습니다'); }
          }
          return json(res, 200, { ok: true });
        }
        case 'terminal': {
          const p = safePath(body.path);
          if (!p) throw new Error('invalid path');
          await execFileP('open', ['-a', 'Terminal', p]);
          return json(res, 200, { ok: true });
        }
        case 'writeText': {
          const p = safePath(body.path);
          if (!p) throw new Error('invalid path');
          await fsp.writeFile(p, String(body.content ?? ''), 'utf-8');
          return json(res, 200, { ok: true });
        }
        default:
          return fail(res, 400, `unknown op: ${op}`);
      }
    } catch (e) {
      return fail(res, 500, e.message);
    }
  },
};

// ---------- static + routing ----------

// When packaged as a Node SEA single executable, the UI files are embedded
// as SEA assets instead of living on disk next to the binary.
let sea = null;
try {
  const s = require('node:sea');
  if (s.isSea && s.isSea()) sea = s;
} catch { /* not packaged */ }

let APP_VERSION = 'dev';
try {
  APP_VERSION = sea
    ? Buffer.from(sea.getAsset('VERSION')).toString('utf-8').trim()
    : fs.readFileSync(path.join(__dirname, 'VERSION'), 'utf-8').trim();
} catch { /* keep 'dev' */ }

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const ext = path.extname(rel).slice(1).toLowerCase();
  if (sea) {
    try {
      const buf = Buffer.from(sea.getAsset(rel.replace(/^\//, '')));
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      return res.end(buf);
    } catch {
      return fail(res, 404, 'not found');
    }
  }
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR)) return fail(res, 403, 'forbidden');
  fs.readFile(file, (err, buf) => {
    if (err) return fail(res, 404, 'not found');
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(buf);
  });
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const q = url.searchParams;
  try {
    if (url.pathname.startsWith('/api/')) {
      const name = url.pathname.slice(5);
      const handler = api[name];
      if (!handler) return fail(res, 404, 'unknown api');
      await handler(req, res, q);
    } else {
      serveStatic(req, res, url.pathname);
    }
  } catch (e) {
    if (!res.headersSent) fail(res, 500, e.message);
  }
}

function startServer(port) {
  PORT = port;
  const server = http.createServer(handleRequest);
  server.on('error', (e) => { console.error(e.message); process.exit(1); });
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`FileExplorer running at http://127.0.0.1:${PORT}`);
  });
}

// ---------- app/launcher mode (SEA binary double-clicked from Finder) ----------

function probe(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/home', timeout: 700 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function openBrowser(port) {
  const url = `http://127.0.0.1:${port}/`;
  if (fs.existsSync('/Applications/Google Chrome.app')) {
    execFile('open', ['-na', 'Google Chrome', '--args', `--app=${url}`], () => {});
  } else {
    execFile('open', [url], () => {});
  }
}

async function launcher(port) {
  if (!(await probe(port))) {
    // spawn a detached copy of ourselves as the server, then exit —
    // so the .app is relaunchable while the server keeps running
    const selfArgs = sea ? ['--serve', String(port)] : [process.argv[1], '--serve', String(port)];
    spawn(process.execPath, selfArgs, { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 25; i++) {
      if (await probe(port)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  openBrowser(port);
  process.exit(0);
}

// ---------- mode dispatch ----------
const argv = process.argv.slice(2);
if (argv[0] === '--serve') startServer(parseInt(argv[1], 10) || 8890);
else if (argv[0] && /^\d+$/.test(argv[0])) startServer(parseInt(argv[0], 10)); // node server.js 8890
else if (sea) launcher(8890); // Finder에서 앱 더블클릭
else startServer(8890); // dev: node server.js
