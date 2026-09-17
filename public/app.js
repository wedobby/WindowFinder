'use strict';

/* ══════════ state ══════════ */
const state = {
  cwd: null,
  entries: [],        // raw entries from server
  sorted: [],         // sorted view
  selection: new Set(), // selected paths
  anchor: -1,         // index in sorted for shift-select
  focusIdx: -1,       // keyboard focus index
  history: [],
  histIdx: -1,
  clipboard: null,    // { mode: 'copy'|'cut', paths: [] }
  viewMode: localStorage.getItem('fx.view') || 'details', // details | lg | md | list
  sortKey: localStorage.getItem('fx.sortKey') || 'name',
  sortDir: localStorage.getItem('fx.sortDir') || 'asc',
  showHidden: localStorage.getItem('fx.hidden') === '1',
  showSystem: localStorage.getItem('fx.system') === '1',
  previewOn: localStorage.getItem('fx.preview') === '1',
  previewPretty: localStorage.getItem('fx.pretty') !== '0', // 기본 켬
  previewMdRaw: localStorage.getItem('fx.mdraw') === '1',
  previewSheetRaw: localStorage.getItem('fx.sheetraw') === '1', // tsv/csv: 기본 그리드 뷰
  previewWrap: localStorage.getItem('fx.wrap') !== '0', // 줄바꿈 기본 켬
  theme: localStorage.getItem('fx.theme') || 'system',
  searchMode: false,
  home: null,
  renaming: false,
  vcs: null,          // { git: {root, branch, statuses, dirSet}, svn: {...} }
  favs: JSON.parse(localStorage.getItem('fx.favs') || '[]'), // [{name, path}]
};

const $ = (id) => document.getElementById(id);
const fileArea = $('fileArea'), fileList = $('fileList');

/* ══════════ 테마 ══════════ */
const THEMES = [
  ['system', '시스템 기본'], ['light', '화이트'], ['dark', '다크'],
  ['blue', '라이트 블루'], ['red', '라이트 레드'], ['gray', '그레이'],
];
function applyTheme() {
  if (state.theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', state.theme);
}
applyTheme();

/* ══════════ api ══════════ */
async function apiGet(name, params) {
  const q = new URLSearchParams(params);
  const r = await fetch(`/api/${name}?${q}`);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'error');
  return j;
}
async function apiOp(body) {
  const r = await fetch('/api/op', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'error');
  if (j.results && !j.ok && !body.reportResults) {
    refresh();
    const failed = j.results.filter((x) => x.status === 'failed');
    const completed = j.results.filter((x) => x.status === 'completed');
    throw new Error(`${completed.length}개 완료, ${failed.length}개 실패: ${failed.map((x) => `${x.source}: ${x.error}`).join('\n')}`);
  }
  return j;
}

/* ══════════ formatting ══════════ */
function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
// Korean relative time: "방금 전", "5분 전", "3시간 전", "2일 전", then absolute
function fmtRel(unixSec) {
  const s = Math.max(0, Date.now() / 1000 - unixSec);
  if (s < 60) return '방금 전';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}일 전`;
  return fmtDate(unixSec * 1000);
}
function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  const ampm = d.getHours() < 12 ? '오전' : '오후';
  const h12 = d.getHours() % 12 || 12;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${ampm} ${h12}:${p(d.getMinutes())}`;
}

const EXT_KIND = {
  png: 'img', jpg: 'img', jpeg: 'img', gif: 'img', webp: 'img', svg: 'img',
  bmp: 'img', ico: 'img', heic: 'img', avif: 'img', tiff: 'img',
  mp4: 'vid', mov: 'vid', webm: 'vid', avi: 'vid', mkv: 'vid', m4v: 'vid',
  mp3: 'aud', m4a: 'aud', wav: 'aud', flac: 'aud', aac: 'aud', ogg: 'aud',
  pdf: 'pdf',
  js: 'code', ts: 'code', jsx: 'code', tsx: 'code', py: 'code', rb: 'code',
  java: 'code', c: 'code', cpp: 'code', h: 'code', cs: 'code', go: 'code',
  rs: 'code', swift: 'code', kt: 'code', php: 'code', css: 'code', lua: 'code',
  sh: 'code', zsh: 'code', bash: 'code', command: 'code',
  bat: 'code', cmd: 'code', ps1: 'code', ini: 'code', conf: 'code', plist: 'code',
  html: 'code', json: 'code', jsonc: 'code', jsonl: 'code', json5: 'code',
  xml: 'code', yml: 'code', yaml: 'code', toml: 'code', sql: 'code',
  txt: 'txt', md: 'txt', log: 'txt', csv: 'txt', tsv: 'txt', rtf: 'txt',
  zip: 'zip', tar: 'zip', gz: 'zip', bz2: 'zip', xz: 'zip', rar: 'zip', '7z': 'zip', dmg: 'zip',
  app: 'app', pkg: 'app',
};
const KIND_ICON = {
  img: 'i-file-img', vid: 'i-file-vid', aud: 'i-file-aud', pdf: 'i-file-pdf',
  code: 'i-file-code', txt: 'i-file-txt', zip: 'i-file-zip', app: 'i-app',
};
const KIND_NAME = {
  img: '이미지', vid: '동영상', aud: '오디오', pdf: 'PDF 문서',
  code: '소스 코드', txt: '텍스트 문서', zip: '압축 파일', app: '응용 프로그램',
};
function entryKind(e) {
  if (e.isDir) return e.name.endsWith('.app') ? 'app' : 'dir';
  return EXT_KIND[e.ext] || 'file';
}
function entryIcon(e) {
  const k = entryKind(e);
  if (k === 'dir') return 'i-folder';
  return KIND_ICON[k] || 'i-file';
}
function entryTypeName(e) {
  if (e.isDir) return e.name.endsWith('.app') ? '응용 프로그램' : '파일 폴더';
  const k = EXT_KIND[e.ext];
  if (k && KIND_NAME[k]) return e.ext ? `${KIND_NAME[k]} (.${e.ext})` : KIND_NAME[k];
  return e.ext ? `${e.ext.toUpperCase()} 파일` : '파일';
}
const isTextKind = (k) => k === 'txt' || k === 'code';

function svgIcon(id, cls = 'ic') {
  return `<svg class="${cls}"><use href="#${id}"/></svg>`;
}
// 실제 Fork 앱 아이콘 (네이티브 아이콘 API 재사용, 메뉴용)
const FORK_ICON_URL = `/api/sysicon?path=${encodeURIComponent('/Applications/Fork.app')}&size=32`;

// Finder-style display name: server-provided localized name, else hide .app
function displayName(e) {
  if (e.dname) return e.dname;
  return e.isDir && e.name.endsWith('.app') ? e.name.slice(0, -4) : e.name;
}
// icon HTML for a list/grid item — native macOS icons; image thumbnails in grid
function iconHtml(e, mode) {
  const k = entryKind(e);
  const px = mode === 'lg' ? 128 : mode === 'md' ? 96 : 40;
  if ((mode === 'lg' || mode === 'md') && k === 'img' && e.size < 40 * 1024 * 1024) {
    return `<img class="thumb" data-src="/api/thumb?path=${encodeURIComponent(e.path)}&size=${px}" data-fallback="i-file-img" alt="">`;
  }
  return `<img class="thumb" data-src="/api/sysicon?path=${encodeURIComponent(e.path)}&size=${px}" data-fallback="${entryIcon(e)}" alt="">`;
}
function esc(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ══════════ modal helpers ══════════ */
function openModal(title, wide = false) {
  $('modalTitle').textContent = title;
  $('modalBody').innerHTML = '';
  $('modalBtns').innerHTML = '';
  $('modal').classList.toggle('wide', wide);
  $('modalWrap').classList.remove('hidden');
}
function closeModal() { $('modalWrap').classList.add('hidden'); }
function addModalBtn(label, primary, fn) {
  const b = document.createElement('button');
  if (primary) b.className = 'primary';
  b.textContent = label;
  b.addEventListener('click', fn);
  $('modalBtns').appendChild(b);
  return b;
}
function textModal(title, text) {
  openModal(title);
  const pre = document.createElement('pre');
  pre.textContent = text;
  $('modalBody').appendChild(pre);
  addModalBtn('확인', true, closeModal).focus();
}
function promptModal(title, placeholder, defaultValue = '') {
  return new Promise((resolve) => {
    openModal(title);
    const inp = document.createElement('input');
    inp.type = 'text'; inp.placeholder = placeholder || '';
    inp.value = defaultValue;
    $('modalBody').appendChild(inp);
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; closeModal(); resolve(v); };
    addModalBtn('취소', false, () => done(null));
    addModalBtn('확인', true, () => done(inp.value.trim() || null));
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') done(inp.value.trim() || null);
      if (e.key === 'Escape') done(null);
    });
    inp.focus();
  });
}
function confirmModal(title, text) {
  return new Promise((resolve) => {
    openModal(title);
    const d = document.createElement('div');
    d.textContent = text;
    $('modalBody').appendChild(d);
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; closeModal(); resolve(v); };
    addModalBtn('취소', false, () => done(false));
    addModalBtn('확인', true, () => done(true)).focus();
  });
}

/* ══════════ navigation ══════════ */
function listQuery(path) {
  return { path, hidden: state.showHidden ? '1' : '0', system: state.showSystem ? '1' : '0' };
}
async function navigate(path, { push = true } = {}) {
  try {
    const data = await apiGet('list', listQuery(path));
    exitSearchMode(false);
    state.cwd = data.path;
    state.entries = data.entries;
    state.disk = data.disk;
    state.selection.clear();
    state.anchor = -1; state.focusIdx = -1;
    if (push) {
      state.history = state.history.slice(0, state.histIdx + 1);
      state.history.push(data.path);
      state.histIdx = state.history.length - 1;
    }
    render();
    renderBreadcrumbs();
    updateSidebarActive();
    fileArea.scrollTop = 0;
    document.title = `${basename(data.path) || data.path} — WindowFinder`;
    history.replaceState(null, '', '#' + encodeURI(data.path));
    fetchVcs();
    watchCwd();
  } catch (e) {
    toast(`폴더를 열 수 없습니다: ${e.message}`, true);
  }
}
async function refresh() {
  if (state.searchMode) { if (state.lastQuery) runSearch(state.lastQuery); return; }
  const sel = new Set(state.selection);
  try {
    const data = await apiGet('list', listQuery(state.cwd));
    state.entries = data.entries;
    state.disk = data.disk;
    state.selection = new Set(data.entries.filter((e) => sel.has(e.path)).map((e) => e.path));
    render();
    fetchVcs();
  } catch (e) { toast(e.message, true); }
}

/* ══════════ live folder watch: auto-refresh on external changes ══════════ */
let watchSrc = null, watchedDir = null, watchTimer = null;
function watchCwd() {
  if (watchedDir === state.cwd && watchSrc) return;
  watchSrc?.close();
  watchSrc = null;
  watchedDir = state.cwd;
  if (!state.cwd) return;
  watchSrc = new EventSource(`/api/watch?path=${encodeURIComponent(state.cwd)}`);
  watchSrc.onmessage = () => {
    clearTimeout(watchTimer);
    watchTimer = setTimeout(tryAutoRefresh, 800); // 변경을 묶어서 여유 있게 갱신
  };
}
function tryAutoRefresh() {
  // 이름 편집·드래그 선택·드래그 중에는 미뤘다가 갱신
  if (state.renaming || rubber || draggedPaths || state.searchMode) {
    watchTimer = setTimeout(tryAutoRefresh, 1500);
    return;
  }
  refresh();
}

/* ══════════ version control (git / svn) ══════════ */
let vcsToken = 0;
async function fetchVcs() {
  const token = ++vcsToken, cwd = state.cwd;
  try {
    const v = await apiGet('vcs', { path: cwd });
    if (token !== vcsToken || state.cwd !== cwd) return;
    if (v.git) buildDirSet(v.git);
    if (v.svn) buildDirSet(v.svn);
    state.vcs = (v.git || v.svn) ? v : null;
  } catch { state.vcs = null; }
  updateVcsUi();
  paintVcsBadges();
}
// mark ancestor dirs of changed files so folders show a badge too
function buildDirSet(repo) {
  const s = new Set();
  for (const p of Object.keys(repo.statuses)) {
    let d = p;
    for (;;) {
      const i = d.lastIndexOf('/');
      if (i <= 0) break;
      d = d.slice(0, i);
      if (d.length < repo.root.length) break;
      s.add(d);
    }
  }
  repo.dirSet = s;
}
function vcsStatusFor(e) {
  const v = state.vcs;
  if (!v) return null;
  for (const [tool, repo] of [['git', v.git], ['svn', v.svn]]) {
    if (!repo) continue;
    const code = repo.statuses[e.path];
    if (code) return vcsLetter(code, tool);
    if (e.isDir && repo.dirSet.has(e.path))
      return { letter: 'M', cls: 'vcs-M', title: '하위에 변경 사항 있음' };
  }
  return null;
}
function vcsLetter(code, tool) {
  if (code[0] === '?') return { letter: 'U', cls: 'vcs-U', title: '추적 안 됨' };
  if (tool === 'svn') {
    const c = code[0];
    if (c === 'C') return { letter: 'C', cls: 'vcs-C', title: '충돌' };
    if (c === 'D' || c === '!') return { letter: 'D', cls: 'vcs-D', title: '삭제됨' };
    if (c === 'A') return { letter: 'A', cls: 'vcs-A', title: '추가됨' };
    if (c === 'R') return { letter: 'R', cls: 'vcs-R', title: '교체됨' };
    return { letter: 'M', cls: 'vcs-M', title: '수정됨' };
  }
  if (code.includes('U')) return { letter: 'C', cls: 'vcs-C', title: '충돌' };
  if (code.includes('D')) return { letter: 'D', cls: 'vcs-D', title: '삭제됨' };
  if (code[0] === 'R') return { letter: 'R', cls: 'vcs-R', title: '이름 변경됨' };
  if (code[0] !== ' ') return { letter: 'A', cls: 'vcs-A', title: '스테이지됨 / 추가됨' };
  return { letter: 'M', cls: 'vcs-M', title: '수정됨' };
}
function updateVcsUi() {
  const g = state.vcs?.git, s = state.vcs?.svn;
  $('btnGit').classList.toggle('hidden', !g);
  $('btnSvn').classList.toggle('hidden', !s);
  $('statVcs').innerHTML = g
    ? `${svgIcon('i-branch', 'ic')} ${esc(g.branch)}`
    : (s ? `${svgIcon('i-branch', 'ic')} SVN` : '');
  $('statVcs').classList.toggle('clickable', !!(g || s));
  $('statVcs').title = g ? '클릭: Git 그래프 / 브랜치'
    : (s ? `클릭: SVN 로그 / 리비전${s.url ? `\n${s.url}` : ''}` : '');
}
$('statVer').addEventListener('click', () => {
  if (window.webkit?.messageHandlers?.fxCheckUpdate) {
    window.webkit.messageHandlers.fxCheckUpdate.postMessage(0);
  } else {
    toast(`WindowFinder v${state.version || '?'} — 업데이트 확인은 네이티브 앱에서 가능합니다`);
  }
});
$('statVcs').addEventListener('click', () => {
  if (state.vcs?.git) openGitGraph();
  else if (state.vcs?.svn) openSvnLog();
});
function paintVcsBadges() {
  fileList.querySelectorAll('.vcs-badge').forEach((b) => b.remove());
  if (!state.vcs) return;
  fileList.querySelectorAll('[data-path]').forEach((el) => {
    const e = state.sorted[+el.dataset.idx];
    if (!e) return;
    const host = el.querySelector('.cell-name') || el;
    const st = vcsStatusFor(e);
    if (st) {
      const span = document.createElement('span');
      span.className = 'vcs-badge ' + st.cls;
      span.textContent = st.letter;
      span.title = st.title;
      host.appendChild(span);
    }
    const lk = state.vcs?.svn?.locks?.[e.path];
    if (lk) {
      const l = document.createElement('span');
      l.className = 'vcs-badge vcs-lock' + (lk === 'K' ? ' mine' : '');
      l.title = lk === 'K' ? '내가 잠금 (lock)' : '다른 사용자가 잠금';
      l.innerHTML = svgIcon('i-lock', 'ic');
      host.appendChild(l);
    }
  });
}
const VCS_LABEL = {
  pull: '풀', push: '푸시', fetch: '페치', commitAll: '커밋', commit: '커밋',
  status: '상태', log: '로그', diff: '변경 요약', add: '스테이지/추가',
  unstage: '스테이지 해제', discard: '변경 취소', update: '업데이트', revert: '되돌리기',
  lock: '잠금', unlock: '잠금 해제',
};
// live progress window for long VCS operations: streaming file list,
// progress bar, transfer speed, elapsed time, cancel button
async function vcsStreamModal(title, payload, { onClose = null } = {}) {
  openModal(title, true);
  $('modalBody').innerHTML =
    `<div class="prog-stats">` +
    `<span id="progState">실행 중…</span>` +
    `<span id="progSpeed"></span><span id="progCount"></span>` +
    `<span class="spacer"></span><span id="progElapsed">0초</span></div>` +
    `<div class="prog-bar indet" id="progBar"><div class="prog-fill" id="progFill"></div></div>` +
    `<pre class="prog-log" id="progLog"></pre>`;
  const ctrl = new AbortController();
  let finished = false;
  const btn = addModalBtn('취소', false, () => {
    if (!finished) { ctrl.abort(); return; }
    if (onClose) onClose(); else closeModal();
  });
  const t0 = Date.now();
  const timer = setInterval(() => {
    if (!finished) $('progElapsed').textContent = `${Math.round((Date.now() - t0) / 1000)}초`;
  }, 500);

  const log = $('progLog');
  let lines = [''];
  let fileCount = 0;
  const commitLine = (line) => { // a finished line — count per-file entries (svn/git checkout)
    if (/^ ?[AUDGRMCE!]\s+\S/.test(line)) {
      fileCount++;
      $('progCount').textContent = `항목 ${fileCount.toLocaleString()}개`;
    }
  };
  const feed = (text) => {
    for (const part of text.split(/(\r\n|\n|\r)/)) {
      if (part === '\n' || part === '\r\n') { commitLine(lines[lines.length - 1]); lines.push(''); }
      else if (part === '\r') lines[lines.length - 1] = ''; // git progress rewrites the line
      else if (part) lines[lines.length - 1] += part;
    }
    const recent = lines[lines.length - 1] || lines[lines.length - 2] || '';
    const pm = /(\d+)%/.exec(recent);
    if (pm) {
      $('progBar').classList.remove('indet');
      $('progFill').style.width = `${Math.min(100, +pm[1])}%`;
      $('progState').textContent = `${recent.split(':')[0].trim()} ${pm[1]}%`;
    }
    const sm = /([\d.]+\s*[KMG]?i?B\/s)/.exec(recent);
    if (sm) $('progSpeed').textContent = sm[1];
  };
  const render = () => {
    log.textContent = lines.slice(-400).join('\n');
    log.scrollTop = log.scrollHeight;
  };

  try {
    const resp = await fetch('/api/vcsstream', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: ctrl.signal,
    });
    if (!resp.ok) {
      const j = await resp.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${resp.status}`);
    }
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      feed(dec.decode(value, { stream: true }));
      render();
    }
  } catch (e) {
    feed(e.name === 'AbortError' ? '\n[사용자가 취소했습니다]\n' : `\n오류: ${e.message}\n`);
  }

  finished = true;
  clearInterval(timer);
  const dm = lines.join('\n').match(/__DONE__:(\d+)/);
  const code = dm ? +dm[1] : -1;
  lines = lines.filter((l) => !l.includes('__DONE__'));
  render();
  $('progBar').classList.remove('indet');
  if (code === 0) {
    $('progFill').style.width = '100%';
    $('progState').textContent = `완료 (${Math.round((Date.now() - t0) / 1000)}초)`;
  } else {
    $('progFill').classList.add('err');
    $('progState').textContent = code === -1 ? '중단됨' : `실패 (종료 코드 ${code})`;
  }
  btn.textContent = '닫기';
  btn.classList.add('primary');
  refresh();
  fetchVcs();
}

async function cloneGitModal() {
  const url = await promptModal('Git 저장소 클론', 'https://… 또는 git@… URL');
  if (!url) return;
  vcsStreamModal(`Git 클론 — ${url.split('/').pop().replace(/\.git$/, '')}`,
    { tool: 'git', action: 'clone', root: state.cwd, url });
}
async function svnCheckoutModal() {
  const url = await promptModal('SVN 체크아웃', 'https://… 또는 svn://… URL');
  if (!url) return;
  vcsStreamModal('SVN 체크아웃', { tool: 'svn', action: 'checkout', root: state.cwd, url });
}

// git graph view: branch chips (click to checkout) + commit graph
async function gitGraphModal() {
  const root = state.vcs?.git?.root;
  if (!root) return;
  openModal(`Git 그래프 — ${basename(root)}`, true);
  $('modalBody').innerHTML = '<div class="commit-empty">불러오는 중…</div>';
  addModalBtn('닫기', true, closeViewFn);
  try {
    const data = await apiGet('gitgraph', { root });
    renderGitGraph(root, data);
  } catch (e) {
    $('modalBody').innerHTML = `<div class="commit-empty">${esc(e.message)}</div>`;
  }
}
const GG_COLORS = ['#4cc2ff', '#f6c445', '#59a869', '#e57373', '#7b61c1', '#d4691e', '#5aa7e8', '#3aa9a0'];
function renderGitGraph(root, data) {
  // ── Fork-style ref tree: branches / remotes / tags, grouped by '/' ──
  const current = (data.branches.find((b) => b.current) || {}).name || '';
  const mkTree = (items) => {
    const rootNode = { dirs: {}, leaves: [] };
    for (const it of items) {
      const parts = it.name.split('/');
      let node = rootNode;
      for (let i = 0; i < parts.length - 1; i++) {
        node.dirs[parts[i]] = node.dirs[parts[i]] || { dirs: {}, leaves: [] };
        node = node.dirs[parts[i]];
      }
      node.leaves.push({ ...it, label: parts[parts.length - 1] });
    }
    return rootNode;
  };
  const renderTree = (node, prefix) => {
    let h = '';
    for (const k of Object.keys(node.dirs).sort()) {
      const full = prefix ? `${prefix}/${k}` : k;
      const open = current === full || current.startsWith(full + '/');
      h += `<details class="rt-dir"${open ? ' open' : ''}><summary>${esc(k)}</summary>` +
        `<div class="rt-kids">${renderTree(node.dirs[k], full)}</div></details>`;
    }
    for (const leaf of node.leaves.sort((a, b) => a.label.localeCompare(b.label))) {
      h += `<div class="br-leaf${leaf.current ? ' current' : ''}" data-ref="${esc(leaf.ref)}" data-kind="${leaf.kind}" title="${esc(leaf.name)}">` +
        `${svgIcon(leaf.kind === 'tag' ? 'i-star' : 'i-branch', 'ic sm')}<span>${esc(leaf.label)}</span>${leaf.current ? '<b>✓</b>' : ''}</div>`;
    }
    return h;
  };
  const localItems = data.branches.filter((b) => !b.remote)
    .map((b) => ({ name: b.name, current: b.current, ref: b.name, kind: 'branch' }));
  const remoteItems = data.branches.filter((b) => b.remote)
    .map((b) => ({ name: b.name, current: false, ref: b.name.split('/').slice(1).join('/'), kind: 'branch' }));
  const tagItems = (data.tags || []).map((t) => ({ name: t, current: false, ref: t, kind: 'tag' }));
  const sideHtml =
    `<div class="rt-hint">항목을 우클릭하면 전환 메뉴가 열립니다</div>` +
    `<div class="rt-head">브랜치 (${localItems.length})</div>${renderTree(mkTree(localItems), '')}` +
    (remoteItems.length ? `<div class="rt-head">원격 (${remoteItems.length})</div>${renderTree(mkTree(remoteItems), '')}` : '') +
    (tagItems.length ? `<div class="rt-head">태그 (${tagItems.length})</div>${renderTree(mkTree(tagItems), '')}` : '');

  // ── lane assignment (each lane holds the hash it expects next) ──
  const W = 14, H = 30, R = 4;
  const lanes = [];
  const rows = [];
  for (const cm of (data.commits || [])) {
    const prev = lanes.slice();
    const matching = [];
    lanes.forEach((h, i) => { if (h === cm.hash) matching.push(i); });
    let c;
    if (matching.length) c = matching[0];
    else { c = lanes.indexOf(null); if (c < 0) { c = lanes.length; lanes.push(null); } }
    const mergeIn = matching.slice(1);          // other lanes converging on this commit
    mergeIn.forEach((i) => { lanes[i] = null; });
    const [p1, ...rest] = cm.parents;
    lanes[c] = p1 || null;
    const conns = [];                            // merge lines out to parent lanes
    for (const p of rest) {
      let t = lanes.indexOf(p);
      if (t < 0) {
        t = lanes.indexOf(null);
        if (t < 0) { t = lanes.length; lanes.push(p); } else lanes[t] = p;
      }
      conns.push(t);
    }
    while (lanes.length && lanes[lanes.length - 1] == null) lanes.pop();
    rows.push({ cm, c, prev, next: lanes.slice(), mergeIn, conns });
  }
  const maxL = Math.max(1, ...rows.map((r) => Math.max(r.prev.length, r.next.length, r.c + 1)));
  const gw = Math.min(maxL, 12) * W + 6;
  const col = (i) => GG_COLORS[i % GG_COLORS.length];
  const x = (i) => i * W + W / 2;

  const rowsHtml = rows.map((r) => {
    const cx = x(r.c), cy = H / 2;
    let s = '';
    for (let i = 0; i < maxL; i++) {
      if (i !== r.c && r.prev[i] != null && r.prev[i] === r.next[i])
        s += `<line x1="${x(i)}" y1="0" x2="${x(i)}" y2="${H}" stroke="${col(i)}"/>`;
    }
    if (r.prev[r.c] === r.cm.hash)
      s += `<line x1="${cx}" y1="0" x2="${cx}" y2="${cy}" stroke="${col(r.c)}"/>`;
    for (const i of r.mergeIn)
      s += `<path d="M${x(i)} 0 C ${x(i)} ${cy}, ${cx} ${cy * 0.3}, ${cx} ${cy}" fill="none" stroke="${col(i)}"/>`;
    if (r.next[r.c] != null)
      s += `<line x1="${cx}" y1="${cy}" x2="${cx}" y2="${H}" stroke="${col(r.c)}"/>`;
    for (const t of r.conns)
      s += `<path d="M${cx} ${cy} C ${cx} ${H * 0.85}, ${x(t)} ${cy * 1.4}, ${x(t)} ${H}" fill="none" stroke="${col(t)}"/>`;
    s += `<circle cx="${cx}" cy="${cy}" r="${R}" fill="${col(r.c)}"/>`;
    const badges = r.cm.refs.map((ref) => {
      const head = ref.startsWith('HEAD');
      const name = ref.replace(/^HEAD -> /, '');
      const tag = name.startsWith('tag: ');
      const refName = tag ? name.slice(5) : name;
      const clickable = name !== 'HEAD';
      return `<span class="gg-ref${head ? ' head' : ''}${tag ? ' tag' : ''}"` +
        ` data-ref="${clickable ? esc(refName) : ''}">${esc(refName)}</span>`;
    }).join('');
    return `<div class="gg-row" data-hash="${esc(r.cm.hash)}">` +
      `<svg width="${gw}" height="${H}" class="gg-svg">${s}</svg>` +
      `<div class="gg-msg">${badges}<span class="gg-sub" title="${esc(r.cm.subject)}">${esc(r.cm.subject)}</span></div>` +
      `<div class="gg-author" title="${esc(r.cm.author)}">${esc(r.cm.author)}</div>` +
      `<div class="gg-hash">${esc(r.cm.hash.slice(0, 7))}</div>` +
      `<div class="gg-date">${fmtRel(+r.cm.date)}</div></div>`;
  }).join('');

  // Fork 스타일 툴바: 아이콘 위 + 라벨 아래, 플랫 호버
  const ggTool = (id, icon, label) =>
    `<button id="${id}" class="gg-tool">${svgIcon(icon, 'ic')}<span>${label}</span></button>`;
  $('modalBody').innerHTML =
    `<div class="svnlog-bar gg-toolbar">` +
    ggTool('ggFetch', 'i-cloud', '페치') +
    ggTool('ggPull', 'i-downloads', '풀') +
    ggTool('ggPush', 'i-up', '푸시') +
    `<span class="gg-tool-sep"></span>` +
    ggTool('ggCommit', 'i-check', '커밋') +
    `<span class="gg-tool-sep"></span>` +
    ggTool('ggReload', 'i-refresh', '새로 고침') +
    `<span class="spacer"></span>` +
    `<span class="commit-sub">커밋을 클릭하면 변경 파일이 아래에 표시됩니다</span>` +
    `</div>` +
    `<div class="gg-layout gg-compact">` +
    `<div class="gg-side">${sideHtml}</div>` +
    `<div class="gg-main"><div class="gg-table">${rowsHtml || '<div class="commit-empty">커밋이 없습니다</div>'}</div></div>` +
    `</div>` +
    `<div class="svnlog-detail" id="ggDetail"><div class="commit-empty">커밋을 클릭하면 변경된 파일 목록이 여기에 표시됩니다</div></div>`;
  const stream = (action, label) =>
    vcsStreamModal(`Git ${label}`, { tool: 'git', action, root }, { onClose: gitGraphModal });
  $('ggFetch').addEventListener('click', () => stream('fetch', '페치'));
  $('ggPull').addEventListener('click', () => stream('pull', '풀'));
  $('ggPush').addEventListener('click', () => stream('push', '푸시'));
  $('ggCommit').addEventListener('click', () =>
    commitModal('git', { onCancel: gitGraphModal, onDone: gitGraphModal }));
  $('ggReload').addEventListener('click', gitGraphModal);

  // left click = select only; right click = context menu (checkout runs from there)
  const refMenu = (ev, { ref, kind, fullName, isCurrent }) => {
    ev.preventDefault();
    ev.stopPropagation();
    showMenu([
      !isCurrent ? {
        label: kind === 'tag' ? '이 태그로 체크아웃 (detached HEAD)' : '이 브랜치로 전환 (checkout)',
        icon: 'i-branch',
        action: () => doCheckout(root, ref),
      } : null,
      isCurrent ? { label: '현재 브랜치입니다', icon: 'i-check', disabled: true } : null,
      '-',
      { label: '이름 복사', icon: 'i-copy', action: () => { navigator.clipboard.writeText(fullName); toast('이름을 복사했습니다'); } },
    ].filter(Boolean), ev.clientX, ev.clientY);
  };
  $('modalBody').querySelectorAll('.br-leaf').forEach((el) => {
    el.addEventListener('click', () => {
      $('modalBody').querySelectorAll('.br-leaf.sel').forEach((x) => x.classList.remove('sel'));
      el.classList.add('sel');
    });
    el.addEventListener('contextmenu', (ev) => refMenu(ev, {
      ref: el.dataset.ref,
      kind: el.dataset.kind,
      fullName: el.title,
      isCurrent: el.classList.contains('current'),
    }));
  });
  // click a commit row → show the files it changed in the bottom detail pane
  const showCache = new Map();
  $('modalBody').querySelectorAll('.gg-row[data-hash]').forEach((row) => {
    row.addEventListener('click', async () => {
      const hash = row.dataset.hash;
      const r = rows.find((x) => x.cm.hash === hash);
      $('modalBody').querySelectorAll('.gg-row.sel').forEach((x) => x.classList.remove('sel'));
      row.classList.add('sel');
      const det = $('ggDetail');
      const head = r
        ? `<div class="commit-sub"><span class="gg-hash">${esc(hash.slice(0, 7))}</span> · ${esc(r.cm.author)} · ${fmtRel(+r.cm.date)}` +
          `<span class="dt-msg"> — ${esc(r.cm.subject)}</span></div>`
        : '';
      let changed = showCache.get(hash);
      if (!changed) {
        det.innerHTML = `${head}<div class="commit-empty">불러오는 중…</div>`;
        try {
          changed = (await apiGet('gitshow', { root, hash })).changed;
          showCache.set(hash, changed);
        } catch (e) {
          det.innerHTML = `${head}<div class="commit-empty">${esc(e.message)}</div>`;
          return;
        }
      }
      det.innerHTML = head +
        (changed.length ? changed.map(changeRow).join('') : '<div class="commit-empty">변경 파일 없음 (머지 커밋)</div>');
    });
  });
  $('modalBody').querySelectorAll('.gg-ref').forEach((el) => {
    el.addEventListener('contextmenu', (ev) => {
      const full = el.dataset.ref || el.textContent;
      let ref = el.dataset.ref;
      if (ref && ref.startsWith('origin/')) ref = ref.slice(7);
      refMenu(ev, {
        ref: ref || full,
        kind: el.classList.contains('tag') ? 'tag' : 'branch',
        fullName: full,
        isCurrent: !el.dataset.ref || el.classList.contains('head'),
      });
    });
  });
}
function doCheckout(root, branch) {
  vcsStreamModal(`브랜치 전환 — ${branch}`, { tool: 'git', action: 'checkout', root, branch },
    { onClose: gitGraphModal });
}

// one changed-file line inside an expanded revision/commit row
function changeRow(c) {
  const map = {
    M: ['M', 'vcs-M', '수정'], A: ['A', 'vcs-A', '추가'], D: ['D', 'vcs-D', '삭제'],
    R: ['R', 'vcs-R', '이름 변경'], C: ['A', 'vcs-A', '복사'], T: ['M', 'vcs-M', '속성 변경'],
  };
  const [letter, cls, title] = map[c.action] || [c.action, 'vcs-M', c.action];
  return `<div class="rv-row"><span class="vcs-badge ${cls}">${letter}</span>` +
    `<span class="cp">${esc(c.path)}</span><span class="cp-k">${title}</span></div>`;
}

// svn log as a grid: revision / message / author / date, with update-to-revision
async function svnLogModal() {
  const root = state.vcs?.svn?.root;
  if (!root) return;
  openModal(`SVN 로그 — ${basename(root)}`, true);
  $('modalBody').innerHTML =
    vcsUrlHtml(state.vcs?.svn?.url) +
    `<div class="svnlog-bar">` +
    `<span class="commit-sub" id="svnCur">불러오는 중…</span>` +
    `<span class="spacer"></span>` +
    `<label>기간</label>` +
    `<input type="date" id="svnFrom"> <span>~</span> <input type="date" id="svnTo">` +
    `<button id="svnApply">적용</button><button id="svnAll">전체</button>` +
    `</div>` +
    `<div class="gg-table svnlog-list" id="svnList"><div class="commit-empty">불러오는 중…</div></div>` +
    `<div class="svnlog-detail" id="svnDetail"><div class="commit-empty">리비전을 클릭하면 변경된 파일 목록이 여기에 표시됩니다</div></div>`;
  addModalBtn('닫기', true, closeViewFn);
  bindVcsUrl($('modalBody'));

  const listEl = $('svnList'), detailEl = $('svnDetail');
  let entries = [], current = null, hasMore = false, loading = false;
  let filter = null, selectedRev = null;

  const doUpdateRev = (rev) => {
    vcsStreamModal(`SVN 업데이트 — r${rev}`, { tool: 'svn', action: 'updateRev', root, rev },
      { onClose: svnLogModal });
  };
  const rowHtml = (en) => {
    const cur = en.rev === current;
    const first = (en.msg || '').split('\n')[0];
    return `<div class="gg-row svn-row${cur ? ' cur' : ''}${en.rev === selectedRev ? ' sel' : ''}" data-rev="${en.rev}" title="${esc(en.msg || '')}">` +
      `<div class="svn-rev">r${en.rev}</div>` +
      `<div class="gg-msg"><span class="gg-sub">${esc(first)}</span></div>` +
      `<div class="gg-count">${(en.changed || []).length}개</div>` +
      `<div class="gg-author" title="${esc(en.author)}">${esc(en.author)}</div>` +
      `<div class="gg-date">${fmtDate(new Date(en.date).getTime())}</div>` +
      `<button class="svn-upd">${cur ? '현재' : '이동'}</button></div>`;
  };
  const showDetail = (en) => {
    selectedRev = en.rev;
    listEl.querySelectorAll('.svn-row.sel').forEach((x) => x.classList.remove('sel'));
    listEl.querySelector(`.svn-row[data-rev="${en.rev}"]`)?.classList.add('sel');
    detailEl.innerHTML =
      `<div class="commit-sub">r${en.rev} · ${esc(en.author)} · ${fmtDate(new Date(en.date).getTime())} · 변경 ${en.changed.length}개` +
      `<span class="dt-msg" title="${esc(en.msg || '')}"> — ${esc((en.msg || '').split('\n')[0])}</span></div>` +
      (en.changed.length ? en.changed.map(changeRow).join('') : '<div class="commit-empty">변경 내역 없음</div>');
  };
  const bindRows = () => {
    listEl.querySelectorAll('.svn-row:not([data-bound])').forEach((row) => {
      row.dataset.bound = '1';
      const en = entries.find((x) => x.rev === +row.dataset.rev);
      row.addEventListener('click', () => showDetail(en));
      row.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const cur = row.classList.contains('cur');
        showMenu([
          !cur ? { label: `r${en.rev}(으)로 업데이트`, icon: 'i-downloads', action: () => doUpdateRev(String(en.rev)) } : null,
          cur ? { label: '현재 리비전입니다', icon: 'i-check', disabled: true } : null,
          '-',
          { label: '리비전 번호 복사', icon: 'i-copy', action: () => { navigator.clipboard.writeText(String(en.rev)); toast('복사했습니다'); } },
          { label: '커밋 메시지 복사', icon: 'i-copy', action: () => { navigator.clipboard.writeText(en.msg || ''); toast('복사했습니다'); } },
        ].filter(Boolean), ev.clientX, ev.clientY);
      });
    });
    listEl.querySelectorAll('.svn-upd:not([data-bound])').forEach((btn) => {
      btn.dataset.bound = '1';
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const row = btn.closest('.svn-row');
        if (!row.classList.contains('cur')) doUpdateRev(row.dataset.rev);
      });
    });
  };
  // append-only rendering: existing rows are never rebuilt, so scrolling in
  // more pages can't disturb layout, selection, or event bindings
  const renderList = (fromIdx = 0) => {
    listEl.querySelector('.svn-sentinel')?.remove();
    if (fromIdx === 0) listEl.innerHTML = '';
    const html = entries.slice(fromIdx).map(rowHtml).join('');
    if (html) listEl.insertAdjacentHTML('beforeend', html);
    else if (fromIdx === 0) listEl.innerHTML = '<div class="commit-empty">해당 기간에 로그가 없습니다</div>';
    if (hasMore) listEl.insertAdjacentHTML('beforeend', '<div class="commit-empty svn-sentinel">스크롤을 내리면 더 불러옵니다…</div>');
    bindRows();
    $('svnCur').textContent =
      `현재 리비전: r${current ?? '?'} · ${entries.length.toLocaleString()}개 표시` +
      (filter ? ' (기간 필터)' : '');
  };
  const load = async ({ append = false, before = null } = {}) => {
    if (loading) return;
    loading = true;
    try {
      const params = { root, limit: '100' };
      if (filter?.from) params.from = filter.from;
      if (filter?.to) params.to = filter.to;
      if (before != null) params.before = String(before);
      const d = await apiGet('svnlog', params);
      current = d.current;
      const prevLen = append ? entries.length : 0;
      if (append) {
        const seen = new Set(entries.map((e) => e.rev));
        entries = entries.concat(d.entries.filter((e) => !seen.has(e.rev)));
      } else {
        entries = d.entries;
      }
      hasMore = d.hasMore;
      renderList(prevLen);
    } catch (e) {
      listEl.innerHTML = `<div class="commit-empty">${esc(e.message)}</div>`;
    }
    loading = false;
  };
  listEl.addEventListener('scroll', () => {
    if (hasMore && !loading &&
        listEl.scrollTop + listEl.clientHeight > listEl.scrollHeight - 80) {
      const last = entries[entries.length - 1];
      if (last && last.rev > 1) load({ append: true, before: last.rev - 1 });
    }
  });
  $('svnApply').addEventListener('click', () => {
    const from = $('svnFrom').value, to = $('svnTo').value;
    filter = (from || to) ? { from, to } : null;
    load();
  });
  $('svnAll').addEventListener('click', () => {
    filter = null;
    $('svnFrom').value = '';
    $('svnTo').value = '';
    load();
  });
  load();
}

// pretty status list (replaces raw `status` text output)
// 저장소 URL 한 줄 (클릭 시 복사)
function vcsUrlHtml(url) {
  return url ? `<div class="vcs-url" title="클릭: 주소 복사">${esc(url)}</div>` : '';
}
function bindVcsUrl(container) {
  container.querySelectorAll('.vcs-url').forEach((el) =>
    el.addEventListener('click', () => {
      navigator.clipboard.writeText(el.textContent);
      toast('저장소 주소를 복사했습니다');
    }));
}

async function statusModal(tool) {
  await fetchVcs();
  const repo = state.vcs?.[tool];
  if (!repo) return;
  const label = tool === 'git' ? 'Git' : 'SVN';
  const entries = Object.entries(repo.statuses).sort((a, b) => a[0].localeCompare(b[0]));
  const rel = (p) => p.length > repo.root.length ? p.slice(repo.root.length + 1) : p;
  openModal(`${label} 상태 — ${basename(repo.root)}${repo.branch ? ` (${repo.branch})` : ''}`);
  $('modalBody').innerHTML =
    vcsUrlHtml(tool === 'svn' ? repo.url : null) +
    `<div class="commit-sub">변경된 항목 ${entries.length}개</div>` +
    `<div class="commit-list">${entries.length ? entries.map(([p, code]) => {
      const st = vcsLetter(code, tool);
      return `<div class="commit-row"><span class="vcs-badge ${st.cls}">${st.letter}</span>` +
        `<span class="cp">${esc(rel(p))}</span><span class="cp-k">${st.title}</span></div>`;
    }).join('') : '<div class="commit-empty">변경 사항이 없습니다 — 작업 사본이 깨끗합니다</div>'}</div>`;
  bindVcsUrl($('modalBody'));
  addModalBtn('커밋…', false, () => commitModal(tool));
  addModalBtn('확인', true, closeModal);
}

// svn revert-all: list every change in the working copy, then revert recursively
// SVN 정리(cleanup): TortoiseSVN처럼 옵션을 골라 실행
// svn switch: 작업 사본을 다른 브랜치/URL로 전환
async function svnSwitchModal() {
  const root = state.vcs?.svn?.root;
  if (!root) return;
  const cur = state.vcs?.svn?.url || 'https://';
  const url = await promptModal('SVN 스위치 — 전환할 브랜치 URL', 'https://…/branches/…', cur);
  if (!url) return;
  if (url === cur) { toast('현재 URL과 동일합니다'); return; }
  vcsStreamModal('SVN 스위치', { tool: 'svn', action: 'switch', root, url });
}

function svnCleanupModal() {
  const root = state.vcs?.svn?.root;
  if (!root) return;
  openModal(`SVN 정리 (cleanup) — ${basename(root)}`);
  const OPTS = [
    ['basic', '작업 사본 정리 (잠금 해제·중단된 작업 복구)', '커밋/업데이트가 "locked" 오류로 막힐 때 해결', true, false],
    ['removeUnversioned', '미추적(unversioned) 파일 삭제', '버전 관리에 없는 파일을 모두 지웁니다', false, true],
    ['removeIgnored', '무시된(ignored) 파일 삭제', 'svn:ignore 대상 파일을 모두 지웁니다', false, true],
    ['vacuum', 'pristine 캐시 정리', '.svn 내부 캐시를 비워 디스크 공간 회수', false, false],
    ['externals', 'externals 포함', '외부 참조 작업 사본에도 함께 적용', false, false],
  ];
  $('modalBody').innerHTML =
    OPTS.map(([id, label, desc, on]) =>
      `<label class="cu-opt"><input type="checkbox" id="cu-${id}"${on ? ' checked' : ''}>` +
      `<span>${esc(label)}<span class="cu-desc">${esc(desc)}</span></span></label>`).join('') +
    `<div class="cu-warn hidden" id="cuWarn">⚠ 삭제 옵션은 되돌릴 수 없습니다 — 파일이 영구히 지워집니다.</div>`;
  const refreshWarn = () => {
    const danger = $('cu-removeUnversioned').checked || $('cu-removeIgnored').checked;
    $('cuWarn').classList.toggle('hidden', !danger);
  };
  ['removeUnversioned', 'removeIgnored'].forEach((id) =>
    $(`cu-${id}`).addEventListener('change', refreshWarn));
  addModalBtn('취소', false, closeModal);
  addModalBtn('정리 실행', true, () => {
    const opt = Object.fromEntries(OPTS.map(([id]) => [id, $(`cu-${id}`).checked]));
    if (!opt.basic && !opt.removeUnversioned && !opt.removeIgnored && !opt.vacuum) {
      toast('실행할 항목을 선택하세요', true);
      return;
    }
    vcsStreamModal('SVN 정리 (cleanup)', { tool: 'svn', action: 'cleanup', root, ...opt });
  });
}

async function revertAllModal() {
  await fetchVcs();
  const repo = state.vcs?.svn;
  if (!repo) return;
  const entries = Object.entries(repo.statuses).sort((a, b) => a[0].localeCompare(b[0]));
  const target = entries.filter(([, c]) => c[0] !== '?');
  const skip = entries.filter(([, c]) => c[0] === '?');
  const rel = (p) => p.length > repo.root.length ? p.slice(repo.root.length + 1) : p;
  const mkRow = ([p, code], dim) => {
    const st = vcsLetter(code, 'svn');
    return `<div class="commit-row${dim ? ' dim' : ''}"><span class="vcs-badge ${st.cls}">${st.letter}</span>` +
      `<span class="cp">${esc(rel(p))}</span></div>`;
  };
  openModal(`SVN 전체 되돌리기 — ${basename(repo.root)}`);
  $('modalBody').innerHTML =
    `<div class="commit-sub">되돌릴 항목 ${target.length}개 — 아래 변경 사항이 모두 사라집니다 (복구 불가)</div>` +
    `<div class="commit-list">${target.length ? target.map((e) => mkRow(e)).join('') : '<div class="commit-empty">되돌릴 변경 사항이 없습니다</div>'}</div>` +
    (skip.length
      ? `<div class="commit-sub">영향 없음 — 추적 안 됨 ${skip.length}개</div>` +
        `<div class="commit-list">${skip.map((e) => mkRow(e, true)).join('')}</div>`
      : '');
  addModalBtn('취소', false, closeModal);
  const ok = addModalBtn('전체 되돌리기', true, () =>
    vcsStreamModal('SVN 전체 되돌리기', { tool: 'svn', action: 'revertAll', root: repo.root }));
  if (!target.length) ok.disabled = true;
}

// commit dialog: shows the list of files that will be committed + message input
async function commitModal(tool, opts = {}) {
  await fetchVcs(); // make sure the status list is fresh
  const repo = state.vcs?.[tool];
  if (!repo) { toast('저장소를 찾을 수 없습니다', true); return; }
  const label = tool === 'git' ? 'Git' : 'SVN';
  const entries = Object.entries(repo.statuses)
    .sort((a, b) => a[0].localeCompare(b[0]));
  // svn commit skips untracked('?') files; git commitAll(add -A) includes everything
  const committable = tool === 'svn' ? entries.filter(([, c]) => c[0] !== '?') : entries;
  const excluded = tool === 'svn' ? entries.filter(([, c]) => c[0] === '?') : [];
  const rel = (p) => p.length > repo.root.length ? p.slice(repo.root.length + 1) : p;
  const mkRow = ([p, code], dim) => {
    const st = vcsLetter(code, tool);
    return `<div class="commit-row${dim ? ' dim' : ''}">` +
      `<span class="vcs-badge ${st.cls}" title="${st.title}">${st.letter}</span>` +
      `<span class="cp">${esc(rel(p))}</span></div>`;
  };
  openModal(`${label} 커밋 — ${basename(repo.root)}${repo.branch ? ` (${repo.branch})` : ''}`);
  $('modalBody').innerHTML =
    `<div class="commit-sub">커밋 대상 ${committable.length}개</div>` +
    `<div class="commit-list">${committable.length
      ? committable.map((e) => mkRow(e)).join('')
      : '<div class="commit-empty">커밋할 변경 사항이 없습니다</div>'}</div>` +
    (excluded.length
      ? `<div class="commit-sub">제외됨 — 추적 안 됨 ${excluded.length}개 (커밋하려면 먼저 ‘SVN: 추가’)</div>` +
        `<div class="commit-list">${excluded.map((e) => mkRow(e, true)).join('')}</div>`
      : '') +
    `<input type="text" id="commitMsg" placeholder="커밋 메시지">`;
  const inp = $('commitMsg');
  addModalBtn('취소', false, opts.onCancel || closeModal);
  const ok = addModalBtn('커밋', true, () => {
    const m = inp.value.trim();
    if (!m) { inp.focus(); return; }
    vcsStreamModal(`${label} 커밋`, {
      tool, action: tool === 'git' ? 'commitAll' : 'commit', root: repo.root, message: m,
    }, { onClose: opts.onDone || null });
  });
  if (!committable.length) ok.disabled = true;
  inp.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') ok.click();
    if (e.key === 'Escape') closeModal();
  });
  inp.focus();
}

async function vcsRun(tool, action, { paths = [], message = '', force = false, showOutput = true } = {}) {
  const root = state.vcs?.[tool]?.root;
  if (!root) return;
  toast('실행 중…');
  try {
    const r = await fetch('/api/vcsop', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool, action, root, paths, message, force }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'error');
    hideToast();
    const title = `${tool === 'git' ? 'Git' : 'SVN'} ${VCS_LABEL[action] || action}`;
    if (showOutput) textModal(title, j.output);
    else toast(`${title} 완료`);
    refresh();
  } catch (e) {
    textModal('오류', e.message);
    fetchVcs();
  }
}
function goBack() { if (state.histIdx > 0) { state.histIdx--; navigate(state.history[state.histIdx], { push: false }); } }
function goFwd() { if (state.histIdx < state.history.length - 1) { state.histIdx++; navigate(state.history[state.histIdx], { push: false }); } }
function goUp() {
  if (!state.cwd || state.cwd === '/') return;
  const parent = state.cwd.replace(/\/[^/]+\/?$/, '') || '/';
  navigate(parent);
}
function basename(p) { return p.split('/').filter(Boolean).pop() || ''; }

/* ══════════ sorting & render ══════════ */
function sortEntries() {
  const dirFactor = state.sortDir === 'asc' ? 1 : -1;
  const key = state.sortKey;
  state.sorted = [...state.entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1; // folders first, always
    let r = 0;
    if (key === 'name') r = displayName(a).localeCompare(displayName(b), 'ko', { numeric: true, sensitivity: 'base' });
    else if (key === 'mtime') r = a.mtime - b.mtime;
    else if (key === 'size') r = (a.size || 0) - (b.size || 0);
    else if (key === 'type') r = entryTypeName(a).localeCompare(entryTypeName(b), 'ko');
    if (r === 0) r = a.name.localeCompare(b.name, 'ko', { numeric: true });
    return r * dirFactor;
  });
}

let thumbObserver = null;
function render() {
  sortEntries();
  const mode = state.viewMode;
  const details = mode === 'details';
  $('colHeader').classList.toggle('hidden', !details || false);
  $('colHeader').classList.toggle('hidden', !details);
  fileList.className = details ? '' : `grid size-${mode === 'lg' ? 'lg' : mode === 'md' ? 'md' : 'sm'}`;

  if (thumbObserver) thumbObserver.disconnect();
  thumbObserver = new IntersectionObserver((ents) => {
    for (const en of ents) {
      if (en.isIntersecting) {
        const img = en.target;
        img.src = img.dataset.src;
        thumbObserver.unobserve(img);
      }
    }
  }, { root: fileArea });

  const cutSet = state.clipboard?.mode === 'cut' ? new Set(state.clipboard.paths) : new Set();
  const frag = document.createDocumentFragment();

  state.sorted.forEach((e, i) => {
    const el = document.createElement('div');
    el.dataset.idx = i;
    el.dataset.path = e.path;
    el.draggable = true;
    const selected = state.selection.has(e.path);

    if (details) {
      el.className = 'row' + (selected ? ' sel' : '') + (cutSet.has(e.path) ? ' cut' : '');
      el.innerHTML =
        `<div class="cell-name">${iconHtml(e, mode)}<span class="nm" title="${esc(e.name)}">${esc(displayName(e))}</span></div>` +
        `<div class="cell-date">${fmtDate(e.mtime)}</div>` +
        `<div class="cell-type">${state.searchMode ? esc(shortenHome(e.parent || '')) : entryTypeName(e)}</div>` +
        `<div class="cell-size">${e.isDir ? '' : fmtSize(e.size)}</div>`;
    } else {
      el.className = 'tile' + (selected ? ' sel' : '') + (cutSet.has(e.path) ? ' cut' : '');
      el.innerHTML = `${iconHtml(e, mode)}<span class="nm" title="${esc(e.name)}">${esc(displayName(e))}</span>`;
    }
    frag.appendChild(el);
  });

  fileList.innerHTML = '';
  fileList.appendChild(frag);
  fileList.querySelectorAll('img.thumb').forEach((img) => {
    img.addEventListener('error', () => {
      const holder = document.createElement('span');
      holder.innerHTML = svgIcon(img.dataset.fallback || 'i-file');
      img.replaceWith(holder.firstChild);
    });
    thumbObserver.observe(img);
  });

  $('emptyMsg').classList.toggle('hidden', state.sorted.length > 0);
  updateSortArrows();
  updateStatus();
  updateToolbar();
  updatePreview();
  paintVcsBadges();
}

function updateSortArrows() {
  document.querySelectorAll('#colHeader .col').forEach((c) => {
    const a = c.querySelector('.arrow');
    a.textContent = c.dataset.key === state.sortKey ? (state.sortDir === 'asc' ? '▲' : '▼') : '';
  });
}
function shortenHome(p) { return state.home && p.startsWith(state.home) ? '~' + p.slice(state.home.length) : p; }

function updateStatus() {
  $('statCount').textContent = `항목 ${state.sorted.length.toLocaleString()}개`;
  const sel = state.sorted.filter((e) => state.selection.has(e.path));
  if (sel.length) {
    const bytes = sel.reduce((s, e) => s + (e.size || 0), 0);
    $('statSel').textContent = `${sel.length}개 선택${bytes ? ` (${fmtSize(bytes)})` : ''}`;
  } else $('statSel').textContent = '';
  $('statDisk').textContent = state.disk ? `${fmtSize(state.disk.free)} 사용 가능` : '';
  $('statPath').textContent = shortenHome(state.cwd || '');
}
function updateToolbar() {
  const n = state.selection.size;
  $('btnCut').disabled = !n;
  $('btnCopy').disabled = !n;
  $('btnRename').disabled = n !== 1;
  $('btnTrash').disabled = !n;
  $('btnPaste').disabled = state.searchMode; // 시스템 클립보드는 비동기라 항상 활성
  $('btnBack').disabled = state.histIdx <= 0;
  $('btnFwd').disabled = state.histIdx >= state.history.length - 1;
  $('btnUp').disabled = state.cwd === '/';
}

/* ══════════ breadcrumbs / address ══════════ */
function renderBreadcrumbs() {
  const bc = $('breadcrumbs');
  bc.innerHTML = '';
  const parts = (state.cwd || '/').split('/').filter(Boolean);
  const mk = (label, path) => {
    const b = document.createElement('span');
    b.className = 'crumb';
    b.textContent = label;
    b.addEventListener('click', (ev) => { ev.stopPropagation(); navigate(path); });
    // drop target
    addDropTarget(b, () => path);
    return b;
  };
  bc.appendChild(mk('Macintosh HD', '/'));
  let acc = '';
  for (const part of parts) {
    acc += '/' + part;
    const sep = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    sep.setAttribute('class', 'crumb-sep');
    sep.innerHTML = '<use href="#i-chev-r"/>';
    bc.appendChild(sep);
    bc.appendChild(mk(part, acc));
  }
  bc.scrollLeft = bc.scrollWidth;
}
$('breadcrumbs').addEventListener('click', () => {
  const ab = $('addressbar');
  ab.classList.add('editing');
  const inp = $('addressInput');
  inp.value = state.cwd;
  inp.focus(); inp.select();
});
$('addressInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    let v = $('addressInput').value.trim();
    if (v.startsWith('~')) v = state.home + v.slice(1);
    if (v) navigate(v);
    $('addressbar').classList.remove('editing');
  } else if (e.key === 'Escape') {
    $('addressbar').classList.remove('editing');
  }
});
$('addressInput').addEventListener('blur', () => $('addressbar').classList.remove('editing'));

/* ══════════ sidebar ══════════ */
async function initSidebar() {
  const data = await apiGet('home', {});
  state.home = data.home;
  state.forkInstalled = !!data.fork;
  state.version = data.version || '';
  $('statVer').textContent = state.version ? `v${state.version}` : '';

  const places = $('sidePlacesList');
  places.innerHTML = '';
  for (const p of data.places) places.appendChild(sideItem(p.name, p.path, p.icon));

  renderWebLinks();

  renderVolumeGroups(data.volumes);
  $('sideVolAdd').addEventListener('click', (ev) => { ev.stopPropagation(); mountNetworkDrive(); });

  const tree = $('sideTreeList');
  tree.innerHTML = '';
  tree.appendChild(treeItem({ name: 'Macintosh HD', path: '/' }, 0, 'pc'));

  return data.home;
}

function sideItem(label, path, icon, opts = {}) {
  const el = document.createElement('div');
  el.className = 'side-item';
  el.dataset.path = path;
  el.innerHTML = `<span class="twisty"></span>${svgIcon('i-' + icon)}<span class="label">${esc(label)}</span>`;
  if (opts.eject) {
    el.dataset.eject = '1';
    const b = document.createElement('button');
    b.className = 'eject-btn';
    b.title = '추출';
    b.innerHTML = svgIcon('i-eject', 'ic sm');
    b.addEventListener('click', (ev) => { ev.stopPropagation(); ejectVolume(path); });
    el.appendChild(b);
  }
  el.addEventListener('click', () => navigate(path));
  addDropTarget(el, () => path);
  return el;
}

async function mountNetworkDrive() {
  const last = localStorage.getItem('fx.lastNetDrive') || '';
  const url = await promptModal('네트워크 드라이브 연결', 'smb://서버주소/공유이름', last);
  if (!url) return;
  localStorage.setItem('fx.lastNetDrive', url);
  toast('연결 중… (필요하면 인증 창이 뜹니다)');
  try {
    await apiOp({ op: 'mountNet', url });
    toast('네트워크 드라이브가 연결되었습니다');
    // 방금 마운트된 볼륨으로 이동 + 등록 목록에 저장 (추출해도 목록 유지)
    const share = url.replace(/\/+$/, '').split('/').pop();
    const vol = `/Volumes/${decodeURIComponent(share)}`;
    rememberNetDrive(decodeURIComponent(share), url);
    await refreshVolumes();
    apiGet('list', listQuery(vol)).then(() => navigate(vol)).catch(() => {});
  } catch (e) { toast(`연결 실패: ${e.message}`, true); }
}

async function ejectVolume(p, force = false) {
  toast('추출 중…');
  try {
    await apiOp({ op: 'eject', path: p, force });
    toast(`'${basename(p)}' 볼륨을 추출했습니다`);
    if (state.cwd && (state.cwd === p || state.cwd.startsWith(p + '/'))) navigate(state.home);
    refreshVolumes();
  } catch (e) {
    if (!force && /busy|사용 중|in use|couldn't be|unmount/i.test(e.message)) {
      if (await confirmModal('추출 실패', `볼륨이 사용 중입니다.\n강제로 추출할까요? (해당 볼륨의 열린 파일이 닫힙니다)`))
        ejectVolume(p, true);
    } else {
      toast(`추출 실패: ${e.message}`, true);
    }
  }
}
async function refreshVolumes() {
  try {
    const data = await apiGet('home', {});
    renderVolumeGroups(data.volumes);
    updateSidebarActive();
  } catch { /* ignore */ }
}

/* 로컬 볼륨과 네트워크 드라이브를 분리 렌더.
   네트워크 드라이브는 등록 목록(fx.netdrives)에 저장되어, 마운트가 끊겨도
   '제거'하기 전까지 목록에 남고 클릭하면 재연결된다. */
function getNetDrives() { return JSON.parse(localStorage.getItem('fx.netdrives') || '[]'); }
function saveNetDrives(list) { localStorage.setItem('fx.netdrives', JSON.stringify(list)); }
function rememberNetDrive(name, url) {
  const list = getNetDrives();
  const i = list.findIndex((d) => d.name === name || d.url === url);
  if (i >= 0) list[i] = { name, url };
  else list.push({ name, url });
  saveNetDrives(list);
}
function renderVolumeGroups(volumes) {
  // ── 볼륨 그룹: 로컬 먼저, 마운트된 네트워크 볼륨은 뒤에(전용 아이콘) ──
  const vols = $('sideVolumesList');
  vols.innerHTML = '';
  const byName = (a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true });
  for (const v of volumes.filter((x) => !x.net).sort(byName)) {
    vols.appendChild(sideItem(v.name, v.path, 'drive', { eject: v.ejectable !== false }));
  }
  const regs = getNetDrives();
  const mountedNet = volumes.filter((x) => x.net).sort(byName);
  const mountedNames = new Set(mountedNet.map((x) => x.name));
  for (const v of mountedNet) {
    const el = sideItem(v.name, v.path, 'netdrive', { eject: true });
    el.dataset.netName = v.name;
    el.dataset.netUrl = regs.find((d) => d.name === v.name)?.url || '';
    vols.appendChild(el);
  }

  // ── 네트워크 그룹: 발견된 SMB 서버 + 접근했던(등록) 드라이브 중 끊긴 것 ──
  const netEl = $('sideNetList');
  netEl.innerHTML = '';
  for (const d of [...regs].sort(byName)) {
    if (mountedNames.has(d.name)) continue; // 마운트됨 → 볼륨 그룹에 표시
    const el = document.createElement('div');
    el.className = 'side-item net-off';
    el.title = `${d.url}\n클릭하면 다시 연결합니다`;
    el.innerHTML = `<span class="twisty"></span>${svgIcon('i-netdrive')}<span class="label">${esc(d.name)}</span>`;
    el.dataset.netName = d.name;
    el.dataset.netUrl = d.url || '';
    el.addEventListener('click', () => reconnectNetDrive(d.url));
    netEl.appendChild(el);
  }
  loadNetServers(netEl);
}
// Bonjour로 발견된 SMB 서버 목록 (클릭 → Finder 접속 창)
async function loadNetServers(netEl) {
  try {
    const d = await apiGet('netbrowse', {});
    if (netEl !== $('sideNetList')) return; // 그 사이 다시 렌더됨
    netEl.querySelectorAll('.net-server').forEach((x) => x.remove());
    const regNames = new Set(getNetDrives().map((x) => x.name));
    for (const name of d.servers || []) {
      const el = document.createElement('div');
      el.className = 'side-item net-server';
      el.title = `발견된 서버 — 클릭하면 연결 (smb)`;
      el.innerHTML = `<span class="twisty"></span>${svgIcon('i-pc')}<span class="label">${esc(name)}</span>`;
      el.dataset.netServer = name;
      el.addEventListener('click', async () => {
        const url = `smb://${encodeURIComponent(name)}.local`;
        toast(`'${name}' 서버에 연결 중…`);
        try {
          await apiOp({ op: 'openNet', url });
          setTimeout(refreshVolumes, 4000); // Finder에서 마운트되면 반영
        } catch (e) { toast(`연결 실패: ${e.message}`, true); }
      });
      netEl.appendChild(el);
    }
  } catch { /* 탐색 실패는 조용히 */ }
  $('sideNetGroup').classList.toggle('hidden', !$('sideNetList').children.length);
}
async function reconnectNetDrive(url) {
  if (!url) { toast('저장된 주소가 없습니다 — 우클릭으로 제거 후 다시 연결하세요', true); return; }
  toast('다시 연결 중… (필요하면 인증 창이 뜹니다)');
  try {
    await apiOp({ op: 'mountNet', url });
    toast('연결되었습니다');
    await refreshVolumes();
    const share = url.replace(/\/+$/, '').split('/').pop();
    navigate(`/Volumes/${decodeURIComponent(share)}`);
  } catch (e) { toast(`연결 실패: ${e.message}`, true); }
}

function treeItem(entry, depth, iconOverride) {
  const wrap = document.createElement('div');
  const el = document.createElement('div');
  el.className = 'side-item';
  el.dataset.path = entry.path;
  el.style.paddingLeft = `${8 + depth * 14}px`;
  el.innerHTML =
    `<span class="twisty has"><svg><use href="#i-chev-r"/></svg></span>` +
    svgIcon('i-' + (iconOverride || 'folder')) +
    `<span class="label">${esc(entry.name)}</span>`;
  const kids = document.createElement('div');
  kids.className = 'hidden';
  wrap.appendChild(el); wrap.appendChild(kids);

  const twisty = el.querySelector('.twisty');
  let loaded = false;
  twisty.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    if (!loaded) {
      loaded = true;
      try {
        const data = await apiGet('tree', { path: entry.path });
        if (!data.entries.length) { twisty.classList.remove('has'); return; }
        for (const c of data.entries) kids.appendChild(treeItem(c, depth + 1));
      } catch { twisty.classList.remove('has'); return; }
    }
    const open = kids.classList.toggle('hidden');
    twisty.classList.toggle('open', !open);
  });
  el.addEventListener('click', () => navigate(entry.path));
  addDropTarget(el, () => entry.path);
  return wrap;
}

/* ══════════ 웹 링크 바로가기 (localStorage, 팝업 창으로 열림) ══════════ */
const LINK_ICONS = ['i-cloud', 'i-gitlab', 'i-github', 'i-drive', 'i-branch', 'i-star', 'i-apps', 'i-home',
  'i-view', 'i-eye', 'i-term', 'i-vscode', 'i-finder', 'i-info'];
state.webLinks = JSON.parse(localStorage.getItem('fx.weblinks') || '[]');
function saveWebLinks() { localStorage.setItem('fx.weblinks', JSON.stringify(state.webLinks)); }
function openWebLink(url) {
  if (window.webkit?.messageHandlers?.fxNewWindow) {
    window.webkit.messageHandlers.fxNewWindow.postMessage(url);
  } else {
    window.open(url, '_blank');
  }
}
function renderWebLinks() {
  const c = $('sideLinksList');
  c.innerHTML = '';
  state.webLinks.forEach((lk, i) => {
    const el = document.createElement('div');
    el.className = 'side-item';
    el.dataset.link = String(i);
    el.title = lk.url;
    el.innerHTML = `<span class="twisty"></span>${svgIcon(lk.icon || 'i-cloud')}<span class="label">${esc(lk.name)}</span>`;
    el.addEventListener('click', () => openWebLink(lk.url));
    c.appendChild(el);
  });
}
function webLinkModal(idx = -1) {
  const cur = idx >= 0 ? state.webLinks[idx] : { name: '', url: 'https://', icon: 'i-cloud' };
  openModal(idx >= 0 ? '링크 수정' : '웹 링크 바로가기 추가');
  $('modalBody').innerHTML =
    `<div class="lk-row"><label>이름</label><input id="lkName" type="text" value="${esc(cur.name)}" placeholder="예: S3 스토리지"></div>` +
    `<div class="lk-row"><label>주소</label><input id="lkUrl" type="text" value="${esc(cur.url)}" placeholder="https://…"></div>` +
    `<div class="lk-row"><label>아이콘</label><div class="lk-icons">` +
    LINK_ICONS.map((ic) =>
      `<button class="lk-ic${ic === (cur.icon || 'i-cloud') ? ' sel' : ''}" data-ic="${ic}">${svgIcon(ic)}</button>`).join('') +
    `</div></div>`;
  let icon = cur.icon || 'i-cloud';
  $('modalBody').querySelectorAll('.lk-ic').forEach((b) => {
    b.addEventListener('click', () => {
      $('modalBody').querySelectorAll('.lk-ic.sel').forEach((x) => x.classList.remove('sel'));
      b.classList.add('sel');
      icon = b.dataset.ic;
    });
  });
  ['lkName', 'lkUrl'].forEach((id) =>
    $(id).addEventListener('keydown', (ev) => ev.stopPropagation()));
  addModalBtn('취소', false, closeModal);
  addModalBtn(idx >= 0 ? '저장' : '추가', true, () => {
    const name = $('lkName').value.trim();
    const url = $('lkUrl').value.trim();
    if (!name) { $('lkName').focus(); return; }
    if (!/^https?:\/\/\S+$/i.test(url)) { toast('http(s):// 주소를 입력하세요', true); $('lkUrl').focus(); return; }
    const entry = { name, url, icon };
    if (idx >= 0) state.webLinks[idx] = entry;
    else state.webLinks.push(entry);
    saveWebLinks();
    renderWebLinks();
    closeModal();
  });
  $('lkName').focus();
}

/* custom favorites (persisted in localStorage) */
function isFav(p) { return state.favs.some((f) => f.path === p); }
function saveFavs() { localStorage.setItem('fx.favs', JSON.stringify(state.favs)); }
function renderFavs() {
  const c = $('sideFavsList');
  c.innerHTML = '';
  for (const f of state.favs) {
    const el = sideItem(f.name, f.path, 'star');
    el.dataset.fav = '1';
    c.appendChild(el);
  }
  updateSidebarActive();
}
function addFav(p) {
  if (isFav(p)) return;
  state.favs.push({ name: basename(p) || p, path: p });
  saveFavs(); renderFavs();
  toast('즐겨찾기에 추가했습니다');
}
function removeFav(p) {
  state.favs = state.favs.filter((f) => f.path !== p);
  saveFavs(); renderFavs();
  toast('즐겨찾기에서 제거했습니다');
}

/* sidebar right-click menu (places, favorites, tree, volumes) */
$('sidebar').addEventListener('contextmenu', (ev) => {
  ev.preventDefault();
  const item = ev.target.closest('.side-item');
  if (!item) return;
  if (item.dataset.netServer != null) { // 발견된 SMB 서버
    const name = item.dataset.netServer;
    showMenu([
      { label: '연결', icon: 'i-netdrive', action: () => item.click() },
      { label: '이름 복사', icon: 'i-copy', action: () => { navigator.clipboard.writeText(name); toast('복사했습니다'); } },
    ], ev.clientX, ev.clientY);
    return;
  }
  if (item.dataset.netName != null) { // 네트워크 드라이브
    const name = item.dataset.netName;
    const url = item.dataset.netUrl || '';
    const mounted = !!item.dataset.path;
    showMenu([
      mounted
        ? { label: '열기', icon: 'i-folder-open', action: () => navigate(item.dataset.path) }
        : { label: '다시 연결', icon: 'i-drive', action: () => reconnectNetDrive(url) },
      mounted ? { label: '추출 (마운트 해제)', icon: 'i-eject', action: () => ejectVolume(item.dataset.path) } : null,
      '-',
      url ? { label: '주소 복사', icon: 'i-copy', action: () => { navigator.clipboard.writeText(url); toast('주소를 복사했습니다'); } } : null,
      { label: '목록에서 제거', icon: 'i-trash', action: () => {
        saveNetDrives(getNetDrives().filter((d) => d.name !== name));
        refreshVolumes();
      } },
    ].filter(Boolean), ev.clientX, ev.clientY);
    return;
  }
  if (item.dataset.link != null) { // 웹 링크 바로가기
    const i = +item.dataset.link;
    const lk = state.webLinks[i];
    showMenu([
      { label: '열기', icon: 'i-folder-open', action: () => openWebLink(lk.url) },
      { label: '수정…', icon: 'i-rename', action: () => webLinkModal(i) },
      '-',
      { label: '주소 복사', icon: 'i-copy', action: () => { navigator.clipboard.writeText(lk.url); toast('주소를 복사했습니다'); } },
      { label: '제거', icon: 'i-trash', action: () => { state.webLinks.splice(i, 1); saveWebLinks(); renderWebLinks(); } },
    ], ev.clientX, ev.clientY);
    return;
  }
  if (!item.dataset.path) return;
  const p = item.dataset.path;
  showMenu([
    { label: '열기', icon: 'i-folder-open', action: () => navigate(p) },
    '-',
    { label: 'Finder에서 보기', icon: 'i-finder', action: () => apiOp({ op: 'reveal', path: p }).catch((e) => toast(e.message, true)) },
    { label: 'VS Code로 열기', icon: 'i-vscode', action: () => apiOp({ op: 'vscode', path: p }).catch((e) => toast(e.message, true)) },
    { label: '터미널에서 열기', icon: 'i-term', action: () => apiOp({ op: 'terminal', path: p }).catch((e) => toast(e.message, true)) },
    '-',
    isFav(p)
      ? { label: '즐겨찾기에서 제거', icon: 'i-star-off', action: () => removeFav(p) }
      : { label: '즐겨찾기에 추가', icon: 'i-star', action: () => addFav(p) },
    (item.dataset.eject === '1')
      ? { label: '추출 (마운트 해제)', icon: 'i-eject', action: () => ejectVolume(p) }
      : null,
    '-',
    { label: '경로 복사', icon: 'i-copy', action: () => { navigator.clipboard.writeText(p); toast('경로를 복사했습니다'); } },
    { label: '속성', icon: 'i-info', action: () => showProps(p) },
  ].filter(Boolean), ev.clientX, ev.clientY);
});

function updateSidebarActive() {
  document.querySelectorAll('.side-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.path === state.cwd);
  });
}
document.querySelectorAll('.side-head').forEach((h) => {
  h.addEventListener('click', () => {
    h.classList.toggle('collapsed');
    $(h.dataset.target).classList.toggle('hidden');
  });
});

/* ══════════ selection ══════════ */
function setSelection(paths, anchorIdx = -1) {
  state.selection = new Set(paths);
  if (anchorIdx >= 0) { state.anchor = anchorIdx; state.focusIdx = anchorIdx; }
  paintSelection();
}
function paintSelection() {
  fileList.querySelectorAll('[data-path]').forEach((el) => {
    el.classList.toggle('sel', state.selection.has(el.dataset.path));
  });
  updateStatus(); updateToolbar(); updatePreview();
}
function selectedEntries() { return state.sorted.filter((e) => state.selection.has(e.path)); }

function itemFromEvent(ev) { return ev.target.closest('[data-path]'); }

fileList.addEventListener('mousedown', (ev) => {
  if (ev.button === 2) { // right click: keep selection if on selected item
    const item = itemFromEvent(ev);
    if (item && !state.selection.has(item.dataset.path)) {
      setSelection([item.dataset.path], +item.dataset.idx);
    } else if (!item) setSelection([]);
    return;
  }
  const item = itemFromEvent(ev);
  if (!item) return;
  if (state.renaming) return;
  const idx = +item.dataset.idx, p = item.dataset.path;
  if (ev.shiftKey && state.anchor >= 0) {
    const [a, b] = [Math.min(state.anchor, idx), Math.max(state.anchor, idx)];
    setSelection(state.sorted.slice(a, b + 1).map((e) => e.path));
    state.focusIdx = idx;
  } else if (ev.metaKey || ev.ctrlKey) {
    const s = new Set(state.selection);
    s.has(p) ? s.delete(p) : s.add(p);
    state.anchor = idx; state.focusIdx = idx;
    setSelection([...s]);
  } else if (!state.selection.has(p)) {
    setSelection([p], idx);
  } else {
    state.focusIdx = idx; // click on already-selected: wait for mouseup (drag may start)
  }
});
fileList.addEventListener('mouseup', (ev) => {
  if (ev.button !== 0 || dragHappened || rubber) return;
  const item = itemFromEvent(ev);
  if (item && !ev.shiftKey && !ev.metaKey && !ev.ctrlKey && state.selection.has(item.dataset.path) && state.selection.size > 1) {
    setSelection([item.dataset.path], +item.dataset.idx);
  }
});
fileList.addEventListener('dblclick', (ev) => {
  const item = itemFromEvent(ev);
  if (!item || state.renaming) return;
  openEntry(state.sorted[+item.dataset.idx]);
});

async function openEntry(e) {
  if (!e) return;
  if (e.isDir && !e.name.endsWith('.app')) navigate(e.path);
  else {
    try { await apiOp({ op: 'open', path: e.path }); }
    catch (err) { toast(err.message, true); }
  }
}

/* rubber-band selection */
let rubber = null;
fileArea.addEventListener('mousedown', (ev) => {
  if (ev.button !== 0 || itemFromEvent(ev) || state.renaming) return;
  const areaRect = fileArea.getBoundingClientRect();
  const startX = ev.clientX - areaRect.left + fileArea.scrollLeft;
  const startY = ev.clientY - areaRect.top + fileArea.scrollTop;
  const base = ev.metaKey || ev.ctrlKey ? new Set(state.selection) : new Set();
  if (!ev.metaKey && !ev.ctrlKey) setSelection([]);
  rubber = { startX, startY, base };
  ev.preventDefault();
});
window.addEventListener('mousemove', (ev) => {
  if (!rubber) return;
  const areaRect = fileArea.getBoundingClientRect();
  const curX = Math.max(0, ev.clientX - areaRect.left) + fileArea.scrollLeft;
  const curY = Math.max(0, ev.clientY - areaRect.top) + fileArea.scrollTop;
  const x = Math.min(rubber.startX, curX), y = Math.min(rubber.startY, curY);
  const w = Math.abs(curX - rubber.startX), h = Math.abs(curY - rubber.startY);
  const rb = $('rubber');
  rb.classList.remove('hidden');
  Object.assign(rb.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
  // auto-scroll
  if (ev.clientY > areaRect.bottom - 24) fileArea.scrollTop += 12;
  else if (ev.clientY < areaRect.top + 24) fileArea.scrollTop -= 12;

  const sel = new Set(rubber.base);
  fileList.querySelectorAll('[data-path]').forEach((el) => {
    const r = el.getBoundingClientRect();
    const ex = r.left - areaRect.left + fileArea.scrollLeft;
    const ey = r.top - areaRect.top + fileArea.scrollTop;
    if (ex < x + w && ex + r.width > x && ey < y + h && ey + r.height > y) sel.add(el.dataset.path);
  });
  state.selection = sel;
  paintSelection();
});
window.addEventListener('mouseup', () => {
  if (rubber) { rubber = null; $('rubber').classList.add('hidden'); }
});

/* ══════════ drag & drop (move / alt=copy) ══════════ */
let dragHappened = false;
let draggedPaths = null; // paths of an in-flight drag from this window
window.fxNativeDragEnded = () => { // called by the native shell when its drag session ends
  draggedPaths = null;
  dragHappened = false;
  document.querySelectorAll('.drop-target').forEach((x) => x.classList.remove('drop-target'));
};
// native shell drop of our own drag. rules, like Finder but window-aware:
//   same window  → move  (⌥ = copy)
//   other window → copy  (⌥ = move)
window.fxInternalDrop = async (x, y, paths, alt, sameWindow) => {
  const el = document.elementFromPoint(x, y);
  let dest = state.cwd;
  const item = el?.closest?.('[data-path]');
  if (item) {
    const e = state.sorted[+item.dataset.idx];
    if (e?.isDir && !e.name.endsWith('.app')) dest = e.path;
  }
  const side = el?.closest?.('.side-item');
  if (side?.dataset.path) dest = side.dataset.path;
  if (!dest) return;
  const move = sameWindow ? !alt : alt;
  if (paths.some((p) => dest === p || dest.startsWith(p + '/'))) return;
  if (move && paths.every((p) => p.slice(0, p.lastIndexOf('/')) === dest)) return; // same-dir move: no-op
  try {
    await apiOp({ op: move ? 'move' : 'copy', dest, paths });
    toast(`${paths.length}개 항목을 ${move ? '이동' : '복사'}했습니다`);
    refresh();
  } catch (e) { toast(e.message, true); }
};
function dragPathsFrom(ev) { // internal drag payload: HTML5 data or the native-drag fallback
  const raw = ev.dataTransfer.getData('application/x-fx-paths');
  if (raw) return JSON.parse(raw);
  return draggedPaths;
}
function isInternalDrag(ev) {
  return [...ev.dataTransfer.types].includes('application/x-fx-paths') || !!draggedPaths;
}
fileList.addEventListener('dragstart', (ev) => {
  if (state.renaming) { ev.preventDefault(); return; } // 이름 편집 중 텍스트 드래그 보호
  const item = itemFromEvent(ev);
  if (!item) { ev.preventDefault(); return; }
  if (!state.selection.has(item.dataset.path)) setSelection([item.dataset.path], +item.dataset.idx);
  dragHappened = true;
  draggedPaths = [...state.selection];
  // native shell: replace the HTML5 drag with a real macOS drag session so
  // files can be dropped into Finder / other apps (folders & multi-select too)
  if (window.webkit?.messageHandlers?.fxDrag) {
    ev.preventDefault();
    window.webkit.messageHandlers.fxDrag.postMessage(draggedPaths);
    return;
  }
  ev.dataTransfer.effectAllowed = 'copyMove';
  ev.dataTransfer.setData('application/x-fx-paths', JSON.stringify(draggedPaths));
  // browser fallback: single file can drag out via Chrome's DownloadURL
  if (state.selection.size === 1) {
    const e = state.sorted.find((x) => state.selection.has(x.path));
    if (e && !e.isDir) {
      const url = `${location.origin}/api/file?path=${encodeURIComponent(e.path)}`;
      ev.dataTransfer.setData('DownloadURL', `application/octet-stream:${e.name}:${url}`);
    }
  }
});

/* Finder → app: drop real files/folders, streamed up and written into cwd */
async function uploadDropped(items, destDir) {
  const entries = items.map((it) => it.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return;
  const files = [];
  const readAll = (r) => new Promise((resolve, reject) => {
    const all = [];
    const loop = () => r.readEntries((batch) => {
      if (!batch.length) resolve(all);
      else { all.push(...batch); loop(); }
    }, reject);
    loop();
  });
  const walk = async (en, prefix) => {
    if (en.isFile) {
      const f = await new Promise((res, rej) => en.file(res, rej));
      files.push({ f, rel: prefix + en.name });
    } else if (en.isDirectory) {
      for (const kid of await readAll(en.createReader())) await walk(kid, `${prefix}${en.name}/`);
    }
  };
  try {
    for (const en of entries) await walk(en, '');
  } catch { toast('폴더를 읽을 수 없습니다', true); return; }
  if (!files.length) return;
  let done = 0;
  for (const { f, rel } of files) {
    toast(`복사 중… (${++done}/${files.length}) ${rel}`);
    const r = await fetch(`/api/upload?dir=${encodeURIComponent(destDir)}&name=${encodeURIComponent(rel)}`, {
      method: 'POST', body: f,
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      toast(`복사 실패: ${j.error || r.status}`, true);
      refresh();
      return;
    }
  }
  toast(`${files.length}개 파일을 복사했습니다`);
  refresh();
}
fileArea.addEventListener('dragover', (ev) => {
  if (draggedPaths) return; // our own native drag — internal handlers deal with it
  if ([...ev.dataTransfer.types].includes('Files')) {
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
  }
});
fileArea.addEventListener('drop', (ev) => {
  if (draggedPaths) return; // our own native drag
  if (![...ev.dataTransfer.types].includes('Files')) return;
  ev.preventDefault();
  // drop onto a folder row → into that folder, otherwise into the current dir
  const item = itemFromEvent(ev);
  const target = item && state.sorted[+item.dataset.idx];
  const dest = target?.isDir ? target.path : state.cwd;
  fileList.querySelectorAll('.drop-target').forEach((x) => x.classList.remove('drop-target'));
  uploadDropped([...ev.dataTransfer.items], dest);
});
fileList.addEventListener('dragend', () => { setTimeout(() => { dragHappened = false; draggedPaths = null; }, 0); });

function addDropTarget(el, getPath) {
  el.addEventListener('dragover', (ev) => {
    if (!isInternalDrag(ev)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = ev.altKey ? 'copy' : 'move';
    el.classList.add('drop-target');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
  el.addEventListener('drop', async (ev) => {
    if (!isInternalDrag(ev)) return;
    ev.preventDefault(); ev.stopPropagation();
    el.classList.remove('drop-target');
    const paths = dragPathsFrom(ev);
    if (!paths) return;
    const dest = getPath();
    if (!dest || paths.includes(dest)) return;
    if (paths.some((p) => dest === p || dest.startsWith(p + '/'))) { toast('폴더를 자기 자신 안으로 이동할 수 없습니다', true); return; }
    try {
      await apiOp({ op: ev.altKey ? 'copy' : 'move', dest, paths });
      toast(`${paths.length}개 항목을 ${ev.altKey ? '복사' : '이동'}했습니다`);
      refresh();
    } catch (e) { toast(e.message, true); }
  });
}
// folder rows/tiles as drop targets (event delegation)
fileList.addEventListener('dragover', (ev) => {
  const item = itemFromEvent(ev);
  if (!item) return;
  const e = state.sorted[+item.dataset.idx];
  if (!e?.isDir || state.selection.has(e.path)) return;
  if (!isInternalDrag(ev)) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = ev.altKey ? 'copy' : 'move';
  fileList.querySelectorAll('.drop-target').forEach((x) => x.classList.remove('drop-target'));
  item.classList.add('drop-target');
});
fileList.addEventListener('dragleave', (ev) => {
  const item = itemFromEvent(ev);
  if (item) item.classList.remove('drop-target');
});
fileList.addEventListener('drop', async (ev) => {
  const item = itemFromEvent(ev);
  fileList.querySelectorAll('.drop-target').forEach((x) => x.classList.remove('drop-target'));
  if (!item || !isInternalDrag(ev)) return;
  const e = state.sorted[+item.dataset.idx];
  if (!e?.isDir) return;
  ev.preventDefault();
  ev.stopPropagation();
  const paths = dragPathsFrom(ev);
  draggedPaths = null;
  if (!paths) return;
  if (paths.some((p) => e.path === p || e.path.startsWith(p + '/'))) return;
  try {
    await apiOp({ op: ev.altKey ? 'copy' : 'move', dest: e.path, paths });
    toast(`${paths.length}개 항목을 ${ev.altKey ? '복사' : '이동'}했습니다`);
    refresh();
  } catch (err) { toast(err.message, true); }
});

/* ══════════ clipboard ops ══════════ */
let clipboardWrite = Promise.resolve();
let pasteInProgress = false;
function doCopy(cut = false) {
  if (!state.selection.size) return;
  const paths = [...state.selection];
  const clipboard = { mode: cut ? 'cut' : 'copy', paths, synced: false };
  state.clipboard = clipboard;
  render();
  // put real file references on the macOS clipboard too, so Finder ⌘V and
  // other explorer windows can paste what we copied
  clipboardWrite = clipboardWrite.then(async () => {
    try {
      await apiOp({ op: 'setPasteboard', paths, mode: clipboard.mode });
      clipboard.synced = true;
    } catch {
      toast('시스템 클립보드에 쓰지 못했습니다. 이 창에서는 붙여넣을 수 있습니다.', true);
    }
  });
  toast(`${paths.length}개 항목 ${cut ? '잘라내기' : '복사'}`);
}
async function doPaste() {
  if (state.searchMode || !state.cwd || pasteInProgress) return;
  pasteInProgress = true;
  const dest = state.cwd;
  try {
    // Wait for all locally queued writes before reading the system clipboard.
    let pending;
    do { pending = clipboardWrite; await pending; } while (pending !== clipboardWrite);
    const clipboard = state.clipboard;
    let sys = { paths: [], cut: false, readable: false };
    try { sys = await apiGet('pasteboard', {}); } catch { /* local fallback */ }
    let paths = sys.paths, move = sys.cut;
    if (clipboard && (!clipboard.synced || sys.readable === false)) {
      paths = clipboard.paths;
      move = clipboard.mode === 'cut';
    }
    if (!paths.length) { toast('붙여넣을 항목이 없습니다'); return; }
    toast(`${paths.length}개 항목을 ${move ? '이동' : '복사'}하는 중…`);
    const { results } = await apiOp({ op: move ? 'move' : 'copy', dest, paths, reportResults: true });
    const completed = results.filter((r) => r.status === 'completed');
    const failed = results.filter((r) => r.status === 'failed');
    const skipped = results.filter((r) => r.status === 'skipped');
    if (move && state.clipboard === clipboard) {
      const remaining = results.filter((r) => r.status !== 'completed').map((r) => r.source);
      state.clipboard = remaining.length ? { mode: 'cut', paths: remaining, synced: sys.cut && sys.readable !== false } : null;
    }
    const summary = `${completed.length}개 ${move ? '이동' : '복사'} 완료` +
      (skipped.length ? `, ${skipped.length}개는 같은 폴더여서 건너뜀` : '') +
      (failed.length ? `, ${failed.length}개 실패` : '');
    toast(summary, failed.length > 0);
    if (failed.length) {
      textModal('붙여넣기 결과', `${summary}\n\n${failed.map((r) => `${r.source}\n${r.error}`).join('\n\n')}` +
        (move ? '\n\n이동하지 못한 항목은 잘라내기 목록에 남아 있습니다. 원인을 해결한 뒤 다시 붙여넣으세요.' : ''));
    }
  } catch (e) { toast(e.message, true); }
  finally {
    pasteInProgress = false;
    refresh();
  }
}
async function doTrash() {
  const sel = selectedEntries();
  if (!sel.length) return;
  try {
    await apiOp({ op: 'trash', paths: sel.map((e) => e.path) });
    toast(`${sel.length}개 항목을 휴지통으로 이동했습니다`);
    state.selection.clear();
    refresh();
  } catch (e) { toast(e.message, true); }
}

/* ══════════ rename / new ══════════ */
function startRename(path) {
  const el = fileList.querySelector(`[data-path="${CSS.escape(path)}"]`);
  if (!el) return;
  const nmEl = el.querySelector('.nm');
  if (!nmEl) return;
  const entry = state.sorted[+el.dataset.idx];
  state.renaming = true;
  el.draggable = false; // 입력창 안에서 텍스트를 드래그로 선택할 수 있게
  const input = document.createElement('input');
  input.className = 'rename';
  input.value = entry.name;
  nmEl.replaceWith(input);
  input.focus();
  const dot = entry.isDir ? -1 : entry.name.lastIndexOf('.');
  input.setSelectionRange(0, dot > 0 ? dot : entry.name.length);

  let done = false;
  const finish = async (commit) => {
    if (done) return; done = true;
    state.renaming = false;
    const newName = input.value.trim();
    if (commit && newName && newName !== entry.name) {
      try {
        const r = await apiOp({ op: 'rename', path: entry.path, name: newName });
        state.selection = new Set([r.path]);
      } catch (e) { toast(e.message, true); }
    }
    refresh();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('mousedown', (e) => e.stopPropagation());
  input.addEventListener('dblclick', (e) => e.stopPropagation());
}

async function createNew(kind) {
  try {
    const r = await apiOp(
      kind === 'folder'
        ? { op: 'mkdir', dir: state.cwd, name: '새 폴더' }
        : { op: 'newfile', dir: state.cwd, name: '새 텍스트 문서.txt' }
    );
    await refreshAndSelect(r.path);
    startRename(r.path);
  } catch (e) { toast(e.message, true); }
}
async function refreshAndSelect(path) {
  const data = await apiGet('list', listQuery(state.cwd));
  state.entries = data.entries;
  state.selection = new Set([path]);
  render();
  const el = fileList.querySelector(`[data-path="${CSS.escape(path)}"]`);
  if (el) { el.scrollIntoView({ block: 'nearest' }); state.focusIdx = +el.dataset.idx; state.anchor = state.focusIdx; }
}

/* ══════════ search ══════════ */
let searchTimer = null;
$('searchInput').addEventListener('input', () => {
  $('searchClear').classList.toggle('hidden', !$('searchInput').value);
});
$('searchInput').addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    const q = $('searchInput').value.trim();
    if (!q) return;
    await runSearch(q);
  } else if (e.key === 'Escape') {
    $('searchInput').value = '';
    $('searchClear').classList.add('hidden');
    exitSearchMode(true);
  }
});
$('searchClear').addEventListener('click', () => {
  $('searchInput').value = '';
  $('searchClear').classList.add('hidden');
  exitSearchMode(true);
});
async function runSearch(q) {
  const root = state.searchRoot || state.cwd;
  state.searchRoot = root;
  state.lastQuery = q;
  toast('검색 중…');
  try {
    const data = await apiGet('search', { ...listQuery(root), q });
    state.searchMode = true;
    state.entries = data.results;
    state.selection.clear(); state.anchor = -1;
    render();
    hideToast();
    $('statCount').textContent = `검색 결과 ${data.results.length}개${data.results.length >= 500 ? ' (최대치)' : ''}`;
  } catch (e) { toast(e.message, true); }
}
function exitSearchMode(rerender) {
  if (!state.searchMode) return;
  state.searchMode = false;
  state.searchRoot = null;
  state.lastQuery = null;
  if (rerender) navigate(state.cwd, { push: false });
}

/* ══════════ 텍스트 미리보기: JSON/YAML 컬러 하이라이트 + Pretty 모드 ══════════ */
const JSON_EXTS = ['json', 'jsonc', 'jsonl', 'json5'];
const YAML_EXTS = ['yml', 'yaml'];

function hlJson(src) {
  const re = /("(?:[^"\\\n]|\\.)*")(\s*:)|("(?:[^"\\\n]|\\.)*")|(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|\b(true|false|null)\b/g;
  let out = '', last = 0, m;
  while ((m = re.exec(src))) {
    out += esc(src.slice(last, m.index));
    if (m[1]) out += `<span class="tok-key">${esc(m[1])}</span>${esc(m[2])}`;
    else if (m[3]) out += `<span class="tok-str">${esc(m[3])}</span>`;
    else if (m[4]) out += `<span class="tok-comment">${esc(m[4])}</span>`;
    else if (m[5]) out += `<span class="tok-num">${esc(m[5])}</span>`;
    else out += `<span class="tok-bool">${esc(m[6])}</span>`;
    last = re.lastIndex;
  }
  return out + esc(src.slice(last));
}
function hlYamlValue(s) {
  const strs = [];
  let t = esc(s).replace(/(&quot;(?:(?!&quot;)[\s\S])*&quot;|&#39;(?:(?!&#39;)[\s\S])*&#39;)/g, (mm) => {
    strs.push(mm);
    return ` ${strs.length - 1} `;
  });
  t = t
    .replace(/(^|\s)(#.*)$/, (mm, a, b) => `${a}<span class="tok-comment">${b}</span>`)
    .replace(/\b(true|false|null|~|yes|no|on|off)\b/gi, '<span class="tok-bool">$1</span>')
    .replace(/(?<![\w.#&-])(-?\d+(?:\.\d+)?)(?![\w.])/g, '<span class="tok-num">$1</span>');
  return t.replace(/ (\d+) /g, (_, i) => `<span class="tok-str">${strs[+i]}</span>`);
}
function hlYaml(src) {
  return src.split('\n').map((line) => {
    const cm = /^(\s*)(#.*)$/.exec(line);
    if (cm) return esc(cm[1]) + `<span class="tok-comment">${esc(cm[2])}</span>`;
    const km = /^(\s*(?:-\s+)?)([^:\s#][^:]*?)(:)(\s.*|$)/.exec(line);
    if (km) return esc(km[1]) + `<span class="tok-key">${esc(km[2])}</span>` + esc(km[3]) + hlYamlValue(km[4]);
    return hlYamlValue(line);
  }).join('\n');
}
const SHELL_EXTS = ['sh', 'zsh', 'bash', 'command'];
function hlShell(src) {
  const re = new RegExp(
    '(#[^\\n]*)' +                                        // 주석
    '|("(?:[^"\\\\]|\\\\[\\s\\S])*")' +                   // "문자열"
    "|('[^']*')" +                                        // '문자열'
    '|(\\$\\{[^}]*\\}|\\$\\([^)]*\\)|\\$[\\w#@?$!*0-9-]+)' + // 변수/치환
    '|\\b(if|then|else|elif|fi|for|while|until|do|done|case|esac|in|function|select|local|export|return|break|continue|readonly|declare|set|unset|shift|source|exit|trap|eval|exec|echo|printf|cd)\\b',
    'g');
  let out = '', last = 0, m;
  while ((m = re.exec(src))) {
    out += esc(src.slice(last, m.index));
    if (m[1]) out += `<span class="tok-comment">${esc(m[1])}</span>`;
    else if (m[2] || m[3]) out += `<span class="tok-str">${esc(m[2] || m[3])}</span>`;
    else if (m[4]) out += `<span class="tok-var">${esc(m[4])}</span>`;
    else out += `<span class="tok-key">${esc(m[5])}</span>`;
    last = re.lastIndex;
  }
  return out + esc(src.slice(last));
}

// highlight.js 언어 매핑 (번들된 common 빌드 기준)
const HLJS_LANG = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python', rb: 'ruby', c: 'c', cpp: 'cpp', h: 'cpp', hpp: 'cpp', mm: 'objectivec',
  cs: 'csharp', java: 'java', go: 'go', rs: 'rust', swift: 'swift', kt: 'kotlin',
  php: 'php', sql: 'sql', css: 'css', html: 'xml', xml: 'xml', plist: 'xml', lua: 'lua',
  sh: 'bash', zsh: 'bash', bash: 'bash', command: 'bash',
  json: 'json', jsonc: 'json', jsonl: 'json', json5: 'json',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', conf: 'ini', md: 'markdown',
  bat: 'dos', cmd: 'dos', ps1: 'powershell',
};
// 하이라이트: highlight.js 우선, 실패 시 자체 구현(json/yaml/shell) 폴백
function hlCode(body, ext) {
  const lang = HLJS_LANG[ext];
  if (window.hljs && lang) {
    try { return hljs.highlight(body, { language: lang }).value; } catch { /* fallback */ }
  }
  if (JSON_EXTS.includes(ext)) return hlJson(body);
  if (YAML_EXTS.includes(ext)) return hlYaml(body);
  if (SHELL_EXTS.includes(ext)) return hlShell(body);
  return null;
}

// ── tsv/csv 그리드 뷰 ──
const SHEET_EXTS = ['tsv', 'csv'];
function parseDSV(text, sep) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += ch;
    } else if (ch === '"' && sep === ',' && field === '') inQ = true;
    else if (ch === sep) { row.push(field); field = ''; }
    else if (ch === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
      if (rows.length > 2000) return rows; // 표시 상한
    } else if (ch !== '\r') field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}
function sheetHtml(text, ext, truncated) {
  const rows = parseDSV(text, ext === 'tsv' ? '\t' : ',');
  if (!rows.length) return '<div class="pv-empty">내용 없음</div>';
  const cols = Math.max(...rows.slice(0, 100).map((r) => r.length));
  const head = rows[0];
  let h = '<table><thead><tr><th class="rn">#</th>';
  for (let j = 0; j < cols; j++) h += `<th>${esc(head[j] ?? '')}</th>`;
  h += '</tr></thead><tbody>';
  for (let i = 1; i < rows.length; i++) {
    h += `<tr><td class="rn">${i}</td>`;
    for (let j = 0; j < cols; j++) h += `<td>${esc(rows[i][j] ?? '')}</td>`;
    h += '</tr>';
  }
  h += '</tbody></table>';
  if (truncated || rows.length > 2000) h += '<div class="pv-note">… (일부만 표시)</div>';
  return h;
}

// pretty 변환 (파싱 실패 시 null → 원본 유지)
function prettyJson(text, ext) {
  try {
    if (ext === 'jsonl') {
      return text.split('\n').filter((l) => l.trim())
        .map((l) => JSON.stringify(JSON.parse(l), null, 2)).join('\n\n');
    }
    let src = text;
    if (ext === 'jsonc' || ext === 'json5') {
      src = src.replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/,\s*([}\]])/g, '$1');
    }
    return JSON.stringify(JSON.parse(src), null, 2);
  } catch { return null; }
}
// ── 알 수 없는 파일: 텍스트 판별 → 텍스트/hex 뷰 ──
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function isTextBytes(bytes) {
  const n = Math.min(bytes.length, 8192);
  if (!n) return true;
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const b = bytes[i];
    if (b === 0) return false;               // 널바이트 = 바이너리
    if (b < 9 || (b > 13 && b < 32)) bad++;  // 제어 문자
  }
  return bad / n < 0.08;
}
function hexDump(bytes) {
  const lines = [];
  for (let o = 0; o < bytes.length; o += 16) {
    const chunk = bytes.subarray(o, o + 16);
    let hex = '', ascii = '';
    for (let i = 0; i < 16; i++) {
      if (i < chunk.length) {
        const b = chunk[i];
        hex += b.toString(16).padStart(2, '0') + ' ';
        ascii += b >= 32 && b < 127 ? String.fromCharCode(b) : '·';
      } else hex += '   ';
      if (i === 7) hex += ' ';
    }
    lines.push(`${o.toString(16).padStart(8, '0')}  ${hex} |${ascii}|`);
  }
  return lines.join('\n');
}
// 파일 앞부분을 읽어 텍스트/hex로 렌더 (barTarget: 툴바를 붙일 곳)
async function loadRawPreview(container, e, barTarget) {
  container.innerHTML = '<div class="pv-empty">불러오는 중…</div>';
  try {
    const d = await apiGet('head', { path: e.path });
    const bytes = b64ToBytes(d.b64);
    if (isTextBytes(bytes)) {
      renderTextPreview(container, e, {
        text: new TextDecoder().decode(bytes),
        truncated: d.truncated,
      });
    } else {
      renderTextPreview(container, { ...e, ext: 'hex' }, {
        text: hexDump(bytes),
        truncated: d.truncated,
      });
    }
    if (pvPendingBar && barTarget) { barTarget.prepend(pvPendingBar); pvPendingBar = null; }
  } catch (err) {
    container.innerHTML = `<div class="pv-empty">${esc(err.message)}</div>`;
  }
}

// 미리보기 내 검색: 텍스트 노드를 순회하며 <mark>로 감싼다 (태그 안전)
function highlightSearch(root, q) {
  root.querySelectorAll('mark.pv-hit').forEach((m) => {
    m.replaceWith(document.createTextNode(m.textContent));
  });
  root.normalize();
  if (!q) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  const ql = q.toLowerCase();
  for (const node of nodes) {
    let cur = node, idx;
    while (cur && (idx = cur.nodeValue.toLowerCase().indexOf(ql)) >= 0) {
      const hit = cur.splitText(idx);
      const rest = hit.splitText(q.length);
      const mark = document.createElement('mark');
      mark.className = 'pv-hit';
      mark.textContent = hit.nodeValue;
      hit.replaceWith(mark);
      cur = rest;
    }
  }
}

function renderTextPreview(content, e, t) {
  const isJson = JSON_EXTS.includes(e.ext);
  const isMd = (e.ext === 'md' || e.ext === 'markdown') && !!window.marked;
  const isHex = e.ext === 'hex';
  const isSheet = SHEET_EXTS.includes(e.ext);
  const wrap = document.createElement('div');
  wrap.className = 'pv-textwrap';
  let applySearch = () => {};
  const render = () => {
    wrap.querySelector('pre, .pv-md, .pv-grid')?.remove();
    let body = t.text;
    let note = t.truncated ? '… (일부만 표시)' : '';
    if (isJson && state.previewPretty) {
      const p = prettyJson(t.text, e.ext);
      if (p != null) body = p;
      else if (!t.truncated) note = '(JSON 파싱 실패 — 원본 표시)';
    }
    if (isSheet && !state.previewSheetRaw) {
      const div = document.createElement('div');
      div.className = 'pv-grid';
      div.innerHTML = sheetHtml(body, e.ext, t.truncated);
      wrap.appendChild(div);
      applySearch();
      return;
    }
    if (isMd && !state.previewMdRaw) {
      const div = document.createElement('div');
      div.className = 'pv-md';
      try {
        div.innerHTML = marked.parse(body) +
          (note ? `<p class="pv-note">${esc(note)}</p>` : '');
        // 렌더된 마크다운 안의 코드 블록도 하이라이트
        if (window.hljs) div.querySelectorAll('pre code').forEach((c) => { try { hljs.highlightElement(c); } catch { /* ignore */ } });
        wrap.appendChild(div);
        return;
      } catch { /* 파싱 실패 → 아래 일반 경로 */ }
    }
    const pre = document.createElement('pre');
    const hl = hlCode(body, e.ext);
    if (hl != null) {
      pre.className = 'pv-code hljs';
      pre.innerHTML = hl + (note ? `\n<span class="tok-comment">${esc(note)}</span>` : '');
    } else {
      pre.textContent = body + (note ? `\n${note}` : '');
    }
    pre.classList.toggle('nowrap', isHex || !state.previewWrap);
    wrap.appendChild(pre);
    applySearch();
  };

  // ── 툴바(아이콘): 하단 파일 정보 영역에 표시됨 ──
  const bar = document.createElement('div');
  bar.className = 'pv-bar';
  const iconBtn = (icon, title) => {
    const b = document.createElement('button');
    b.title = title;
    b.innerHTML = svgIcon(icon, 'ic sm');
    return b;
  };
  if (isJson || isMd || isSheet) {
    const btn = iconBtn(isJson ? 'i-braces' : isSheet ? 'i-view' : 'i-angle',
      isJson ? 'Pretty JSON 켬/끔' : isSheet ? '그리드 보기 켬/끔' : '원본(Raw) 보기 켬/끔');
    const paint = () => btn.classList.toggle('on',
      isJson ? !!state.previewPretty : isSheet ? !state.previewSheetRaw : !!state.previewMdRaw);
    btn.addEventListener('click', () => {
      if (isJson) {
        state.previewPretty = !state.previewPretty;
        localStorage.setItem('fx.pretty', state.previewPretty ? '1' : '0');
      } else if (isSheet) {
        state.previewSheetRaw = !state.previewSheetRaw;
        localStorage.setItem('fx.sheetraw', state.previewSheetRaw ? '1' : '0');
      } else {
        state.previewMdRaw = !state.previewMdRaw;
        localStorage.setItem('fx.mdraw', state.previewMdRaw ? '1' : '0');
      }
      paint(); render();
    });
    paint();
    bar.appendChild(btn);
  }
  if (!isHex) { // hex 뷰는 항상 고정폭·가로 스크롤
    const wrapBtn = iconBtn('i-wrap', '줄바꿈 켬/끔 (끄면 가로 스크롤)');
    const paintWrap = () => wrapBtn.classList.toggle('on', !!state.previewWrap);
    wrapBtn.addEventListener('click', () => {
      state.previewWrap = !state.previewWrap;
      localStorage.setItem('fx.wrap', state.previewWrap ? '1' : '0');
      paintWrap();
      wrap.querySelector('pre')?.classList.toggle('nowrap', !state.previewWrap);
    });
    paintWrap();
    bar.appendChild(wrapBtn);
  }

  const searchBtn = iconBtn('i-search', '내용 검색');
  const sin = document.createElement('input');
  sin.type = 'search';
  sin.placeholder = '내용 검색';
  sin.className = 'pv-search hidden';
  const cnt = document.createElement('span');
  cnt.className = 'pv-count hidden';
  let hits = [], hi = -1, sTimer = null;
  const nav = (d) => {
    if (!hits.length) return;
    hits[hi]?.classList.remove('cur');
    hi = (hi + d + hits.length) % hits.length;
    hits[hi].classList.add('cur');
    hits[hi].scrollIntoView({ block: 'center' });
    cnt.textContent = `${hi + 1}/${hits.length}`;
  };
  applySearch = () => {
    const root = wrap.querySelector('pre, .pv-md, .pv-grid');
    if (!root) return;
    highlightSearch(root, sin.value.trim());
    hits = [...root.querySelectorAll('mark.pv-hit')];
    hi = -1;
    cnt.textContent = sin.value.trim() ? `${hits.length}개` : '';
    if (hits.length) nav(1);
  };
  const closeSearch = () => {
    sin.value = '';
    applySearch();
    sin.classList.add('hidden');
    cnt.classList.add('hidden');
    searchBtn.classList.remove('on');
  };
  searchBtn.addEventListener('click', () => {
    if (sin.classList.contains('hidden')) {
      sin.classList.remove('hidden');
      cnt.classList.remove('hidden');
      searchBtn.classList.add('on');
      sin.focus();
    } else {
      closeSearch();
    }
  });
  sin.addEventListener('input', () => { clearTimeout(sTimer); sTimer = setTimeout(applySearch, 250); });
  sin.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') nav(ev.shiftKey ? -1 : 1);
    if (ev.key === 'Escape') closeSearch();
  });
  bar.appendChild(searchBtn);
  bar.appendChild(sin);
  bar.appendChild(cnt);
  pvPendingBar = bar; // updatePreview가 하단 정보 영역에 붙임

  render();
  content.innerHTML = '';
  content.appendChild(wrap);
}
let pvPendingBar = null;

/* ══════════ 파일 뷰어 (전용 창): 모든 미리보기 타입 + 줌/회전/이전·다음 ══════════ */
function openMediaViewer(path) {
  openViewWindow('viewer=1', path);
}
async function initViewer(filePath) {
  document.body.classList.add('tool-mode');
  $('viewer').classList.remove('hidden');
  const canvas = $('viewerCanvas');
  const dir = filePath.slice(0, filePath.lastIndexOf('/')) || '/';
  let files = [], idx = -1;
  try {
    const data = await apiGet('list', listQuery(dir));
    files = data.entries
      .filter((x) => !x.isDir) // 모든 파일 — 타입별로 알맞게 렌더 (이미지/영상/오디오/PDF/텍스트/기타)
      .sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }));
    idx = files.findIndex((x) => x.path === filePath);
  } catch { /* 이웃 탐색 실패 시 단일 파일만 */ }
  if (idx < 0) { files = [{ path: filePath, name: basename(filePath), ext: filePath.split('.').pop().toLowerCase(), isDir: false, size: 0 }]; idx = 0; }

  let scale = null; // null = 화면 맞춤
  let rot = 0;
  const cur = () => files[idx];
  const kind = () => entryKind(cur());
  const isVid = () => kind() === 'vid';
  const isImg = () => kind() === 'img';

  const paintZoom = () => {
    $('vwZoom').textContent = scale == null ? '맞춤' : `${Math.round(scale * 100)}%`;
    ['vwZoomIn', 'vwZoomOut', 'vwFit', 'vwOrig', 'vwRot'].forEach((id) => { $(id).disabled = !isImg(); });
  };
  const applyTransform = () => {
    const img = canvas.querySelector('img');
    if (!img) return;
    img.style.transform = rot ? `rotate(${rot}deg)` : '';
    if (scale == null) {
      img.classList.add('fit');
      img.style.width = '';
    } else {
      img.classList.remove('fit');
      img.style.width = `${img.naturalWidth * scale}px`;
    }
    paintZoom();
  };
  const show = async () => {
    const e = cur();
    const k = entryKind(e);
    document.title = `${displayName(e)} — 뷰어`;
    $('vwName').textContent = displayName(e);
    $('vwCount').textContent = files.length > 1 ? `${idx + 1}/${files.length}` : '';
    const url = `/api/file?path=${encodeURIComponent(e.path)}`;
    scale = null; rot = 0;
    if (k === 'img') {
      canvas.innerHTML = `<img src="${url}" class="fit" alt="">`;
      canvas.querySelector('img').addEventListener('load', applyTransform);
    } else if (k === 'vid') {
      canvas.innerHTML = `<video src="${url}" controls autoplay></video>`;
    } else if (k === 'aud') {
      canvas.innerHTML =
        `<div class="vw-center">` +
        `<img class="pv-bigicon" src="/api/sysicon?path=${encodeURIComponent(e.path)}&size=256" alt="">` +
        `<audio src="${url}" controls autoplay></audio></div>`;
    } else if (k === 'pdf') {
      canvas.innerHTML = `<iframe class="vw-frame" src="${url}"></iframe>`;
    } else if (isTextKind(k)) {
      canvas.innerHTML = '<div class="pv-empty">불러오는 중…</div>';
      const my = e.path;
      try {
        const t = await apiGet('text', { path: e.path });
        if (cur().path !== my) return; // 그새 다른 파일로 넘어감
        const box = document.createElement('div');
        box.className = 'vw-text';
        canvas.innerHTML = '';
        canvas.appendChild(box);
        renderTextPreview(box, e, t);
        if (pvPendingBar) { box.prepend(pvPendingBar); pvPendingBar = null; }
      } catch (err) {
        if (cur().path === my) canvas.innerHTML = `<div class="pv-empty">${esc(err.message)}</div>`;
      }
    } else {
      // 알 수 없는 형식: 텍스트/hex 자동 판별 (미리보기 pane과 동일)
      const box = document.createElement('div');
      box.className = 'vw-text';
      canvas.innerHTML = '';
      canvas.appendChild(box);
      await loadRawPreview(box, e, box);
    }
    paintZoom();
  };
  const nav = (d) => {
    if (files.length < 2) return;
    idx = (idx + d + files.length) % files.length;
    show();
  };
  const zoom = (factor) => {
    if (!isImg()) return;
    const img = canvas.querySelector('img');
    if (!img || !img.naturalWidth) return;
    if (scale == null) scale = img.getBoundingClientRect().width / img.naturalWidth; // 맞춤 배율에서 시작
    scale = Math.min(16, Math.max(0.05, scale * factor));
    applyTransform();
  };
  $('vwPrev').addEventListener('click', () => nav(-1));
  $('vwNext').addEventListener('click', () => nav(1));
  $('vwZoomIn').addEventListener('click', () => zoom(1.25));
  $('vwZoomOut').addEventListener('click', () => zoom(1 / 1.25));
  $('vwFit').addEventListener('click', () => { scale = null; applyTransform(); });
  $('vwOrig').addEventListener('click', () => { scale = 1; applyTransform(); });
  $('vwRot').addEventListener('click', () => { rot = (rot + 90) % 360; applyTransform(); });
  $('vwOpen').addEventListener('click', () => apiOp({ op: 'open', path: cur().path }).catch((e2) => toast(e2.message, true)));
  canvas.addEventListener('wheel', (ev) => {
    if (!isImg()) return; // 텍스트/PDF 등은 자체 스크롤 사용
    ev.preventDefault();
    zoom(ev.deltaY < 0 ? 1.15 : 1 / 1.15);
  }, { passive: false });
  window.addEventListener('keydown', (ev) => {
    if (ev.target.tagName === 'INPUT') return;
    if (ev.key === 'ArrowLeft') nav(-1);
    else if (ev.key === 'ArrowRight') nav(1);
    else if (ev.key === '+' || ev.key === '=') zoom(1.25);
    else if (ev.key === '-') zoom(1 / 1.25);
    else if (ev.key === '0') { scale = null; applyTransform(); }
    else if (ev.key === '1') { scale = 1; applyTransform(); }
    else if (ev.key === 'r' || ev.key === 'R') { rot = (rot + 90) % 360; applyTransform(); }
    else if (ev.key === 'Escape') closeToolWindow();
  }, true);
  show();
}

/* 파일 미리보기 모달 — 미리보기 창이 꺼져 있어도 동일한 뷰 제공 */
async function previewFileModal(e) {
  openModal(displayName(e), true);
  addModalBtn('닫기', true, closeModal);
  const body = $('modalBody');
  body.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'pv-modal';
  body.appendChild(box);
  const k = entryKind(e);
  const fileUrl = `/api/file?path=${encodeURIComponent(e.path)}`;
  if (k === 'img') box.innerHTML = `<img src="${fileUrl}" alt="">`;
  else if (k === 'vid') box.innerHTML = `<video src="${fileUrl}" controls autoplay></video>`;
  else if (k === 'aud') box.innerHTML = `<audio src="${fileUrl}" controls></audio>`;
  else if (k === 'pdf') box.innerHTML = `<iframe src="${fileUrl}"></iframe>`;
  else if (isTextKind(k)) {
    box.innerHTML = '<div class="pv-empty">불러오는 중…</div>';
    try {
      const t = await apiGet('text', { path: e.path });
      renderTextPreview(box, e, t);
      if (pvPendingBar) { box.prepend(pvPendingBar); pvPendingBar = null; }
    } catch (err) { box.innerHTML = `<div class="pv-empty">${esc(err.message)}</div>`; }
  } else {
    await loadRawPreview(box, e, box); // 텍스트/hex 자동 판별
  }
}

/* ══════════ preview pane ══════════ */
function togglePreview(on) {
  state.previewOn = on ?? !state.previewOn;
  localStorage.setItem('fx.preview', state.previewOn ? '1' : '0');
  $('preview').classList.toggle('hidden', !state.previewOn);
  $('previewResizer').classList.toggle('hidden', !state.previewOn);
  updatePreview();
}
let previewToken = 0;
// '별도 창으로 보기' 버튼 — 모든 미리보기 타입 공용
function popoutBtn(path) {
  const b = document.createElement('button');
  b.title = '별도 창으로 보기';
  b.innerHTML = svgIcon('i-popout', 'ic sm');
  b.addEventListener('click', () => openMediaViewer(path));
  return b;
}
async function updatePreview() {
  if (!state.previewOn) return;
  const token = ++previewToken;
  pvPendingBar = null;
  const content = $('previewContent'), info = $('previewInfo');
  const sel = selectedEntries();
  if (sel.length !== 1) {
    content.innerHTML = `<div class="pv-empty">${sel.length ? `${sel.length}개 항목 선택됨` : '파일을 선택하면 미리 보기가 표시됩니다.'}</div>`;
    info.innerHTML = '';
    return;
  }
  const e = sel[0];
  const k = entryKind(e);
  const fileUrl = `/api/file?path=${encodeURIComponent(e.path)}`;
  let html;
  if (k === 'img') html = `<img src="${fileUrl}" alt="" title="더블클릭: 크게 보기">`;
  else if (k === 'vid') html = `<video src="${fileUrl}" controls></video>`;
  else if (k === 'aud') html = `<audio src="${fileUrl}" controls></audio>`;
  else if (k === 'pdf') html = `<iframe src="${fileUrl}"></iframe>`;
  else if (isTextKind(k) && !e.isDir) html = null; // async text below
  else html =
    `<div class="pv-unknown">` +
    `<img class="pv-bigicon" src="/api/sysicon?path=${encodeURIComponent(e.path)}&size=256" alt="">` +
    (e.isDir ? '' : `<div class="pv-actions">` +
      `<button class="pv-open">${svgIcon('i-folder-open', 'ic sm')} <span>열기</span></button>` +
      `<button class="pv-peek">${svgIcon('i-eye', 'ic sm')} 내용 보기</button>` +
      `</div>`) +
    `</div>`;

  if (html !== null) {
    content.innerHTML = html;
    // 아이콘 로드 실패 시 내장 SVG로 대체 (속성 인라인 금지 — 따옴표 파싱 깨짐)
    const big = content.querySelector('img.pv-bigicon');
    if (big) big.addEventListener('error', () => {
      const sp = document.createElement('span');
      sp.innerHTML = svgIcon(entryIcon(e), 'ic pv-bigicon');
      big.replaceWith(sp.firstChild);
    });
    // 알 수 없는 형식: 내용 보기 → 텍스트면 텍스트, 아니면 hex 뷰
    content.querySelector('.pv-peek')?.addEventListener('click', async () => {
      await loadRawPreview(content, e, info);
    });
    // 이미지 더블클릭 → 뷰어 창으로 크게 보기
    if (k === 'img') content.querySelector('img')?.addEventListener('dblclick', () => openMediaViewer(e.path));
    // 모든 파일: 하단 정보 영역에 '별도 창으로 보기' 아이콘 (이미지는 줌·회전, 폴더 넘기기 지원)
    if (!e.isDir) {
      const bar = document.createElement('div');
      bar.className = 'pv-bar';
      bar.appendChild(popoutBtn(e.path));
      pvPendingBar = bar;
    }
    // 연결된 기본 앱으로 열기 (앱 이름·아이콘 표시)
    const openBtn = content.querySelector('.pv-open');
    if (openBtn) {
      openBtn.addEventListener('click', () =>
        apiOp({ op: 'open', path: e.path }).catch((err) => toast(err.message, true)));
      apiGet('opener', { path: e.path }).then((o) => {
        if (token !== previewToken || !o.app) return;
        openBtn.innerHTML =
          `<img class="ic sm" src="/api/sysicon?path=${encodeURIComponent(o.app)}&size=32" alt="">` +
          ` <span>${esc(o.name)}(으)로 열기</span>`;
      }).catch(() => {});
    }
    // 폴더: 저장소(.git/.svn) 요약 + 프로젝트 IDE 열기
    if (e.isDir) {
      apiGet('dirinfo', { path: e.path }).then((d) => {
        if (token !== previewToken) return;
        if (!d.git && !d.svn && !(d.openers || []).length) return;
        const box = document.createElement('div');
        box.className = 'pv-dirinfo';
        let h = '';
        if (d.git) h += `<div class="pv-vcs"><b>Git</b> ${esc(d.git.branch || '')}${d.git.last ? ` <span class="dim">· ${esc(d.git.last)}</span>` : ''}${vcsUrlHtml(d.git.remote)}</div>`;
        if (d.svn) h += `<div class="pv-vcs"><b>SVN</b> ${d.svn.rev ? `r${esc(d.svn.rev)}` : ''}${vcsUrlHtml(d.svn.url)}</div>`;
        box.innerHTML = h;
        for (const o of d.openers || []) {
          const b = document.createElement('button');
          b.innerHTML = `<img class="ic sm" src="/api/sysicon?path=${encodeURIComponent(o.app)}&size=32" alt=""> <span>${esc(o.label)}</span>`;
          b.addEventListener('click', () => apiOp({ op: 'openApp', app: o.app, target: o.target }).catch((err) => toast(err.message, true)));
          box.appendChild(b);
        }
        bindVcsUrl(box);
        content.querySelector('.pv-unknown')?.appendChild(box);
      }).catch(() => {});
    }
  } else {
    content.innerHTML = '<div class="pv-empty">불러오는 중…</div>';
    try {
      const t = await apiGet('text', { path: e.path });
      if (token !== previewToken) return;
      renderTextPreview(content, e, t);
      if (pvPendingBar) pvPendingBar.prepend(popoutBtn(e.path)); // 검색 바 앞에 '별도 창' 버튼
    } catch { if (token === previewToken) content.innerHTML = '<div class="pv-empty">미리 볼 수 없습니다</div>'; }
  }
  info.innerHTML =
    `<div class="pv-name">${esc(displayName(e))}</div>` +
    `<div>${entryTypeName(e)}</div>` +
    (e.isDir ? '' : `<div>크기: ${fmtSize(e.size)}</div>`) +
    `<div>수정: ${fmtDate(e.mtime)}</div>` +
    `<div>${esc(shortenHome(e.path))}</div>`;
  if (pvPendingBar) { // 텍스트 미리보기 도구(아이콘)를 정보 영역 상단에
    info.prepend(pvPendingBar);
    pvPendingBar = null;
  }
}

/* ══════════ menus ══════════ */
let subMenuEl = null;
let subMenuAnchor = null;
let subCloseTimer = null;
function closeSubMenu() {
  clearTimeout(subCloseTimer);
  subCloseTimer = null;
  subMenuAnchor?.classList.remove('sub-open');
  subMenuAnchor = null;
  subMenuEl?.remove();
  subMenuEl = null;
}
// 형제 항목을 스치는 순간 닫히지 않도록 유예를 두고 닫기
function scheduleCloseSub() {
  clearTimeout(subCloseTimer);
  subCloseTimer = setTimeout(closeSubMenu, 320);
}
function renderMenuItems(menu, items, isSub = false) {
  for (const it of items) {
    if (it === '-') {
      const s = document.createElement('div'); s.className = 'menu-sep'; menu.appendChild(s);
      continue;
    }
    const mi = document.createElement('div');
    mi.className = 'menu-item' + (it.disabled ? ' disabled' : '') + (it.checked ? ' checked' : '');
    mi.innerHTML =
      (it.checkable ? `<svg class="checkmark"><use href="#i-check"/></svg>` : '') +
      (it.iconUrl ? `<img class="ic" src="${it.iconUrl}" alt="">`
        : it.icon ? svgIcon(it.icon)
        : (it.checkable ? '' : '<span style="width:16px"></span>')) +
      `<span>${esc(it.label)}</span>` +
      (it.children ? '<span class="key">▸</span>' : it.key ? `<span class="key">${it.key}</span>` : '');
    if (it.children && !it.disabled) {
      // 서브메뉴: 항목에 올리면 오른쪽에 펼침 (살짝 겹쳐서 이동 중 이탈 방지)
      mi.addEventListener('mouseenter', () => {
        clearTimeout(subCloseTimer);
        if (subMenuAnchor === mi) return; // 이미 이 항목의 서브가 열림
        closeSubMenu();
        subMenuAnchor = mi;
        mi.classList.add('sub-open');
        subMenuEl = document.createElement('div');
        subMenuEl.className = 'menu';
        renderMenuItems(subMenuEl, it.children, true);
        // 서브메뉴 위에 있는 동안(구분선·여백 포함) 닫기 예약을 계속 취소
        subMenuEl.addEventListener('mouseover', () => clearTimeout(subCloseTimer));
        document.body.appendChild(subMenuEl);
        const a = mi.getBoundingClientRect();
        const r = subMenuEl.getBoundingClientRect();
        let left = a.right - 4;
        if (left + r.width > window.innerWidth - 8) left = a.left - r.width + 4;
        let top = a.top - 5;
        if (top + r.height > window.innerHeight - 8) top = window.innerHeight - r.height - 8;
        subMenuEl.style.left = `${left}px`;
        subMenuEl.style.top = `${top}px`;
      });
    } else {
      // 최상위 메뉴의 다른 항목: 서브 닫기 예약 / 서브메뉴 내부 항목: 닫기 취소
      mi.addEventListener('mouseenter',
        isSub ? () => clearTimeout(subCloseTimer) : scheduleCloseSub);
      if (!it.disabled) mi.addEventListener('click', () => { hideMenus(); it.action?.(); });
    }
    menu.appendChild(mi);
  }
}
function showMenu(items, x, y, elId = 'ctxmenu') {
  closeSubMenu();
  const menu = $(elId);
  menu.innerHTML = '';
  renderMenuItems(menu, items);
  menu.classList.remove('hidden');
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
}
function hideMenus() {
  closeSubMenu();
  $('ctxmenu').classList.add('hidden');
  $('dropdown').classList.add('hidden');
}
window.addEventListener('mousedown', (e) => { if (!e.target.closest('.menu')) hideMenus(); });
window.addEventListener('blur', hideMenus);

fileArea.addEventListener('contextmenu', (ev) => {
  ev.preventDefault();
  const item = itemFromEvent(ev);
  const git = state.vcs?.git, svn = state.vcs?.svn;
  if (item) {
    const sel = selectedEntries();
    const single = sel.length === 1 ? sel[0] : null;
    const selPaths = sel.map((e) => e.path);
    const anyStatus = sel.some((e) => vcsStatusFor(e));
    // SVN: 선택 항목을 상태별로 분류 — 미추적은 추가(+) 대상, 추적 변경(하위 변경 폴더 포함)은 되돌리기 대상
    const svnUntracked = svn ? sel.filter((x) => svn.statuses[x.path]?.[0] === '?') : [];
    const svnChanged = svn ? sel.filter((x) => {
      const c = svn.statuses[x.path];
      if (c && c[0] !== '?') return true;
      return x.isDir && svn.dirSet?.has(x.path); // 폴더: 하위에 변경 있음 (revert -R)
    }) : [];
    const nameOf = (arr) => (arr.length === 1 ? `'${displayName(arr[0])}'` : `${arr.length}개 항목`);
    const svnFiles = svn ? sel.filter((x) => !x.isDir) : []; // 잠금/해제 대상(파일만)
    const svnLocked = svnFiles.filter((x) => svn?.locks?.[x.path]);
    const svnUnlocked = svnFiles.filter((x) => !svn?.locks?.[x.path]);
    // Git: 상태 기반 대상 (스테이지 = 변경+미추적, 변경 취소 = 추적된 변경만)
    const gitStageable = git ? sel.filter((x) =>
      git.statuses[x.path] || (x.isDir && git.dirSet?.has(x.path))) : [];
    const gitDiscardable = git ? sel.filter((x) => {
      const c = git.statuses[x.path];
      return (c && c[0] !== '?') || (x.isDir && git.dirSet?.has(x.path));
    }) : [];
    showMenu([
      { label: '열기', icon: 'i-folder-open', key: '↵', action: () => sel.forEach(openEntry) },
      (state.searchMode && single?.parent)
        ? { label: '상위 폴더 열기', icon: 'i-folder', action: () => navigate(single.parent) }
        : null,
      (single?.isDir && !single.name.endsWith('.app'))
        ? { label: '새 창에서 열기', icon: 'i-view', key: '⌘N', action: () => openNewWindow(single.path) }
        : null,
      single?.isDir && single.name.endsWith('.app')
        ? { label: '패키지 내용 보기', icon: 'i-folder', action: () => navigate(single.path) }
        : null,
      (single && !single.isDir)
        ? { label: '미리보기', icon: 'i-eye', action: () => previewFileModal(single) }
        : null,
      single ? { label: 'Finder에서 보기', icon: 'i-finder', action: () => apiOp({ op: 'reveal', path: single.path }).catch((e) => toast(e.message, true)) } : null,
      { label: 'VS Code로 열기', icon: 'i-vscode', action: () => selPaths.forEach((p) => apiOp({ op: 'vscode', path: p }).catch((e) => toast(e.message, true))) },
      single?.isDir ? { label: '터미널에서 열기', icon: 'i-term', action: () => apiOp({ op: 'terminal', path: single.path }).catch((e) => toast(e.message, true)) } : null,
      '-',
      { label: '잘라내기', icon: 'i-cut', key: '⌘X', action: () => doCopy(true) },
      { label: '복사', icon: 'i-copy', key: '⌘C', action: () => doCopy(false) },
      '-',
      { label: '이름 바꾸기', icon: 'i-rename', key: 'F2', disabled: !single, action: () => startRename(single.path) },
      { label: '휴지통으로 이동', icon: 'i-trash', key: '⌘⌫', action: doTrash },
      single?.isDir ? '-' : null,
      single?.isDir
        ? (isFav(single.path)
          ? { label: '즐겨찾기에서 제거', icon: 'i-star-off', action: () => removeFav(single.path) }
          : { label: '즐겨찾기에 추가', icon: 'i-star', action: () => addFav(single.path) })
        : null,
      state.searchMode ? null : '-',
      state.searchMode ? null : { label: '새 폴더', icon: 'i-folder', key: '⇧⌘N', action: () => createNew('folder') },
      state.searchMode ? null : { label: '붙여넣기', icon: 'i-paste', key: '⌘V', action: doPaste },
      git ? '-' : null,
      git ? { label: 'Git: 커밋…', icon: 'i-check', action: () => commitModal('git') } : null,
      git ? { label: 'Git: 풀 (pull)', icon: 'i-downloads', action: gitStream('pull', '풀') } : null,
      (git && state.forkInstalled)
        ? { label: 'Fork로 열기', iconUrl: FORK_ICON_URL, action: () => apiOp({ op: 'fork', path: git.root }).catch((e) => toast(e.message, true)) }
        : null,
      git ? {
        label: 'Git 기타', icon: 'i-branch',
        children: [
          gitStageable.length ? {
            label: `${nameOf(gitStageable)} 스테이지 (add)`, icon: 'i-branch',
            action: () => vcsRun('git', 'add', { paths: gitStageable.map((x) => x.path), showOutput: false }),
          } : null,
          gitDiscardable.length ? {
            label: `${nameOf(gitDiscardable)} 변경 취소 (discard)`, icon: 'i-refresh',
            action: async () => {
              const names = gitDiscardable.slice(0, 5).map((x) => displayName(x)).join(', ') +
                (gitDiscardable.length > 5 ? ` 외 ${gitDiscardable.length - 5}개` : '');
              if (await confirmModal('변경 취소', `${names}의 로컬 변경 사항을 버립니다. 되돌릴 수 없습니다.`))
                vcsRun('git', 'discard', { paths: gitDiscardable.map((x) => x.path), showOutput: false });
            },
          } : null,
          (gitStageable.length || gitDiscardable.length) ? '-' : null,
          { label: '그래프 / 브랜치…', icon: 'i-branch', action: openGitGraph },
          { label: '푸시 (push)', icon: 'i-up', action: gitStream('push', '푸시') },
          { label: '페치 (fetch)', icon: 'i-refresh', action: gitStream('fetch', '페치') },
        ].filter(Boolean),
      } : null,
      svn ? '-' : null,
      svn ? { label: 'SVN: 커밋…', icon: 'i-check', action: () => commitModal('svn') } : null,
      svn ? { label: 'SVN: 업데이트', icon: 'i-downloads', action: svnStream('update', '업데이트') } : null,
      svn ? {
        label: 'SVN 기타', icon: 'i-branch',
        children: [
          svnUntracked.length ? {
            label: `${nameOf(svnUntracked)} 추가 (+)`, icon: 'i-branch',
            action: () => vcsRun('svn', 'add', { paths: svnUntracked.map((x) => x.path), showOutput: false }),
          } : null,
          svnChanged.length ? {
            label: `${nameOf(svnChanged)} 되돌리기`, icon: 'i-refresh',
            action: async () => {
              const names = svnChanged.slice(0, 5).map((x) => displayName(x)).join(', ') +
                (svnChanged.length > 5 ? ` 외 ${svnChanged.length - 5}개` : '');
              if (await confirmModal('되돌리기', `${names}의 로컬 변경 사항을 버립니다. 되돌릴 수 없습니다.`))
                vcsRun('svn', 'revert', { paths: svnChanged.map((x) => x.path), showOutput: false });
            },
          } : null,
          svnUnlocked.length ? {
            label: `${nameOf(svnUnlocked)} 잠금 (lock)`, icon: 'i-lock',
            action: () => vcsRun('svn', 'lock', { paths: svnUnlocked.map((x) => x.path), showOutput: false }),
          } : null,
          svnLocked.length ? {
            label: `${nameOf(svnLocked)} 잠금 해제 (unlock)`, icon: 'i-unlock',
            action: () => vcsRun('svn', 'unlock', { paths: svnLocked.map((x) => x.path), showOutput: false }),
          } : null,
          (svnUntracked.length || svnChanged.length || svnUnlocked.length || svnLocked.length) ? '-' : null,
          { label: '스위치 (브랜치 전환)…', icon: 'i-branch', action: svnSwitchModal },
          { label: '로그 / 리비전 이동…', icon: 'i-file-txt', action: openSvnLog },
          { label: '정리 (cleanup)…', icon: 'i-trash', action: svnCleanupModal },
          { label: '전체 되돌리기…', icon: 'i-refresh', action: revertAllModal },
        ].filter(Boolean),
      } : null,
      '-',
      { label: '경로 복사', icon: 'i-copy', action: () => { navigator.clipboard.writeText(selPaths.join('\n')); toast('경로를 복사했습니다'); } },
      { label: '속성', icon: 'i-info', disabled: !single, action: () => showProps(single.path) },
    ].filter(Boolean), ev.clientX, ev.clientY);
  } else {
    showMenu([
      { label: '새 폴더', icon: 'i-folder', key: '⇧⌘N', disabled: state.searchMode, action: () => createNew('folder') },
      { label: '새 텍스트 문서', icon: 'i-file-txt', disabled: state.searchMode, action: () => createNew('file') },
      '-',
      { label: '붙여넣기', icon: 'i-paste', key: '⌘V', disabled: state.searchMode, action: doPaste },
      '-',
      { label: '새로 고침', icon: 'i-refresh', key: 'F5', action: refresh },
      { label: '새 창에서 열기', icon: 'i-view', key: '⌘N', action: () => openNewWindow(state.cwd) },
      { label: 'Finder에서 열기', icon: 'i-finder', action: () => apiOp({ op: 'open', path: state.cwd }).catch((e) => toast(e.message, true)) },
      { label: 'VS Code로 열기', icon: 'i-vscode', action: () => apiOp({ op: 'vscode', path: state.cwd }).catch((e) => toast(e.message, true)) },
      { label: '터미널에서 열기', icon: 'i-term', action: () => apiOp({ op: 'terminal', path: state.cwd }).catch((e) => toast(e.message, true)) },
      git ? '-' : null,
      git ? { label: 'Git: 커밋…', icon: 'i-check', action: () => commitModal('git') } : null,
      git ? { label: 'Git: 풀 (pull)', icon: 'i-downloads', action: gitStream('pull', '풀') } : null,
      (git && state.forkInstalled)
        ? { label: 'Fork로 열기', iconUrl: FORK_ICON_URL, action: () => apiOp({ op: 'fork', path: git.root }).catch((e) => toast(e.message, true)) }
        : null,
      git ? {
        label: 'Git 기타', icon: 'i-branch',
        children: [
          { label: '그래프 / 브랜치…', icon: 'i-branch', action: openGitGraph },
          { label: '푸시 (push)', icon: 'i-up', action: gitStream('push', '푸시') },
          { label: '페치 (fetch)', icon: 'i-refresh', action: gitStream('fetch', '페치') },
        ].filter(Boolean),
      } : null,
      svn ? '-' : null,
      svn ? { label: 'SVN: 커밋…', icon: 'i-check', action: () => commitModal('svn') } : null,
      svn ? { label: 'SVN: 업데이트', icon: 'i-downloads', action: svnStream('update', '업데이트') } : null,
      svn ? {
        label: 'SVN 기타', icon: 'i-branch',
        children: [
          { label: '스위치 (브랜치 전환)…', icon: 'i-branch', action: svnSwitchModal },
          { label: '로그 / 리비전 이동…', icon: 'i-file-txt', action: openSvnLog },
          { label: '정리 (cleanup)…', icon: 'i-trash', action: svnCleanupModal },
          { label: '전체 되돌리기…', icon: 'i-refresh', action: revertAllModal },
        ],
      } : null,
      (!git && !svn) ? '-' : null,
      (!git && !svn) ? { label: 'Git 저장소 클론…', icon: 'i-branch', action: cloneGitModal } : null,
      (!git && !svn) ? { label: 'SVN 체크아웃…', icon: 'i-branch', action: svnCheckoutModal } : null,
      '-',
      isFav(state.cwd)
        ? { label: '즐겨찾기에서 제거', icon: 'i-star-off', action: () => removeFav(state.cwd) }
        : { label: '즐겨찾기에 추가', icon: 'i-star', action: () => addFav(state.cwd) },
      '-',
      { label: '속성', icon: 'i-info', action: () => showProps(state.cwd) },
    ].filter(Boolean), ev.clientX, ev.clientY);
  }
});

/* toolbar dropdowns */
function dropdownFor(btn, items) {
  btn.addEventListener('click', () => {
    const r = btn.getBoundingClientRect();
    showMenu(typeof items === 'function' ? items() : items, r.left, r.bottom + 4, 'dropdown');
  });
}
dropdownFor($('btnNew'), () => [
  { label: '새 폴더', icon: 'i-folder', key: '⇧⌘N', disabled: state.searchMode, action: () => createNew('folder') },
  { label: '새 텍스트 문서', icon: 'i-file-txt', disabled: state.searchMode, action: () => createNew('file') },
  '-',
  { label: 'Git 저장소 클론…', icon: 'i-branch', disabled: state.searchMode, action: cloneGitModal },
  { label: 'SVN 체크아웃…', icon: 'i-branch', disabled: state.searchMode, action: svnCheckoutModal },
  '-',
  { label: '네트워크 드라이브 연결… (smb://)', icon: 'i-drive', action: mountNetworkDrive },
  { label: '웹 링크 바로가기 추가…', icon: 'i-cloud', action: () => webLinkModal() },
]);
dropdownFor($('btnSort'), () => {
  const sortItem = (label, key) => ({
    label, checkable: true, checked: state.sortKey === key,
    action: () => { state.sortKey = key; localStorage.setItem('fx.sortKey', key); render(); },
  });
  const dirItem = (label, dir) => ({
    label, checkable: true, checked: state.sortDir === dir,
    action: () => { state.sortDir = dir; localStorage.setItem('fx.sortDir', dir); render(); },
  });
  return [
    sortItem('이름', 'name'), sortItem('수정한 날짜', 'mtime'),
    sortItem('유형', 'type'), sortItem('크기', 'size'),
    '-', dirItem('오름차순', 'asc'), dirItem('내림차순', 'desc'),
  ];
});
dropdownFor($('btnView'), () => {
  const vItem = (label, mode) => ({
    label, checkable: true, checked: state.viewMode === mode,
    action: () => { state.viewMode = mode; localStorage.setItem('fx.view', mode); render(); },
  });
  return [
    vItem('큰 아이콘', 'lg'), vItem('보통 아이콘', 'md'),
    vItem('목록', 'list'), vItem('자세히', 'details'),
    '-',
    {
      label: '숨긴 항목 표시', checkable: true, checked: state.showHidden,
      action: () => {
        state.showHidden = !state.showHidden;
        localStorage.setItem('fx.hidden', state.showHidden ? '1' : '0');
        navigate(state.cwd, { push: false });
      },
    },
    {
      label: '시스템 파일 표시 (.DS_Store 등)', checkable: true, checked: state.showSystem,
      action: () => {
        state.showSystem = !state.showSystem;
        localStorage.setItem('fx.system', state.showSystem ? '1' : '0');
        navigate(state.cwd, { push: false });
      },
    },
    '-',
    ...THEMES.map(([id, label]) => ({
      label: `테마: ${label}`, checkable: true, checked: state.theme === id,
      action: () => {
        state.theme = id;
        localStorage.setItem('fx.theme', id);
        applyTheme();
      },
    })),
  ];
});

const gitStream = (action, label) => () =>
  vcsStreamModal(`Git ${label}`, { tool: 'git', action, root: state.vcs?.git?.root });
const svnStream = (action, label) => () =>
  vcsStreamModal(`SVN ${label}`, { tool: 'svn', action, root: state.vcs?.svn?.root });
dropdownFor($('btnGit'), () => [
  { label: '그래프 / 브랜치…', icon: 'i-branch', action: openGitGraph },
  '-',
  { label: '풀 (pull)', icon: 'i-downloads', action: gitStream('pull', '풀') },
  { label: '푸시 (push)', icon: 'i-up', action: gitStream('push', '푸시') },
  { label: '페치 (fetch)', icon: 'i-refresh', action: gitStream('fetch', '페치') },
  '-',
  { label: '커밋… (모든 변경 사항)', icon: 'i-check', action: () => commitModal('git') },
  '-',
  { label: '상태 보기 (status)', icon: 'i-info', action: () => statusModal('git') },
  { label: '변경 요약 (diff --stat)', icon: 'i-file-txt', action: () => vcsRun('git', 'diff') },
]);
dropdownFor($('btnSvn'), () => [
  { label: '업데이트 (update)', icon: 'i-downloads', action: svnStream('update', '업데이트') },
  { label: '커밋…', icon: 'i-check', action: () => commitModal('svn') },
  { label: '전체 되돌리기…', icon: 'i-refresh', action: revertAllModal },
  { label: '정리 (cleanup)…', icon: 'i-trash', action: svnCleanupModal },
  '-',
  { label: '상태 보기 (status)', icon: 'i-info', action: () => statusModal('svn') },
  { label: '로그 / 리비전 이동…', icon: 'i-file-txt', action: openSvnLog },
]);

/* toolbar buttons */
$('btnCut').addEventListener('click', () => doCopy(true));
$('btnCopy').addEventListener('click', () => doCopy(false));
$('btnPaste').addEventListener('click', doPaste);
$('btnTrash').addEventListener('click', doTrash);
$('btnRename').addEventListener('click', () => { const s = selectedEntries(); if (s.length === 1) startRename(s[0].path); });
$('btnPreview').addEventListener('click', () => togglePreview());
$('btnBack').addEventListener('click', goBack);
$('btnFwd').addEventListener('click', goFwd);
$('btnUp').addEventListener('click', goUp);
$('btnRefresh').addEventListener('click', refresh);

/* column header sorting */
document.querySelectorAll('#colHeader .col').forEach((c) => {
  c.addEventListener('click', () => {
    const key = c.dataset.key;
    if (state.sortKey === key) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    else { state.sortKey = key; state.sortDir = 'asc'; }
    localStorage.setItem('fx.sortKey', state.sortKey);
    localStorage.setItem('fx.sortDir', state.sortDir);
    render();
  });
});

/* ══════════ properties modal ══════════ */
let propsAbort = null; // 진행 중인 폴더 크기 스트림 (모달 닫으면 중단)
async function showProps(path) {
  const wrap = $('modalWrap');
  propsAbort?.abort(); propsAbort = null;
  $('modalTitle').textContent = '속성';
  $('modalBody').innerHTML = '<div>불러오는 중…</div>';
  $('modalBtns').innerHTML = '';
  wrap.classList.remove('hidden');
  const ok = document.createElement('button');
  ok.className = 'primary'; ok.textContent = '확인';
  ok.addEventListener('click', () => { propsAbort?.abort(); propsAbort = null; wrap.classList.add('hidden'); });
  $('modalBtns').appendChild(ok);
  ok.focus();
  let p;
  try {
    p = await apiGet('props', { path });
  } catch (e) {
    $('modalBody').innerHTML = `<div>${esc(e.message)}</div>`;
    return;
  }
  const sizeCell = p.sizePending
    ? '<span class="dim">계산 중…</span>'
    : esc(`${fmtSize(p.size)} (${p.size.toLocaleString()} 바이트)`);
  const rows = [
    ['이름', esc(p.name)],
    ['유형', esc(p.isDir ? '파일 폴더' : entryTypeName({ isDir: false, name: p.name, ext: p.name.split('.').pop()?.toLowerCase() || '' }))],
    ['위치', esc(shortenHome(path.replace(/\/[^/]*$/, '') || '/'))],
    ['크기', sizeCell, 'propSize'],
    p.isDir ? ['내용', '<span class="dim">계산 중…</span>', 'propContains'] : null,
    p.git ? ['Git', esc([p.git.branch && `브랜치 ${p.git.branch}`, p.git.last].filter(Boolean).join(' · ')) + vcsUrlHtml(p.git.remote)] : null,
    p.svn ? ['SVN', esc(p.svn.rev ? `리비전 ${p.svn.rev}` : '') + vcsUrlHtml(p.svn.url)] : null,
    ['만든 날짜', esc(fmtDate(p.ctime))],
    ['수정한 날짜', esc(fmtDate(p.mtime))],
    ['액세스한 날짜', esc(fmtDate(p.atime))],
    ['사용 권한', esc(p.mode)],
    p.symlink ? ['심볼릭 링크', esc(p.target)] : null,
  ].filter(Boolean);
  $('modalBody').innerHTML = rows
    .map(([k, v, id]) => `<div class="prop-row"><span class="k">${k}</span><span class="v"${id ? ` id="${id}"` : ''}>${v}</span></div>`)
    .join('');
  bindVcsUrl($('modalBody'));
  // 프로젝트 폴더면 IDE 열기 버튼
  for (const o of p.openers || []) {
    const btn = document.createElement('button');
    btn.textContent = o.label;
    btn.addEventListener('click', () => apiOp({ op: 'openApp', app: o.app, target: o.target }).catch((e) => toast(e.message, true)));
    $('modalBtns').insertBefore(btn, ok);
  }
  // 폴더 크기는 백그라운드 스트림으로 갱신 (윈도우 방식)
  if (p.isDir && p.sizePending) {
    const ctrl = new AbortController();
    propsAbort = ctrl;
    try {
      const res = await fetch(`/api/dirsize?path=${encodeURIComponent(path)}`, { signal: ctrl.signal });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (wrap.classList.contains('hidden')) { ctrl.abort(); break; }
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop();
        const last = lines.filter(Boolean).pop();
        if (!last) continue;
        const s = JSON.parse(last);
        const el = $('propSize'), el2 = $('propContains');
        if (el) el.innerHTML = `${esc(fmtSize(s.bytes))} (${s.bytes.toLocaleString()} 바이트)${s.done ? '' : ' <span class="dim">계산 중…</span>'}`;
        if (el2) el2.textContent = `파일 ${s.files.toLocaleString()}개, 폴더 ${s.dirs.toLocaleString()}개`;
      }
    } catch { /* 중단/네트워크 오류 무시 */ }
    if (propsAbort === ctrl) propsAbort = null;
  }
}
$('modalWrap').addEventListener('mousedown', (e) => {
  if (e.target === $('modalWrap') && !IN_TOOL) {
    propsAbort?.abort(); propsAbort = null;
    $('modalWrap').classList.add('hidden');
  }
});

/* ══════════ keyboard ══════════ */
let typeahead = '', typeaheadTimer = null;
window.addEventListener('keydown', (ev) => {
  const inInput = ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA';
  const cmd = ev.metaKey || ev.ctrlKey;

  if (ev.key === 'Escape') { hideMenus(); if (!IN_TOOL && !$('modalWrap').classList.contains('hidden')) $('modalWrap').classList.add('hidden'); }
  if (inInput) return;

  if (cmd && ev.key === 'a') { ev.preventDefault(); setSelection(state.sorted.map((e) => e.path)); return; }
  if (cmd && ev.key === 'c') { ev.preventDefault(); doCopy(false); return; }
  if (cmd && ev.key === 'x') { ev.preventDefault(); doCopy(true); return; }
  if (cmd && ev.key === 'v') { ev.preventDefault(); doPaste(); return; }
  if (cmd && ev.key === 'f') { ev.preventDefault(); $('searchInput').focus(); return; }
  if (cmd && ev.shiftKey && (ev.key === 'n' || ev.key === 'N')) { ev.preventDefault(); createNew('folder'); return; }
  if (cmd && !ev.shiftKey && ev.key === 'n') { ev.preventDefault(); openNewWindow(state.cwd); return; }
  if (cmd && ev.shiftKey && ev.code === 'Period') { // Finder와 동일: 숨김 파일 토글
    ev.preventDefault();
    state.showHidden = !state.showHidden;
    localStorage.setItem('fx.hidden', state.showHidden ? '1' : '0');
    navigate(state.cwd, { push: false });
    return;
  }
  if (cmd && ev.key === '[') { ev.preventDefault(); goBack(); return; }
  if (cmd && ev.key === ']') { ev.preventDefault(); goFwd(); return; }
  if (cmd && ev.key === 'ArrowUp') { ev.preventDefault(); goUp(); return; }
  if (cmd && ev.key === 'Backspace') { ev.preventDefault(); doTrash(); return; }
  if (cmd && ev.key === 'r') { ev.preventDefault(); refresh(); return; }
  if (ev.key === 'F5') { ev.preventDefault(); refresh(); return; }
  if (ev.key === 'F2') { ev.preventDefault(); const s = selectedEntries(); if (s.length === 1) startRename(s[0].path); return; }
  if (ev.key === 'Delete') { ev.preventDefault(); doTrash(); return; }
  if (ev.key === 'Backspace') { ev.preventDefault(); goUp(); return; }
  if (ev.key === 'Enter') {
    ev.preventDefault();
    const s = selectedEntries();
    if (s.length === 1) openEntry(s[0]);
    else s.forEach(openEntry);
    return;
  }
  if (ev.key === ' ') { ev.preventDefault(); togglePreview(); return; }

  // arrow navigation
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) {
    ev.preventDefault();
    if (!state.sorted.length) return;
    let cols = 1;
    if (state.viewMode === 'lg' || state.viewMode === 'md') {
      const first = fileList.querySelector('.tile');
      if (first) {
        const w = first.getBoundingClientRect().width + 2;
        cols = Math.max(1, Math.floor((fileList.clientWidth - 20) / w));
      }
    }
    let i = state.focusIdx;
    if (i < 0) i = 0;
    else if (ev.key === 'ArrowUp') i -= cols;
    else if (ev.key === 'ArrowDown') i += cols;
    else if (ev.key === 'ArrowLeft') i -= 1;
    else if (ev.key === 'ArrowRight') i += 1;
    else if (ev.key === 'Home') i = 0;
    else if (ev.key === 'End') i = state.sorted.length - 1;
    i = Math.max(0, Math.min(state.sorted.length - 1, i));
    state.focusIdx = i;
    if (ev.shiftKey && state.anchor >= 0) {
      const [a, b] = [Math.min(state.anchor, i), Math.max(state.anchor, i)];
      state.selection = new Set(state.sorted.slice(a, b + 1).map((e) => e.path));
    } else {
      state.anchor = i;
      state.selection = new Set([state.sorted[i].path]);
    }
    paintSelection();
    fileList.querySelector(`[data-idx="${i}"]`)?.scrollIntoView({ block: 'nearest' });
    return;
  }

  // type-ahead (Windows 탐색기 방식): 글자를 누르면 그 글자로 시작하는 항목으로,
  // 같은 글자를 반복해 누르면 해당 항목들을 순환, 이어 치면 접두사 검색
  if (ev.key.length === 1 && !cmd && !ev.altKey) {
    const ch = ev.key.toLowerCase();
    const n = state.sorted.length;
    if (!n) return;
    const cycling = typeahead.length > 0 && [...typeahead].every((c) => c === ch);
    clearTimeout(typeaheadTimer);
    typeaheadTimer = setTimeout(() => { typeahead = ''; }, 900);
    const match = (j, prefix) => {
      const e = state.sorted[j];
      return displayName(e).toLowerCase().startsWith(prefix) || e.name.toLowerCase().startsWith(prefix);
    };
    typeahead += ch;
    let idx = -1;
    if (cycling || typeahead.length === 1) {
      // 현재 위치 다음부터 순환하며 그 글자로 시작하는 항목 탐색
      const from = Math.max(state.focusIdx, -1);
      for (let i = 1; i <= n; i++) { const j = (from + i + n) % n; if (match(j, ch)) { idx = j; break; } }
    } else {
      // 여러 글자 접두사: 현재 위치부터(포함) 순환 검색
      const from = Math.max(state.focusIdx, 0);
      for (let i = 0; i < n; i++) { const j = (from + i) % n; if (match(j, typeahead)) { idx = j; break; } }
    }
    if (idx >= 0) {
      state.focusIdx = idx; state.anchor = idx;
      state.selection = new Set([state.sorted[idx].path]);
      paintSelection();
      fileList.querySelector(`[data-idx="${idx}"]`)?.scrollIntoView({ block: 'nearest' });
    }
  }
});

/* native shell hook: refresh after a native file drop copied items in */
window.addEventListener('fx-refresh', () => refresh());

/* new window: native shell opens a real window, browsers open a tab/popup */
function openNewWindow(path) {
  const url = `${location.origin}/#${encodeURI(path || state.cwd || '')}`;
  if (window.webkit?.messageHandlers?.fxNewWindow) {
    window.webkit.messageHandlers.fxNewWindow.postMessage(url);
  } else {
    window.open(url, '_blank');
  }
}

/* VCS tool views (git graph / svn log) run in their own window, VS Code-style */
const IN_TOOL = ['git'].includes(new URLSearchParams(location.search).get('graph')) ||
  new URLSearchParams(location.search).get('svnlog') === '1' ||
  new URLSearchParams(location.search).get('viewer') === '1';
function openViewWindow(query, path) {
  const url = `${location.origin}/?${query}#${encodeURI(path)}`;
  if (window.webkit?.messageHandlers?.fxNewWindow) {
    window.webkit.messageHandlers.fxNewWindow.postMessage(url);
  } else {
    window.open(url, '_blank', 'width=1120,height=820');
  }
}
function closeToolWindow() {
  if (window.webkit?.messageHandlers?.fxCloseWindow) {
    window.webkit.messageHandlers.fxCloseWindow.postMessage(0);
  } else {
    window.close();
    closeModal(); // window.close()가 막힌 일반 탭이면 모달만 닫음
  }
}
const closeViewFn = () => (IN_TOOL ? closeToolWindow() : closeModal());
function openGitGraph() {
  const root = state.vcs?.git?.root;
  if (!root) return;
  if (IN_TOOL) gitGraphModal();
  else openViewWindow('graph=git', root);
}
function openSvnLog() {
  const root = state.vcs?.svn?.root;
  if (!root) return;
  if (IN_TOOL) svnLogModal();
  else openViewWindow('svnlog=1', root);
}

/* mouse back/forward buttons */
window.addEventListener('mouseup', (e) => {
  if (e.button === 3) { e.preventDefault(); goBack(); }
  if (e.button === 4) { e.preventDefault(); goFwd(); }
});

/* ══════════ resizers ══════════ */
function makeResizer(handle, target, { invert = false, storeKey = null } = {}) {
  handle.addEventListener('mousedown', (ev) => {
    ev.preventDefault();
    const startX = ev.clientX, startW = target.getBoundingClientRect().width;
    const move = (e) => {
      const d = (e.clientX - startX) * (invert ? -1 : 1);
      target.style.width = Math.max(140, startW + d) + 'px';
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (storeKey) localStorage.setItem(storeKey, String(Math.round(target.getBoundingClientRect().width)));
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  const saved = storeKey && parseInt(localStorage.getItem(storeKey), 10);
  if (saved) target.style.width = `${saved}px`;
}
makeResizer($('sidebarResizer'), $('sidebar'), { storeKey: 'fx.sidebarW' });
makeResizer($('previewResizer'), $('preview'), { invert: true, storeKey: 'fx.previewW' });

/* ══════════ toast ══════════ */
let toastTimer = null;
function toast(msg, isError = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = isError ? 'error' : '';
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, isError ? 4500 : 2200);
}
function hideToast() { $('toast').classList.add('hidden'); }

/* ══════════ init ══════════ */
(async function init() {
  try {
    const home = await initSidebar();
    renderFavs();
    if (state.previewOn) { $('preview').classList.remove('hidden'); $('previewResizer').classList.remove('hidden'); }
    const hashPath = decodeURI(location.hash.slice(1) || '');
    const params0 = new URLSearchParams(location.search);
    if (params0.get('viewer') === '1' && hashPath.startsWith('/')) {
      initViewer(hashPath); // 미디어 뷰어 전용 창 — 탐색기 탐색 생략
      return;
    }
    await navigate(hashPath.startsWith('/') ? hashPath : home);
    const params = new URLSearchParams(location.search);
    const wantCommit = params.get('commit');
    if (wantCommit === 'git' || wantCommit === 'svn') commitModal(wantCommit);
    if (IN_TOOL) document.body.classList.add('tool-mode'); // 전용 도구 창: 탐색기 UI 숨김
    if (params.get('graph') === 'git') { await fetchVcs(); document.title = `Git 그래프 — ${basename(state.cwd)}`; gitGraphModal(); }
    if (params.get('svnlog') === '1') { await fetchVcs(); document.title = `SVN 로그 — ${basename(state.cwd)}`; svnLogModal(); }
  } catch (e) {
    toast('초기화 실패: ' + e.message, true);
  }
})();
