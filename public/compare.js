'use strict';

// 비교 창은 탐색기의 선택/단축키와 분리하고 닫을 때 진행 중인 읽기를 취소한다.
const CompareView = (() => {
  const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const labels = { equal: '동일', changed: '다름', left: '왼쪽만', right: '오른쪽만', type: '유형 다름', error: '읽기 오류' };
  const kinds = { file: '파일', folder: '폴더', link: '심볼릭 링크', special: '특수 파일' };
  let overlay, controller, paths, data, history = [], focusBefore, difference = -1, request = 0;
  const el = (id) => overlay.querySelector('#' + id);
  function button(label, action, disabled = false) {
    const b = document.createElement('button'); b.textContent = label; b.disabled = disabled;
    b.addEventListener('click', action); return b;
  }
  function close() {
    request++; controller?.abort(); overlay?.remove(); overlay = null;
    focusBefore?.focus();
  }
  function open(left, right) {
    if (overlay) close();
    focusBefore = document.activeElement; history = [];
    overlay = document.createElement('div'); overlay.className = 'compare-overlay';
    overlay.innerHTML = `<section class="compare-window" role="dialog" aria-modal="true" aria-labelledby="compareTitle">
      <header><h2 id="compareTitle">비교하기</h2><span>읽기 전용</span><button id="cmpClose" aria-label="비교 창 닫기">닫기 (Esc)</button></header>
      <div class="compare-paths"><div id="cmpLeft"></div><div id="cmpRight"></div></div>
      <nav id="cmpTools" aria-label="비교 도구"></nav><div id="cmpSummary" role="status"></div>
      <div id="cmpBody" tabindex="0"></div></section>`;
    document.body.appendChild(overlay);
    el('cmpClose').addEventListener('click', close); el('cmpClose').focus();
    overlay.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      if (e.key === 'F7') { e.preventDefault(); nextDifference(e.shiftKey ? -1 : 1); }
      if (e.key === 'Tab') {
        const controls = [...overlay.querySelectorAll('button:not(:disabled), input, [tabindex="0"]')];
        if (e.shiftKey && document.activeElement === controls[0]) { e.preventDefault(); controls.at(-1).focus(); }
        else if (!e.shiftKey && document.activeElement === controls.at(-1)) { e.preventDefault(); controls[0].focus(); }
      }
    });
    paths = { left, right }; load('auto');
  }
  async function load(mode, offset = 0) {
    controller?.abort(); controller = new AbortController();
    const token = ++request;
    const query = new URLSearchParams({ ...paths, mode, offset });
    el('cmpLeft').textContent = paths.left; el('cmpRight').textContent = paths.right;
    el('cmpLeft').title = paths.left; el('cmpRight').title = paths.right;
    el('cmpSummary').textContent = '전체 내용을 비교하는 중…';
    el('cmpBody').innerHTML = '<div class="compare-empty">불러오는 중…</div>';
    el('cmpTools').replaceChildren(button('좌우 바꾸기', swap), button('다시 비교', () => load(mode, offset)));
    if (history.length) el('cmpTools').prepend(button('상위 비교', back));
    try {
      const response = await fetch('/api/compare?' + query, { signal: controller.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '비교할 수 없습니다');
      if (!overlay || token !== request) return;
      data = result; difference = -1; render();
      if (!overlay.contains(document.activeElement)) el('cmpBody').focus();
    } catch (e) {
      if (!overlay || token !== request || e.name === 'AbortError') return;
      el('cmpSummary').textContent = '비교 실패';
      el('cmpBody').innerHTML = `<div class="compare-empty">${escape(e.message)}</div>`;
      if (mode === 'text') el('cmpTools').appendChild(button('Hex로 보기', () => load('hex')));
    }
  }
  function swap() { paths = { left: paths.right, right: paths.left }; load(data?.kind === 'file' ? data.mode : 'auto'); }
  function back() { paths = history.pop(); load('auto'); }
  function render() {
    const tools = el('cmpTools'); tools.replaceChildren();
    if (history.length) tools.appendChild(button('상위 비교', back));
    tools.append(button('좌우 바꾸기', swap), button('다시 비교', () => load(data.mode || 'auto', data.offset || 0)));
    el('cmpSummary').textContent = data.equal ? '전체 내용이 동일합니다.' : '차이가 있습니다.';
    if (data.notice) el('cmpSummary').textContent += ' ' + data.notice;
    if (data.kind === 'folder') { renderFolder(tools); return; }
    if (data.kind !== 'file') {
      el('cmpBody').innerHTML = `<div class="compare-metadata">${metadata(data.left)}${metadata(data.right)}</div>`;
      return;
    }
    for (const [mode, label] of [['file', '파일 정보'], ['text', '텍스트'], ['hex', 'Hex']]) {
      const b = button(label, () => load(mode)); b.classList.toggle('active', data.mode === mode);
      b.setAttribute('aria-pressed', String(data.mode === mode)); tools.appendChild(b);
    }
    if (data.mode === 'file') {
      el('cmpBody').innerHTML = `<div class="compare-metadata">${metadata(data.left)}${metadata(data.right)}</div>`; return;
    }
    if (data.mode === 'hex') renderHex(tools); else renderText(tools);
  }
  function metadata(item) {
    const rows = [['종류', kinds[item.kind]], ['크기', `${item.size.toLocaleString()} B`], ['수정', new Date(item.mtime).toLocaleString()], ['SHA-256', item.hash], ['링크 대상', item.target]];
    return `<dl>${rows.filter(([, value]) => value).map(([key, value]) => `<dt>${key}</dt><dd>${escape(value)}</dd>`).join('')}</dl>`;
  }
  function renderFolder(tools) {
    const filter = document.createElement('input'); filter.type = 'search'; filter.placeholder = '상대 경로 검색'; filter.setAttribute('aria-label', '비교 항목 검색');
    const only = document.createElement('input'); only.type = 'checkbox';
    const label = document.createElement('label'); label.append(only, '차이만'); tools.append(label, filter);
    el('cmpSummary').textContent = `${data.equal ? '동일한 폴더' : '폴더 차이'} · ` + Object.entries(data.counts).map(([key, value]) => `${labels[key]} ${value}개`).join(' · ');
    const paint = () => {
      const rows = data.rows.filter((r) => (!only.checked || r.status !== 'equal') && r.relative.toLocaleLowerCase().includes(filter.value.toLocaleLowerCase()));
      el('cmpBody').innerHTML = `<table class="compare-folders"><thead><tr><th>상대 경로</th><th>상태</th><th>왼쪽</th><th>오른쪽</th><th></th></tr></thead><tbody>` +
        rows.map((r, i) => `<tr class="cmp-${r.status}" title="${escape(r.error || '')}"><td>${escape(r.relative)}</td><td>${labels[r.status]}</td><td>${entryInfo(r.left)}</td><td>${entryInfo(r.right)}</td><td>${r.left && r.right && r.status !== 'error' ? `<button data-compare="${i}">열어 비교</button>` : ''}</td></tr>`).join('') + '</tbody></table>' +
        (!rows.length ? '<div class="compare-empty">해당 항목이 없습니다.</div>' : '');
      el('cmpBody').querySelectorAll('[data-compare]').forEach((b) => b.addEventListener('click', () => {
        const r = rows[Number(b.dataset.compare)]; history.push({ ...paths }); paths = { left: r.left.path, right: r.right.path }; load('auto');
      }));
    };
    only.addEventListener('change', paint); filter.addEventListener('input', paint); paint();
  }
  function entryInfo(item) { return item ? `${kinds[item.kind] || '읽기 오류'}${item.kind === 'file' ? ` · ${item.size.toLocaleString()} B` : ''}` : '—'; }
  function differenceTools(tools, count) {
    tools.append(button('이전 차이', () => nextDifference(-1), !count), button('다음 차이 (F7)', () => nextDifference(1), !count));
  }
  function nextDifference(step) {
    if (!overlay) return;
    const rows = [...el('cmpBody').querySelectorAll('[data-difference]')];
    if (!rows.length) return;
    difference = difference < 0 ? (step > 0 ? 0 : rows.length - 1) : (difference + step + rows.length) % rows.length;
    rows.forEach((r) => r.classList.remove('cmp-current'));
    rows[difference].classList.add('cmp-current'); rows[difference].scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  function textCell(value, other) {
    if (value === null) return '';
    const ending = value.endsWith('\r\n') ? 'CRLF' : value.endsWith('\n') ? 'LF' : value.endsWith('\r') ? 'CR' : 'EOF';
    const text = value.replace(/\r\n$|[\r\n]$/, '');
    let rendered = escape(text);
    if (other !== null && value !== other) {
      const otherText = other.replace(/\r\n$|[\r\n]$/, '');
      let start = 0, end = 0;
      while (start < text.length && start < otherText.length && text[start] === otherText[start]) start++;
      while (end < text.length - start && end < otherText.length - start && text[text.length - 1 - end] === otherText[otherText.length - 1 - end]) end++;
      rendered = escape(text.slice(0, start)) + `<mark>${escape(text.slice(start, text.length - end))}</mark>` + escape(text.slice(text.length - end));
    }
    return rendered + `<span class="cmp-eol">${ending}</span>`;
  }
  function renderText(tools) {
    const count = data.rows.filter((r) => r.kind !== 'equal').length;
    differenceTools(tools, count);
    const only = document.createElement('input'); only.type = 'checkbox';
    const label = document.createElement('label'); label.append(only, '차이만'); tools.appendChild(label);
    el('cmpSummary').textContent += ` ${data.leftEncoding} ↔ ${data.rightEncoding} · 변경 줄 ${count}개` + (data.simplified ? ' · 큰 변경 구간은 삭제/추가 묶음으로 표시합니다.' : '');
    if (!count && !data.equal) el('cmpSummary').textContent += ' · 글자는 같지만 인코딩/BOM 바이트가 다릅니다. Hex에서 확인하세요.';
    const paint = () => {
      el('cmpBody').innerHTML = '<table class="compare-text"><colgroup><col class="cmp-num"><col><col class="cmp-num"><col></colgroup><thead><tr><th colspan="2">왼쪽</th><th colspan="2">오른쪽</th></tr></thead><tbody>' +
        data.rows.filter((r) => !only.checked || r.kind !== 'equal').map((r) => `<tr class="cmp-${r.kind}"${r.kind !== 'equal' ? ' data-difference' : ''}><td>${r.ln ?? ''}</td><td>${textCell(r.left, r.right)}</td><td>${r.rn ?? ''}</td><td>${textCell(r.right, r.left)}</td></tr>`).join('') + '</tbody></table>';
      difference = -1;
    };
    only.addEventListener('change', paint); paint();
  }
  function renderHex(tools) {
    const total = Math.max(data.left.size, data.right.size), page = data.pageSize;
    tools.append(button('이전 페이지', () => load('hex', Math.max(0, data.offset - page)), data.offset === 0),
      button('다음 페이지', () => load('hex', data.offset + page), data.offset + page >= total));
    const jump = document.createElement('input'); jump.type = 'text'; jump.placeholder = '오프셋 (0x1000)'; jump.setAttribute('aria-label', 'Hex 오프셋'); jump.className = 'compare-offset';
    const go = () => {
      const offset = Number(jump.value.trim());
      if (!jump.value.trim() || !Number.isSafeInteger(offset) || offset < 0 || offset >= total) { jump.setCustomValidity('파일 범위 안의 10진수 또는 0x16진수 오프셋을 입력하세요.'); jump.reportValidity(); return; }
      load('hex', Math.floor(offset / 16) * 16);
    };
    jump.addEventListener('input', () => jump.setCustomValidity(''));
    jump.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); }); tools.append(jump, button('이동', go));
    el('cmpSummary').textContent += ` · 0x${data.offset.toString(16).toUpperCase()}–0x${Math.max(data.offset, Math.min(total, data.offset + page) - 1).toString(16).toUpperCase()} / ${total.toLocaleString()} B`;
    const l = data.leftBytes, r = data.rightBytes, rows = [];
    for (let i = 0; i < Math.max(l.length, r.length); i += 16) {
      const changed = Array.from({ length: 16 }, (_, j) => l[i + j] !== r[i + j]).some(Boolean);
      const side = (a, b) => {
        let hex = '', ascii = '';
        for (let j = i; j < i + 16; j++) {
          const cls = a[j] !== b[j] ? ' class="cmp-byte"' : '';
          hex += `<span${cls}>${a[j] === undefined ? '  ' : a[j].toString(16).padStart(2, '0').toUpperCase()}</span> `;
          ascii += `<span${cls}>${a[j] === undefined ? ' ' : a[j] >= 32 && a[j] <= 126 ? escape(String.fromCharCode(a[j])) : '.'}</span>`;
        }
        return `<td><code>${hex}</code><code class="cmp-ascii">${ascii}</code></td>`;
      };
      rows.push(`<tr${changed ? ' data-difference class="cmp-changed"' : ''}><td>${(data.offset + i).toString(16).padStart(8, '0').toUpperCase()}</td>${side(l, r)}${side(r, l)}</tr>`);
    }
    differenceTools(tools, rows.filter((s) => s.includes('data-difference')).length);
    el('cmpBody').innerHTML = '<table class="compare-hex"><thead><tr><th>오프셋</th><th>왼쪽</th><th>오른쪽</th></tr></thead><tbody>' + rows.join('') + '</tbody></table>';
  }
  return { open, close };
})();
