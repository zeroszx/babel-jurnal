'use strict';
/* Babel — antarmuka */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const OA = 'https://api.openalex.org';
const SELECT = 'id,doi,display_name,publication_year,authorships,primary_location,best_oa_location,open_access,cited_by_count,abstract_inverted_index,keywords,primary_topic,type';

const STATUS_LABEL = { unread: 'Belum dibaca', reading: 'Sedang dibaca', done: 'Selesai' };
const MODE_LABEL = { ringkasan: 'Ringkasan', metodologi: 'Analisis metodologi', kritik: 'Telaah kritis', literatur: 'Bahan tinjauan pustaka', tanya: 'Tanya-jawab' };

const state = {
  lib: { papers: [] },
  settings: {},
  search: { params: null, page: 1, results: [], total: 0, label: '' },
  selSearch: null,
  selLib: null,
  reader: null,
  prevView: 'library',
  ai: { requestId: null, buf: '', el: null }
};

// ---------------- utilitas ----------------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function toast(msg, isErr = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (isErr ? ' err' : '');
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), isErr ? 7000 : 3200);
}
function fmtNum(n) { return (n ?? 0).toLocaleString('id-ID'); }
function shortAuthors(a = [], n = 3) {
  if (!a.length) return 'Penulis tidak diketahui';
  return a.length > n ? a.slice(0, n).join(', ') + ' dkk.' : a.join(', ');
}
function uid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

function askText(title, placeholder = '') {
  return new Promise((resolve) => {
    const m = $('#modal'), inp = $('#modal-input');
    $('#modal-title').textContent = title;
    inp.value = ''; inp.placeholder = placeholder;
    m.hidden = false; inp.focus();
    const done = (v) => { m.hidden = true; $('#modal-form').onsubmit = null; $('#modal-cancel').onclick = null; resolve(v); };
    $('#modal-form').onsubmit = (e) => { e.preventDefault(); done(inp.value.trim()); };
    $('#modal-cancel').onclick = () => done(null);
  });
}

// Markdown sederhana dan aman (HTML di-escape dulu)
function md(src) {
  const lines = esc(src).split(/\r?\n/);
  let html = '', list = null;
  const inline = (s) => s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const raw of lines) {
    const l = raw.trimEnd();
    let m;
    if ((m = l.match(/^#{1,6}\s+(.*)$/))) { closeList(); html += `<h3>${inline(m[1])}</h3>`; }
    else if ((m = l.match(/^\s*[-*•]\s+(.*)$/))) { if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; } html += `<li>${inline(m[1])}</li>`; }
    else if ((m = l.match(/^\s*\d+[.)]\s+(.*)$/))) { if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; } html += `<li>${inline(m[1])}</li>`; }
    else if (!l.trim()) { closeList(); }
    else { closeList(); html += `<p>${inline(l)}</p>`; }
  }
  closeList();
  return html;
}

// ---------------- penyimpanan ----------------
let saveTimer;
function saveLib(now = false) {
  clearTimeout(saveTimer);
  const doSave = () => window.api.saveLibrary(state.lib).catch((e) => toast('Gagal menyimpan: ' + e.message, true));
  if (now) return doSave();
  saveTimer = setTimeout(doSave, 400);
}
const findLib = (id) => state.lib.papers.find((p) => p.id === id);
function updateCount() { $('#lib-count').textContent = state.lib.papers.length; }

// ---------------- OpenAlex ----------------
function invertAbstract(inv) {
  if (!inv) return '';
  const words = [];
  for (const [w, pos] of Object.entries(inv)) for (const i of pos) words[i] = w;
  return words.filter((w) => w !== undefined).join(' ');
}
function normalize(w) {
  const id = (w.id || '').replace('https://openalex.org/', '');
  const doi = (w.doi || '').replace(/^https?:\/\/doi\.org\//i, '');
  const pdfUrls = [...new Set([w.best_oa_location?.pdf_url, w.primary_location?.pdf_url, w.open_access?.oa_url].filter(Boolean))];
  return {
    id,
    doi,
    title: w.display_name || '(tanpa judul)',
    authors: (w.authorships || []).map((a) => a.author?.display_name).filter(Boolean),
    year: w.publication_year || null,
    venue: w.primary_location?.source?.display_name || '',
    abstract: invertAbstract(w.abstract_inverted_index),
    citedBy: w.cited_by_count || 0,
    isOa: !!w.open_access?.is_oa,
    pdfUrls,
    landingUrl: w.primary_location?.landing_page_url || (doi ? 'https://doi.org/' + doi : ''),
    keywords: (w.keywords || []).map((k) => k.display_name).filter(Boolean),
    topic: w.primary_topic?.display_name || '',
    field: w.primary_topic?.field?.display_name || '',
    type: w.type || ''
  };
}
async function oaFetch(pathAndQuery) {
  const url = new URL(OA + pathAndQuery);
  if (state.settings.mailto) url.searchParams.set('mailto', state.settings.mailto);
  if (state.settings.oaKey) url.searchParams.set('api_key', state.settings.oaKey);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status === 503) && attempt < 2) {
      await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
      continue;
    }
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j.message || j.error || msg; } catch {}
    if (res.status === 429 || res.status === 503) {
      msg = 'OpenAlex sedang membatasi pencarian tanpa kunci API. Tunggu sekitar 30 detik lalu coba lagi, atau isi kunci API OpenAlex gratis di Pengaturan agar pencarian tidak terganggu.';
    }
    throw new Error(msg);
  }
}

// ---------------- navigasi ----------------
function showView(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'library') renderLibrary();
  if (name === 'analysis') renderLibStats();
  if (name === 'settings') renderSettings();
}
$$('.nav-btn').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

// ================= CARI =================
async function runSearch({ params, label, append = false }) {
  const s = state.search;
  if (!append) { s.params = params; s.page = 1; s.results = []; s.label = label; state.selSearch = null; state.dview = { paper: null, stack: [], tab: 'ringkasan' }; }
  else s.page += 1;
  const q = new URLSearchParams(s.params);
  q.set('per-page', '25'); q.set('page', String(s.page)); q.set('select', SELECT);
  $('#search-more').hidden = true;
  if (!append) {
    $('#search-count').textContent = '';
    $('#search-head').textContent = s.params.search ? '' : s.label;
    $('#search-results').innerHTML = skeletonList();
    $('#search-detail').innerHTML = skeletonDetail();
  } else {
    $('#search-more').hidden = false;
    $('#search-more').disabled = true;
    $('#search-more').innerHTML = '<span class="spin"></span> Memuat…';
  }
  try {
    const data = await oaFetch('/works?' + q.toString());
    s.total = data.meta?.count || 0;
    s.results.push(...(data.results || []).map(normalize));
    renderSearchResults();
  } catch (e) {
    $('#search-head').textContent = 'Pencarian gagal: ' + e.message;
    if (!append) { $('#search-results').innerHTML = ''; $('#search-detail').innerHTML = '<div class="empty">Pencarian gagal.</div>'; }
  } finally {
    $('#search-more').disabled = false;
    $('#search-more').textContent = 'Muat lebih banyak';
  }
}
function skeletonList() {
  return ['first', '', '', ''].map((c) => `<div class="skel ${c}"></div>`).join('');
}
function skeletonDetail() {
  return `<div style="padding-top:8px">${[92, 70, 85, 40, 30].map((w) => `<div class="skel-line" style="width:${w}%;height:${w > 60 ? 26 : 14}px"></div>`).join('')}
    <div style="height:30px"></div>${[100, 96, 98, 60].map((w) => `<div class="skel-line" style="width:${w}%"></div>`).join('')}</div>`;
}
const ICON = {
  book: '<svg class="i" viewBox="0 0 24 24"><path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z"/></svg>',
  plus: '<svg class="i" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  download: '<svg class="i" viewBox="0 0 24 24"><path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>',
  external: '<svg class="i" viewBox="0 0 24 24"><path d="M14 4h6v6"/><path d="M10 14 20 4"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>',
  back: '<svg class="i" viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg>'
};
function buildSearchParams() {
  const q = $('#q').value.trim();
  const p = {};
  const filters = [];
  if (q) p.search = q;
  const yf = $('#year-from').value, yt = $('#year-to').value;
  if (yf) filters.push(`from_publication_date:${yf}-01-01`);
  if (yt) filters.push(`to_publication_date:${yt}-12-31`);
  if ($('#oa-only').checked) filters.push('is_oa:true');
  if (filters.length) p.filter = filters.join(',');
  let sort = $('#sort').value;
  if (sort.startsWith('relevance') && !q) sort = 'cited_by_count:desc';
  p.sort = sort;
  return { p, q };
}
$('#search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const { p, q } = buildSearchParams();
  if (!q) { toast('Masukkan kata kunci pencarian.'); return; }
  runSearch({ params: p, label: `“${q}”` });
});
$('#search-more').addEventListener('click', () => runSearch({ append: true }));

function relatedSearch(kind, paper) {
  const map = {
    cites: { filter: `cites:${paper.id}`, sort: 'cited_by_count:desc', label: `Paper yang mengutip “${paper.title}”` },
    refs: { filter: `cited_by:${paper.id}`, sort: 'cited_by_count:desc', label: `Referensi dari “${paper.title}”` },
    related: { filter: `related_to:${paper.id}`, sort: 'cited_by_count:desc', label: `Paper terkait “${paper.title}”` }
  }[kind];
  showView('search');
  runSearch({ params: { filter: map.filter, sort: map.sort }, label: map.label });
}

function paperItemHtml(p, sel, extra = '') {
  const saved = findLib(p.id);
  return `<div class="item${sel ? ' sel' : ''}" data-id="${esc(p.id)}">
    <div class="t">${esc(p.title)}</div>
    <div class="m">${esc(shortAuthors(p.authors))}</div>
    <div class="m">${esc(p.year || 's.a.')}${p.venue ? ' · <em>' + esc(p.venue) + '</em>' : ''}${p.type === 'local' ? '' : ' · Dikutip ' + fmtNum(p.citedBy) + '×'}</div>
    ${p.doi ? `<div class="m">DOI: ${esc(p.doi)}</div>` : ''}
    <div class="chips">
      ${p.isOa ? '<span class="pill oa">Akses terbuka</span>' : ''}
      ${saved && !extra ? '<span class="pill saved">✓ Di perpustakaan</span>' : ''}
      ${extra}
    </div></div>`;
}
function renderSearchResults() {
  const s = state.search;
  $('#search-count').textContent = s.results.length ? `${fmtNum(s.total)} hasil` : '';
  $('#search-head').textContent = !s.results.length ? `Tidak ada hasil untuk ${s.label}.` : (s.params?.search ? '' : s.label);
  if (s.results.length && !state.selSearch) state.selSearch = s.results[0].id;
  $('#search-results').innerHTML = s.results.map((p) => paperItemHtml(p, p.id === state.selSearch)).join('');
  $('#search-more').hidden = s.results.length >= s.total || !s.results.length;
  if (!state.dview?.paper) renderSearchDetail();
}
$('#search-results').addEventListener('click', (e) => {
  const it = e.target.closest('.item'); if (!it) return;
  state.selSearch = it.dataset.id;
  state.dview = { paper: null, stack: [], tab: 'ringkasan' };
  $$('#search-results .item').forEach((x) => x.classList.toggle('sel', x === it));
  renderSearchDetail();
});

// ---- panel detail dengan tab ----
state.dview = { paper: null, stack: [], tab: 'ringkasan' };
const tabCache = new Map();
const DTABS = [
  ['ringkasan', 'Ringkasan'],
  ['cites', 'Siapa yang mengutip?'],
  ['refs', 'Daftar referensi'],
  ['related', 'Paper terkait']
];
const TAB_FILTER = { cites: (id) => `cites:${id}`, refs: (id) => `cited_by:${id}`, related: (id) => `related_to:${id}` };
const TAB_EMPTY = { cites: 'Belum ada paper yang tercatat mengutip paper ini.', refs: 'Daftar referensi paper ini tidak tersedia di OpenAlex.', related: 'Tidak ada paper terkait yang ditemukan.' };

function renderSearchDetail() {
  const el = $('#search-detail');
  const dv = state.dview;
  if (!dv.paper) {
    dv.paper = state.search.results.find((r) => r.id === state.selSearch) || null;
    dv.stack = []; dv.tab = 'ringkasan';
  }
  const p = dv.paper;
  if (!p) { el.innerHTML = '<div class="empty">Pilih salah satu hasil untuk melihat detailnya.</div>'; el.onclick = null; return; }
  const saved = findLib(p.id);
  const prev = dv.stack[dv.stack.length - 1];
  el.innerHTML = `
    ${prev ? `<div class="crumb"><button class="link-btn" data-act="back" style="text-decoration:none">${ICON.back} Kembali ke “${esc(prev.paper.title.slice(0, 60))}${prev.paper.title.length > 60 ? '…' : ''}”</button></div>` : ''}
    <h1>${esc(p.title)}</h1>
    <div class="authors">${esc(p.authors.join(', ') || 'Penulis tidak diketahui')}</div>
    <div class="meta">${esc(p.year || 's.a.')}${p.venue ? ' · <em>' + esc(p.venue) + '</em>' : ''} · Dikutip ${fmtNum(p.citedBy)}×${p.doi ? '<br>DOI: ' + esc(p.doi) : ''}</div>
    <div class="actions">
      ${saved ? `<button class="btn lg" data-act="goto">${ICON.book} Buka di perpustakaan</button>` : `<button class="btn lg" data-act="save">${ICON.plus} Simpan ke perpustakaan</button>`}
      ${p.pdfUrls.length ? `<button class="btn primary lg" data-act="read">${ICON.download} Unduh PDF &amp; baca</button>` : ''}
      ${p.landingUrl ? `<button class="link-btn" data-act="web">Halaman penerbit ${ICON.external}</button>` : ''}
    </div>
    <div class="dtabs">${DTABS.map(([k, l]) => `<button class="dtab${dv.tab === k ? ' active' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>
    <div class="dtab-body" id="dtab-body"></div>
  `;
  renderDetailTab();
  el.onclick = async (e) => {
    const tab = e.target.closest('.dtab');
    if (tab) { dv.tab = tab.dataset.tab; $$('.dtab', el).forEach((t) => t.classList.toggle('active', t === tab)); renderDetailTab(); return; }
    const sub = e.target.closest('#dtab-body .item');
    if (sub) {
      const next = (tabCache.get(`${p.id}:${dv.tab}`)?.results || []).find((x) => x.id === sub.dataset.id);
      if (next) { dv.stack.push({ paper: p, tab: dv.tab }); dv.paper = next; dv.tab = 'ringkasan'; renderSearchDetail(); el.scrollTop = 0; }
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act; if (!act) return;
    if (act === 'back') { const b = dv.stack.pop(); dv.paper = b.paper; dv.tab = b.tab; renderSearchDetail(); return; }
    if (act === 'save') { addToLibrary(p); renderSearchDetail(); renderSearchResults(); toast('Disimpan ke perpustakaan.'); }
    if (act === 'goto') { state.selLib = p.id; showView('library'); }
    if (act === 'web') window.api.openExternal(p.landingUrl);
    if (act === 'read') {
      const lp = findLib(p.id) || addToLibrary(p);
      renderSearchDetail(); renderSearchResults();
      openReader(lp.id, 'search');
    }
    if (act === 'all') relatedSearch(dv.tab, p);
  };
}

async function renderDetailTab() {
  const dv = state.dview, p = dv.paper, body = $('#dtab-body');
  if (!body || !p) return;
  if (dv.tab === 'ringkasan') {
    body.innerHTML = `
      ${p.topic ? `<h4 style="margin-top:0">Topik</h4><div style="font-size:17px">${esc(p.topic)}${p.field ? ' <span class="muted">· ' + esc(p.field) + '</span>' : ''}</div>` : ''}
      <h4${p.topic ? '' : ' style="margin-top:0"'}>Abstrak</h4>
      <div class="abstract">${esc(p.abstract || 'Abstrak tidak tersedia di OpenAlex.')}</div>
      ${p.keywords.length ? `<h4>Kata kunci</h4><div class="chips" style="display:flex;gap:6px;flex-wrap:wrap">${p.keywords.map((k) => `<span class="pill">${esc(k)}</span>`).join('')}</div>` : ''}`;
    return;
  }
  const key = `${p.id}:${dv.tab}`, tab = dv.tab;
  if (!tabCache.has(key)) {
    body.innerHTML = [1, 2, 3].map(() => '<div class="skel" style="min-height:84px;margin-bottom:10px"></div>').join('');
    try {
      const data = await oaFetch(`/works?filter=${TAB_FILTER[tab](p.id)}&sort=cited_by_count:desc&per-page=10&select=${SELECT}`);
      tabCache.set(key, { total: data.meta?.count || 0, results: (data.results || []).map(normalize) });
    } catch (e) {
      if (dv.paper === p && dv.tab === tab) body.innerHTML = `<div class="empty small" style="color:var(--warn)">Gagal memuat: ${esc(e.message)}</div>`;
      return;
    }
  }
  if (dv.paper !== p || dv.tab !== tab) return; // pengguna sudah pindah tab
  const { total, results } = tabCache.get(key);
  if (!results.length) { body.innerHTML = `<div class="empty small">${TAB_EMPTY[tab]}</div>`; return; }
  body.innerHTML = `<div class="list" style="overflow:visible;padding:0">${results.map((r) => paperItemHtml(r, false)).join('')}</div>
    ${total > results.length ? `<div class="dtab-foot"><button class="btn" data-act="all">Tampilkan semua ${fmtNum(total)} di hasil pencarian</button></div>` : ''}`;
}

function addToLibrary(p) {
  const existing = findLib(p.id);
  if (existing) return existing;
  const entry = { ...p, tags: [], status: 'unread', rating: 0, notes: '', pdfFile: '', aiNotes: [], addedAt: new Date().toISOString() };
  state.lib.papers.unshift(entry);
  saveLib(); updateCount();
  return entry;
}

// ================= PERPUSTAKAAN =================
['#lib-q', '#lib-status', '#lib-tag', '#lib-sort'].forEach((s) => $(s).addEventListener('input', renderLibrary));

function allTags() {
  const m = new Map();
  state.lib.papers.forEach((p) => (p.tags || []).forEach((t) => m.set(t, (m.get(t) || 0) + 1)));
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}
function filteredLib() {
  const q = $('#lib-q').value.trim().toLowerCase();
  const st = $('#lib-status').value, tag = $('#lib-tag').value, sort = $('#lib-sort').value;
  let arr = state.lib.papers.filter((p) => {
    if (st && p.status !== st) return false;
    if (tag && !(p.tags || []).includes(tag)) return false;
    if (q) {
      const hay = [p.title, p.authors.join(' '), p.venue, p.notes, (p.tags || []).join(' '), p.abstract, p.doi].join(' ').toLowerCase();
      return q.split(/\s+/).every((w) => hay.includes(w));
    }
    return true;
  });
  const cmp = {
    added: (a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''),
    year: (a, b) => (b.year || 0) - (a.year || 0),
    cited: (a, b) => (b.citedBy || 0) - (a.citedBy || 0),
    title: (a, b) => a.title.localeCompare(b.title, 'id'),
    rating: (a, b) => (b.rating || 0) - (a.rating || 0)
  }[sort];
  return arr.sort(cmp);
}
function renderLibrary() {
  const tagSel = $('#lib-tag'), cur = tagSel.value;
  tagSel.innerHTML = '<option value="">Semua tag</option>' + allTags().map(([t, n]) => `<option value="${esc(t)}">${esc(t)} (${n})</option>`).join('');
  tagSel.value = cur;
  const arr = filteredLib();
  $('#lib-count2').textContent = state.lib.papers.length ? `${arr.length} dari ${state.lib.papers.length} paper` : '';
  $('#lib-head').textContent = state.lib.papers.length
    ? (arr.length ? '' : 'Tidak ada paper yang cocok dengan filter.')
    : 'Perpustakaan masih kosong. Simpan paper dari menu Cari Jurnal, tambahkan lewat DOI, atau impor PDF.';
  $('#lib-list').innerHTML = arr.map((p) => paperItemHtml(p, p.id === state.selLib,
    `<span class="pill st-${p.status}">${STATUS_LABEL[p.status]}</span>${p.pdfFile ? '<span class="pill">PDF</span>' : ''}${p.rating ? `<span class="pill">${'★'.repeat(p.rating)}</span>` : ''}${(p.tags || []).map((t) => `<span class="pill tag">${esc(t)}</span>`).join('')}`
  )).join('');
  renderLibDetail();
}
$('#lib-list').addEventListener('click', (e) => {
  const it = e.target.closest('.item'); if (!it) return;
  state.selLib = it.dataset.id;
  $$('#lib-list .item').forEach((x) => x.classList.toggle('sel', x === it));
  renderLibDetail();
});
$('#lib-list').addEventListener('dblclick', (e) => {
  const it = e.target.closest('.item'); if (it) openReader(it.dataset.id, 'library');
});

function renderLibDetail() {
  const el = $('#lib-detail');
  const p = findLib(state.selLib);
  if (!p) { el.innerHTML = '<div class="empty">Pilih paper untuk melihat detail, catatan, dan tag.<br><small>Klik dua kali untuk langsung membaca.</small></div>'; el.onclick = null; return; }
  const isLocal = p.id.startsWith('local-');
  el.innerHTML = `
    <h1 ${isLocal ? 'contenteditable="true" id="edit-title" title="Klik untuk mengubah judul"' : ''}>${esc(p.title)}</h1>
    <div class="authors">${esc(p.authors.join(', ') || (isLocal ? 'PDF lokal — metadata belum lengkap' : ''))}</div>
    <div class="meta">${esc(p.year || 's.a.')}${p.venue ? ' · <em>' + esc(p.venue) + '</em>' : ''}${isLocal ? '' : ' · Dikutip ' + fmtNum(p.citedBy) + '×'}${p.doi ? '<br>DOI: ' + esc(p.doi) : ''}</div>
    <div class="actions">
      <button class="btn primary lg" data-act="read">${ICON.book} ${p.pdfFile ? 'Baca &amp; analisis' : 'Buka pembaca &amp; analisis'}</button>
      ${!p.pdfFile && p.pdfUrls?.length ? `<button class="btn lg" data-act="dl">${ICON.download} Unduh PDF</button>` : ''}
      ${p.landingUrl ? `<button class="link-btn" data-act="web">Halaman penerbit ${ICON.external}</button>` : ''}
    </div>
    <div class="actions compact">
      <button class="btn sm" data-act="attach">${p.pdfFile ? 'Ganti PDF' : 'Lampirkan PDF lokal'}</button>
      <button class="btn sm" data-act="cite">Salin sitasi APA</button>
      ${isLocal ? '<button class="btn sm" data-act="doi">Lengkapi via DOI</button>' : ''}
      <button class="btn sm danger" data-act="del">Hapus</button>
    </div>
    <div class="field">
      <select data-f="status">${Object.entries(STATUS_LABEL).map(([k, v]) => `<option value="${k}"${p.status === k ? ' selected' : ''}>${v}</option>`).join('')}</select>
      <span class="stars" data-f="rating">${[1, 2, 3, 4, 5].map((i) => `<span data-r="${i}" class="${i <= (p.rating || 0) ? 'on' : ''}">★</span>`).join('')}</span>
    </div>
    <div class="field tag-input">
      ${(p.tags || []).map((t) => `<span class="pill tag" data-tag="${esc(t)}" title="Klik untuk menghapus tag">${esc(t)} ×</span>`).join('')}
      <input id="tag-new" list="tag-list" placeholder="+ tag (Enter)" />
      <datalist id="tag-list">${allTags().map(([t]) => `<option value="${esc(t)}">`).join('')}</datalist>
    </div>
    ${!isLocal ? `<div class="actions compact"><button class="btn sm" data-act="cites">Siapa yang mengutip?</button><button class="btn sm" data-act="refs">Referensi</button><button class="btn sm" data-act="related">Paper terkait</button></div>` : ''}
    <h4>Catatan</h4>
    <textarea id="lib-notes" placeholder="Catatan pribadi, kutipan penting, ide penelitian… (tersimpan otomatis)">${esc(p.notes || '')}</textarea>
    ${(p.aiNotes || []).length ? `<h4>Hasil analisis AI tersimpan</h4>${p.aiNotes.map((n, i) => `
      <details class="ai-saved"><summary>${esc(MODE_LABEL[n.mode] || n.mode)} · ${new Date(n.date).toLocaleString('id-ID')}</summary>
      <div class="md">${md(n.text)}</div><button class="btn sm danger" data-act="delai" data-i="${i}">Hapus</button></details>`).join('')}` : ''}
    <h4>Abstrak</h4>
    <div class="abstract">${esc(p.abstract || 'Abstrak tidak tersedia.')}</div>
    ${p.keywords?.length ? `<h4>Kata kunci</h4><div class="chips">${p.keywords.map((k) => `<span class="pill">${esc(k)}</span>`).join(' ')}</div>` : ''}
  `;
  $('#lib-notes').addEventListener('input', (e) => { p.notes = e.target.value; saveLib(); });
  $('[data-f=status]', el).addEventListener('change', (e) => { p.status = e.target.value; saveLib(); renderLibrary(); });
  $('#tag-new').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const t = e.target.value.trim(); if (!t) return;
    p.tags = [...new Set([...(p.tags || []), t])]; saveLib(); renderLibrary();
    $('#tag-new')?.focus();
  });
  const titleEl = $('#edit-title');
  if (titleEl) titleEl.addEventListener('blur', () => { p.title = titleEl.textContent.trim() || p.title; saveLib(); renderLibrary(); });

  el.onclick = async (e) => {
    const star = e.target.closest('[data-r]');
    if (star) { const r = +star.dataset.r; p.rating = p.rating === r ? 0 : r; saveLib(); renderLibrary(); return; }
    const tg = e.target.closest('[data-tag]');
    if (tg) { p.tags = p.tags.filter((t) => t !== tg.dataset.tag); saveLib(); renderLibrary(); return; }
    const btn = e.target.closest('[data-act]'); if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'read') openReader(p.id, 'library');
    if (act === 'web') window.api.openExternal(p.landingUrl);
    if (act === 'dl') { await downloadPdf(p); renderLibrary(); }
    if (act === 'attach') { const r = await window.api.attachPdf(p.id); if (r) { p.pdfFile = r.fileName; saveLib(); renderLibrary(); toast('PDF dilampirkan.'); } }
    if (act === 'cite') { await navigator.clipboard.writeText(toApa(p)); toast('Sitasi APA disalin ke clipboard.'); }
    if (act === 'doi') await completeViaDoi(p);
    if (act === 'delai') { p.aiNotes.splice(+btn.dataset.i, 1); saveLib(); renderLibDetail(); }
    if (['cites', 'refs', 'related'].includes(act)) relatedSearch(act, p);
    if (act === 'del') {
      if (!confirm(`Hapus “${p.title}” dari perpustakaan?\nCatatan dan PDF-nya juga akan dihapus.`)) return;
      if (p.pdfFile) await window.api.deletePdf(p.pdfFile);
      state.lib.papers = state.lib.papers.filter((x) => x.id !== p.id);
      state.selLib = null; saveLib(); updateCount(); renderLibrary();
    }
  };
}

async function downloadPdf(p) {
  toast('Mengunduh PDF…');
  const r = await window.api.downloadPdf(p.id, p.pdfUrls || []);
  if (r.ok) { p.pdfFile = r.fileName; saveLib(); toast('PDF berhasil diunduh.'); return true; }
  toast('PDF tidak bisa diunduh otomatis (sering terjadi karena penerbit memblokir unduhan langsung). Coba buka halaman penerbit lalu lampirkan PDF secara manual.\n\n' + r.error, true);
  return false;
}

async function fetchByDoi(doi) {
  const clean = doi.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '');
  const w = await oaFetch('/works/doi:' + encodeURIComponent(clean) + '?select=' + SELECT);
  return normalize(w);
}
$('#add-doi').addEventListener('click', async () => {
  const doi = await askText('Tambah paper lewat DOI', 'mis. 10.1038/s41586-021-03819-2');
  if (!doi) return;
  try {
    const p = await fetchByDoi(doi);
    if (findLib(p.id)) { toast('Paper ini sudah ada di perpustakaan.'); }
    else { addToLibrary(p); toast('Ditambahkan: ' + p.title); }
    state.selLib = p.id; renderLibrary();
  } catch (e) { toast('DOI tidak ditemukan di OpenAlex: ' + e.message, true); }
});
async function completeViaDoi(p) {
  const doi = await askText('DOI untuk PDF ini', 'mis. 10.1016/j.cell.2020.01.001');
  if (!doi) return;
  try {
    const meta = await fetchByDoi(doi);
    if (findLib(meta.id)) { toast('Paper dengan DOI ini sudah ada di perpustakaan.', true); return; }
    const keep = { tags: p.tags, status: p.status, rating: p.rating, notes: p.notes, pdfFile: p.pdfFile, aiNotes: p.aiNotes, addedAt: p.addedAt };
    Object.assign(p, meta, keep);
    state.selLib = p.id; saveLib(); renderLibrary(); toast('Metadata dilengkapi.');
  } catch (e) { toast('DOI tidak ditemukan: ' + e.message, true); }
}
$('#import-pdf').addEventListener('click', async () => {
  const files = await window.api.importPdfs();
  for (const f of files) {
    state.lib.papers.unshift({ id: f.id, doi: '', title: f.title, authors: [], year: null, venue: '', abstract: '', citedBy: 0, isOa: false, pdfUrls: [], landingUrl: '', keywords: [], topic: '', field: '', type: 'local',
      tags: [], status: 'unread', rating: 0, notes: '', pdfFile: f.fileName, aiNotes: [], addedAt: new Date().toISOString() });
  }
  if (files.length) { state.selLib = files[0].id; saveLib(); updateCount(); renderLibrary(); toast(`${files.length} PDF diimpor. Klik "Lengkapi via DOI" untuk mengisi metadata.`); }
});

// ---- sitasi & ekspor ----
function splitName(full) {
  const parts = full.trim().split(/\s+/);
  const last = parts.pop() || '';
  return { last, initials: parts.map((x) => x[0].toUpperCase() + '.').join(' ') };
}
function toApa(p) {
  const names = p.authors.map((a) => { const n = splitName(a); return n.initials ? `${n.last}, ${n.initials}` : n.last; });
  let au;
  if (!names.length) au = '';
  else if (names.length === 1) au = names[0];
  else if (names.length <= 20) au = names.slice(0, -1).join(', ') + ', & ' + names[names.length - 1];
  else au = names.slice(0, 19).join(', ') + ', … ' + names[names.length - 1];
  return `${au ? au + ' ' : ''}(${p.year || 's.a.'}). ${p.title}.${p.venue ? ' ' + p.venue + '.' : ''}${p.doi ? ' https://doi.org/' + p.doi : ''}`.trim();
}
function bibKey(p, used) {
  const last = (p.authors[0] ? splitName(p.authors[0]).last : 'anon').normalize('NFD').replace(/[^A-Za-z]/g, '').toLowerCase() || 'anon';
  const word = (p.title.normalize('NFD').match(/[A-Za-z]{4,}/) || ['paper'])[0].toLowerCase();
  let k = `${last}${p.year || ''}${word}`, i = 1;
  while (used.has(k)) k = `${last}${p.year || ''}${word}${++i}`;
  used.add(k); return k;
}
const bibEsc = (s) => String(s || '').replace(/[{}]/g, '');
function toBibtex(arr) {
  const used = new Set();
  return arr.map((p) => {
    const f = [
      ['title', `{${bibEsc(p.title)}}`],
      ['author', bibEsc(p.authors.join(' and '))],
      ['year', p.year || ''],
      ['journal', bibEsc(p.venue)],
      ['doi', p.doi],
      ['keywords', bibEsc((p.tags || []).join(', '))]
    ].filter(([, v]) => v);
    return `@article{${bibKey(p, used)},\n${f.map(([k, v]) => `  ${k} = {${v}}`).join(',\n')}\n}`;
  }).join('\n\n') + '\n';
}
function toRis(arr) {
  return arr.map((p) => [
    'TY  - JOUR', `TI  - ${p.title}`, ...p.authors.map((a) => { const n = splitName(a); return `AU  - ${n.last}, ${n.initials}`; }),
    p.year ? `PY  - ${p.year}` : '', p.venue ? `JO  - ${p.venue}` : '', p.doi ? `DO  - ${p.doi}` : '',
    p.abstract ? `AB  - ${p.abstract}` : '', ...(p.tags || []).map((t) => `KW  - ${t}`), p.notes ? `N1  - ${p.notes.replace(/\n/g, ' ')}` : '', 'ER  - '
  ].filter(Boolean).join('\r\n')).join('\r\n\r\n') + '\r\n';
}
$('#export-btn').addEventListener('click', (e) => { e.stopPropagation(); $('#export-menu').hidden = !$('#export-menu').hidden; });
document.addEventListener('click', () => { $('#export-menu').hidden = true; });
$('#export-menu').addEventListener('click', async (e) => {
  const fmt = e.target.closest('[data-fmt]')?.dataset.fmt; if (!fmt) return;
  const arr = filteredLib();
  if (!arr.length) { toast('Tidak ada paper untuk diekspor.'); return; }
  let content, ext = fmt === 'apa' ? 'txt' : fmt;
  if (fmt === 'bib') content = toBibtex(arr);
  if (fmt === 'ris') content = toRis(arr);
  if (fmt === 'apa') content = arr.map(toApa).sort((a, b) => a.localeCompare(b, 'id')).join('\n\n') + '\n';
  const saved = await window.api.saveExport(content, `babel.${ext}`, ext);
  if (saved) toast(`${arr.length} paper diekspor ke ${saved}`);
});

// ================= PEMBACA =================
async function openReader(id, from) {
  const p = findLib(id); if (!p) return;
  state.reader = id; state.prevView = from || 'library';
  if (p.status === 'unread') { p.status = 'reading'; saveLib(); }
  $('#reader-title').textContent = p.title;
  $('#reader-notes').value = p.notes || '';
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-reader'));
  resetAiPane();
  await renderReaderDoc(p);
}
async function renderReaderDoc(p) {
  const doc = $('#reader-doc');
  if (!p.pdfFile && p.pdfUrls?.length) {
    doc.innerHTML = '<div class="empty"><span class="spin"></span> Mengunduh PDF…</div>';
    await downloadPdf(p);
  }
  const url = p.pdfFile ? await window.api.pdfUrl(p.pdfFile) : null;
  if (url) {
    doc.innerHTML = `<iframe src="${esc(url)}#view=FitH" title="PDF"></iframe>`;
  } else {
    doc.innerHTML = `<div class="nopdf">
      <h3>PDF belum tersedia</h3>
      <p class="muted">Kamu tetap bisa mencatat dan memakai analisis AI berdasarkan abstrak. Untuk analisis teks lengkap, lampirkan PDF-nya.</p>
      <div class="row"><button class="btn primary" id="rd-attach">Lampirkan PDF lokal</button>${p.landingUrl ? '<button class="btn" id="rd-web">Buka halaman penerbit ↗</button>' : ''}</div>
      <h4 class="muted">Abstrak</h4><div class="abstract" style="font:15px/1.65 var(--serif)">${esc(p.abstract || 'Abstrak tidak tersedia.')}</div></div>`;
    $('#rd-attach').onclick = async () => { const r = await window.api.attachPdf(p.id); if (r) { p.pdfFile = r.fileName; saveLib(); window.api.aiResetChat(p.id); renderReaderDoc(p); } };
    if ($('#rd-web')) $('#rd-web').onclick = () => window.api.openExternal(p.landingUrl);
  }
}
$('#reader-back').addEventListener('click', () => { cancelAi(); showView(state.prevView); });
$('#reader-notes').addEventListener('input', (e) => { const p = findLib(state.reader); if (p) { p.notes = e.target.value; saveLib(); } });
$$('.tab').forEach((t) => t.addEventListener('click', () => {
  $$('.tab').forEach((x) => x.classList.toggle('active', x === t));
  $$('.tab-pane').forEach((x) => x.classList.toggle('active', x.id === 'tab-' + t.dataset.tab));
}));

// ---- AI ----
function resetAiPane() {
  cancelAi();
  $('#ai-out').innerHTML = '<div class="empty small">Pilih jenis analisis di atas, atau ajukan pertanyaan tentang paper ini di bawah.<br><br>Jika PDF tersedia, AI membaca teks lengkapnya. Jika tidak, analisis memakai abstrak.</div>';
  if (state.reader) window.api.aiResetChat(state.reader);
}
function setBusy(b) {
  $$('.ai-modes button, #ai-send, #ai-reset').forEach((x) => { x.disabled = b; });
  $('#ai-stop').hidden = !b;
}
function cancelAi() { if (state.ai.requestId) window.api.aiCancel(state.ai.requestId); }

window.api.onAiDelta(({ requestId, text }) => {
  if (requestId !== state.ai.requestId || !state.ai.el) return;
  state.ai.buf += text;
  if (!state.ai.raf) state.ai.raf = requestAnimationFrame(() => {
    state.ai.raf = 0;
    if (state.ai.el) { state.ai.el.innerHTML = md(state.ai.buf); state.ai.el.classList.add('cursor'); scrollAi(); }
  });
});
window.api.onAiStatus(({ requestId, text }) => {
  if (requestId !== state.ai.requestId || !state.ai.el || state.ai.buf) return;
  state.ai.el.innerHTML = text ? `<p class="muted"><em>${esc(text)}</em></p>` : '';
});
function scrollAi() { const o = $('#ai-out'); o.scrollTop = o.scrollHeight; }

async function runAi(mode, question) {
  const p = findLib(state.reader); if (!p) return;
  const out = $('#ai-out');
  if (out.querySelector('.empty')) out.innerHTML = '';
  if (mode !== 'tanya') { out.innerHTML = ''; window.api.aiResetChat(p.id); }
  if (question) out.insertAdjacentHTML('beforeend', `<div class="msg user"><div class="who">Kamu</div><div class="body">${esc(question)}</div></div>`);
  const box = document.createElement('div');
  box.className = 'msg';
  box.innerHTML = `<div class="who">${esc(MODE_LABEL[mode])} · ${esc(providerName())} <span class="spin"></span></div><div class="body md"></div>`;
  out.appendChild(box); scrollAi();

  const requestId = uid();
  state.ai = { requestId, buf: '', el: box.querySelector('.body'), raf: 0 };
  setBusy(true);
  const r = await window.api.aiRun({ requestId, mode, question, paper: p });
  if (state.ai.requestId !== requestId) return;
  setBusy(false);
  const body = box.querySelector('.body');
  body.classList.remove('cursor');
  box.querySelector('.spin')?.remove();
  state.ai = { requestId: null, buf: '', el: null };
  if (!r.ok) {
    body.classList.add('err'); body.textContent = r.error;
    if (/Kunci API/.test(r.error)) body.insertAdjacentHTML('beforeend', ' <button class="btn sm" id="go-settings">Buka Pengaturan</button>');
    $('#go-settings')?.addEventListener('click', () => showView('settings'));
    return;
  }
  body.innerHTML = md(r.text);
  const who = box.querySelector('.who');
  who.insertAdjacentHTML('beforeend', `<span class="pill">${r.hasPdf ? 'teks lengkap' : 'abstrak saja'}</span>`);
  if (r.fallback) who.insertAdjacentHTML('beforeend', `<span class="pill" title="Model utama sedang sibuk">model cadangan: ${esc(r.model)}</span>`);
  if (r.truncated) body.insertAdjacentHTML('beforeend', '<p class="muted"><em>(Jawaban terpotong karena terlalu panjang.)</em></p>');
  const actions = document.createElement('div');
  actions.className = 'row';
  actions.innerHTML = '<button class="btn sm">Simpan ke paper</button><button class="btn sm">Salin</button><button class="btn sm">Tambahkan ke catatan</button>';
  const [bSave, bCopy, bNote] = actions.children;
  bSave.onclick = () => { p.aiNotes = p.aiNotes || []; p.aiNotes.unshift({ mode, text: (question ? `**Pertanyaan:** ${question}\n\n` : '') + r.text, date: new Date().toISOString() }); saveLib(); bSave.disabled = true; bSave.textContent = '✓ Tersimpan'; };
  bCopy.onclick = async () => { await navigator.clipboard.writeText(r.text); toast('Disalin.'); };
  bNote.onclick = () => { p.notes = (p.notes ? p.notes + '\n\n' : '') + `--- ${MODE_LABEL[mode]} (AI) ---\n` + (question ? `T: ${question}\n` : '') + r.text; $('#reader-notes').value = p.notes; saveLib(); toast('Ditambahkan ke catatan.'); };
  box.appendChild(actions);
  scrollAi();
}
$$('.ai-modes button').forEach((b) => b.addEventListener('click', () => runAi(b.dataset.mode)));
$('#ai-ask').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#ai-q').value.trim(); if (!q || state.ai.requestId) return;
  $('#ai-q').value = '';
  runAi('tanya', q);
});
$('#ai-q').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#ai-ask').requestSubmit(); } });
$('#ai-stop').addEventListener('click', cancelAi);
$('#ai-reset').addEventListener('click', resetAiPane);

// ================= ANALISIS =================
function countTop(values, n = 10) {
  const m = new Map();
  values.forEach((v) => { if (v) m.set(v, (m.get(v) || 0) + 1); });
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([label, value]) => ({ label, value }));
}
function hbars(data, emptyMsg = 'Belum ada data.') {
  if (!data.length) return `<div class="muted">${emptyMsg}</div>`;
  const max = Math.max(...data.map((d) => d.value));
  return `<div class="hbars">${data.map((d) => `<div class="hbar" title="${esc(d.label)}: ${fmtNum(d.value)}"><span class="lbl">${esc(d.label)}</span><span class="track"><span class="fill" style="width:${(d.value / max) * 100}%;display:block"></span></span><span class="v">${fmtNum(d.value)}</span></div>`).join('')}</div>`;
}
function vbars(data) {
  if (!data.length) return '<div class="muted">Belum ada data.</div>';
  const W = 720, H = 220, pad = { l: 40, r: 8, t: 10, b: 24 };
  const max = Math.max(...data.map((d) => d.value)) || 1;
  const bw = (W - pad.l - pad.r) / data.length;
  const step = Math.ceil(data.length / 14);
  const ticks = [0, 0.5, 1].map((f) => Math.round(max * f));
  let s = `<svg viewBox="0 0 ${W} ${H}">`;
  ticks.forEach((t) => { const y = H - pad.b - (t / max) * (H - pad.t - pad.b); s += `<line class="axis" x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}"/><text x="${pad.l - 6}" y="${y + 3}" text-anchor="end">${fmtNum(t)}</text>`; });
  data.forEach((d, i) => {
    const h = (d.value / max) * (H - pad.t - pad.b);
    const x = pad.l + i * bw;
    const w = Math.max(1, Math.min(bw * 0.76, 56));
    s += `<rect class="bar" x="${x + (bw - w) / 2}" y="${H - pad.b - h}" width="${w}" height="${h}"><title>${esc(d.label)}: ${fmtNum(d.value)}</title></rect>`;
    if (i % step === 0) s += `<text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${esc(d.label)}</text>`;
  });
  return `<div class="vchart">${s}</svg></div>`;
}
function renderLibStats() {
  const P = state.lib.papers;
  const by = (st) => P.filter((p) => p.status === st).length;
  const cards = [
    ['Total paper', P.length], ['Belum dibaca', by('unread')], ['Sedang dibaca', by('reading')], ['Selesai', by('done')],
    ['Punya PDF', P.filter((p) => p.pdfFile).length], ['Analisis AI tersimpan', P.reduce((s, p) => s + (p.aiNotes?.length || 0), 0)]
  ];
  $('#stat-cards').innerHTML = cards.map(([l, n]) => `<div class="card"><div class="n">${fmtNum(n)}</div><div class="l">${l}</div></div>`).join('');
  const years = P.map((p) => p.year).filter(Boolean);
  let yearData = [];
  if (years.length) {
    const lo = Math.min(...years), hi = Math.max(...years);
    for (let y = lo; y <= hi; y++) yearData.push({ label: String(y), value: years.filter((x) => x === y).length });
  }
  $('#chart-years').innerHTML = vbars(yearData);
  $('#chart-keywords').innerHTML = hbars(countTop(P.flatMap((p) => [...(p.keywords || []), ...(p.tags || [])]), 12));
  $('#chart-authors').innerHTML = hbars(countTop(P.flatMap((p) => p.authors), 10));
  $('#chart-venues').innerHTML = hbars(countTop(P.map((p) => p.venue), 10));
}

$('#trend-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#trend-q').value.trim(); if (!q) return;
  const from = parseInt($('#trend-from').value, 10) || 2000;
  const thisYear = new Date().getFullYear();
  const base = `search=${encodeURIComponent(q)}&filter=from_publication_date:${from}-01-01,to_publication_date:${thisYear}-12-31`;
  const out = $('#trend-result');
  out.innerHTML = '<div class="panel"><span class="spin"></span> Menganalisis literatur…</div>';
  try {
    // Berurutan, agar tidak memicu batas permintaan OpenAlex
    const queries = [
      `/works?${base}&group_by=publication_year`,
      `/works?${base}&group_by=primary_location.source.id`,
      `/works?${base}&group_by=authorships.author.id`,
      `/works?${base}&group_by=authorships.institutions.id`,
      `/works?${base}&sort=cited_by_count:desc&per-page=8&select=${SELECT}`
    ];
    const results = [];
    for (const [i, qy] of queries.entries()) {
      out.innerHTML = `<div class="panel"><span class="spin"></span> Menganalisis literatur… (${i + 1}/${queries.length})</div>`;
      results.push(await oaFetch(qy));
    }
    const [yr, src, au, inst, cited] = results;
    const top = (g, n = 10) => (g.group_by || []).filter((x) => x.key && x.key !== 'unknown').slice(0, n).map((x) => ({ label: x.key_display_name || x.key, value: x.count }));
    const years = (yr.group_by || []).map((x) => ({ label: String(x.key), value: x.count })).filter((d) => +d.label >= from && +d.label <= thisYear).sort((a, b) => +a.label - +b.label);
    const total = yr.meta?.count || years.reduce((s, d) => s + d.value, 0);
    const last = years.slice(-6, -1);
    let growth = '';
    if (last.length >= 2 && last[0].value > 0) {
      const g = ((last[last.length - 1].value - last[0].value) / last[0].value) * 100;
      growth = `Dari ${last[0].label} ke ${last[last.length - 1].label}: ${g >= 0 ? 'naik' : 'turun'} ${Math.abs(g).toFixed(0)}%.`;
    }
    const papers = (cited.results || []).map(normalize);
    state.trendPapers = papers;
    out.innerHTML = `
      <div class="cards"><div class="card"><div class="n">${fmtNum(total)}</div><div class="l">publikasi sejak ${from}</div></div>
      ${years.length ? `<div class="card"><div class="n">${esc(years.reduce((a, b) => (b.value > a.value ? b : a)).label)}</div><div class="l">tahun dengan publikasi terbanyak</div></div>` : ''}
      ${growth ? `<div class="card"><div class="l" style="font-size:14px;color:var(--text)">${growth}</div><div class="l">tahun berjalan tidak dihitung</div></div>` : ''}</div>
      <div class="panel"><h3>Publikasi per tahun — “${esc(q)}”</h3>${vbars(years)}</div>
      <div class="grid2">
        <div class="panel"><h3>Jurnal / sumber paling aktif</h3>${hbars(top(src))}</div>
        <div class="panel"><h3>Penulis paling produktif</h3>${hbars(top(au))}</div>
        <div class="panel"><h3>Institusi paling aktif</h3>${hbars(top(inst))}</div>
        <div class="panel"><h3>Paper paling berpengaruh (paling banyak dikutip)</h3><div class="list" id="trend-papers">${papers.map((p) => paperItemHtml(p, false)).join('')}</div></div>
      </div>`;
    $('#trend-papers').onclick = (ev) => {
      const it = ev.target.closest('.item'); if (!it) return;
      const p = state.trendPapers.find((x) => x.id === it.dataset.id);
      state.search = { params: null, page: 1, results: [p], total: 1, label: 'Dari analisis tren' };
      state.selSearch = p.id; state.dview = { paper: null, stack: [], tab: 'ringkasan' };
      showView('search'); renderSearchResults();
    };
  } catch (err) {
    out.innerHTML = `<div class="panel" style="color:var(--warn)">Analisis gagal: ${esc(err.message)}</div>`;
  }
});

// ================= PENGATURAN =================
function providerName() { return state.settings.provider === 'claude' ? 'Claude' : 'Gemini'; }
function setKeyPill(el, has, hint) { el.textContent = has ? `✓ tersimpan${hint ? ' (' + hint + ')' : ''}` : 'belum diisi'; el.className = 'pill' + (has ? ' oa' : ''); }
function keyPlaceholder(input, has, hint, example) {
  input.placeholder = has ? `Kunci tersimpan${hint ? ' (berakhiran ' + hint.slice(1) + ')' : ''} — isi hanya jika ingin mengganti` : example;
}
async function renderSettings() {
  state.settings = await window.api.getSettings();
  const s = state.settings;
  $('#nav-provider').textContent = providerName();
  $$('input[name=provider]').forEach((r) => { r.checked = r.value === s.provider; });
  setKeyPill($('#gkey-status'), s.hasGeminiKey, s.geminiKeyHint);
  keyPlaceholder($('#set-gkey'), s.hasGeminiKey, s.geminiKeyHint, 'Tempel kunci API dari Google AI Studio');
  $('#set-gmodel').value = s.geminiModel;
  $('#set-gkey').value = '';
  setKeyPill($('#key-status'), s.hasKey, s.keyHint);
  keyPlaceholder($('#set-key'), s.hasKey, s.keyHint, 'sk-ant-…');
  $('#set-model').value = s.model;
  $('#set-mailto').value = s.mailto;
  $('#set-oakey').value = s.oaKey || '';
  $('#data-dir').textContent = s.dataDir;
  $('#set-key').value = '';
}
$('#save-ai').addEventListener('click', async () => {
  const patch = { model: $('#set-model').value };
  const k = $('#set-key').value.trim();
  if (k) patch.apiKey = k;
  await window.api.setSettings(patch); await renderSettings(); toast('Pengaturan AI disimpan.');
});
$('#clear-key').addEventListener('click', async () => {
  if (!confirm('Hapus kunci API yang tersimpan?')) return;
  await window.api.setSettings({ apiKey: '' }); await renderSettings(); toast('Kunci API dihapus.');
});
$('#save-mailto').addEventListener('click', async () => {
  await window.api.setSettings({ mailto: $('#set-mailto').value, oaKey: $('#set-oakey').value }); await renderSettings(); toast('Pengaturan OpenAlex disimpan.');
});
$('#open-data').addEventListener('click', () => window.api.showDataFolder());
$$('input[name=provider]').forEach((r) => r.addEventListener('change', async () => {
  await window.api.setSettings({ provider: r.value }); await renderSettings();
  toast(`Analisis AI sekarang memakai ${providerName()}.`);
}));
$('#save-gemini').addEventListener('click', async () => {
  const patch = { geminiModel: $('#set-gmodel').value };
  const k = $('#set-gkey').value.trim();
  if (k) patch.geminiKey = k;
  await window.api.setSettings(patch); await renderSettings();
  toast(k ? 'Kunci API Gemini disimpan. Kolomnya dikosongkan agar kunci tidak terlihat di layar.' : 'Pengaturan Gemini disimpan.');
});
$('#clear-gkey').addEventListener('click', async () => {
  if (!confirm('Hapus kunci API Gemini yang tersimpan?')) return;
  await window.api.setSettings({ geminiKey: '' }); await renderSettings(); toast('Kunci API Gemini dihapus.');
});
$('#load-gmodels').addEventListener('click', async () => {
  const k = $('#set-gkey').value.trim();
  if (k) { await window.api.setSettings({ geminiKey: k }); await renderSettings(); }
  const btn = $('#load-gmodels'); btn.disabled = true;
  const r = await window.api.geminiModels();
  btn.disabled = false;
  if (!r.ok) { toast(r.error, true); return; }
  $('#gmodel-list').innerHTML = r.models.map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('');
  toast(`${r.models.length} model tersedia. Klik kolom Model untuk memilih.`);
});

// ================= MULAI =================
(async function init() {
  state.lib = await window.api.loadLibrary();
  state.lib.papers = state.lib.papers || [];
  state.settings = await window.api.getSettings();
  $('#nav-provider').textContent = providerName();
  updateCount();
  $('#q').focus();
})();
