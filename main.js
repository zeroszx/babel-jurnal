// Babel — proses utama Electron (sebelumnya bernama JurnalKu)
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const crypto = require('crypto');

// Folder data tetap memakai folder lama (%APPDATA%\JurnalKu) agar perpustakaan tidak "hilang"
// setelah aplikasi berganti nama. Tidak berlaku jika folder data sudah diatur lain (mis. saat pengujian).
{
  const appData = app.getPath('appData');
  const legacy = path.join(appData, 'JurnalKu');
  if (app.getPath('userData') === path.join(appData, app.getName()) && fs.existsSync(legacy)) {
    app.setPath('userData', legacy);
  }
}

const sdk = require('@anthropic-ai/sdk');
const Anthropic = sdk.default || sdk;

const DATA_DIR = () => app.getPath('userData');
const LIB_FILE = () => path.join(DATA_DIR(), 'library.json');
const SETTINGS_FILE = () => path.join(DATA_DIR(), 'settings.json');
const PDF_DIR = () => path.join(DATA_DIR(), 'pdfs');

const DEFAULT_MODEL = 'claude-opus-5-5';

let win;

// ---------- utilitas file ----------
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJsonAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
function safeName(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || crypto.randomUUID();
}
function isPdfBuffer(buf) {
  return buf && buf.length > 4 && buf.subarray(0, 5).toString('latin1').startsWith('%PDF');
}

// ---------- pengaturan ----------
function loadSettings() {
  return readJson(SETTINGS_FILE(), { provider: 'gemini', model: DEFAULT_MODEL, mailto: '', apiKeyEnc: '' });
}
function saveSettings(s) { writeJsonAtomic(SETTINGS_FILE(), s); }
function encryptKey(key) {
  if (!key) return '';
  return (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(key) : Buffer.from(key, 'utf8')).toString('base64');
}
function decryptKey(enc) {
  if (!enc) return '';
  try {
    const buf = Buffer.from(enc, 'base64');
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8');
  } catch { return ''; }
}
function getApiKey() {
  const s = loadSettings();
  return s.apiKeyEnc ? decryptKey(s.apiKeyEnc) : (process.env.ANTHROPIC_API_KEY || '');
}
function getGeminiKey() {
  const s = loadSettings();
  return s.geminiKeyEnc ? decryptKey(s.geminiKeyEnc) : (process.env.GEMINI_API_KEY || '');
}
const DEFAULT_GEMINI_MODEL = 'gemini-flash-latest';
const GEMINI_FALLBACK_MODEL = 'gemini-flash-lite-latest';
const keyHint = (k) => (k && k.length > 8 ? '…' + k.slice(-4) : '');

// ---------- jendela ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 650,
    title: 'Babel',
    backgroundColor: '#0f1413',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      plugins: true // penampil PDF bawaan Chromium
    }
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  // Tautan luar dibuka di browser bawaan, bukan di dalam aplikasi
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) { e.preventDefault(); if (/^https?:\/\//i.test(url)) shell.openExternal(url); }
  });
}

app.whenReady().then(() => {
  fs.mkdirSync(PDF_DIR(), { recursive: true });
  registerIpc();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ---------- IPC ----------
const chats = new Map();   // paperId -> riwayat pesan tanya-jawab
const streams = new Map(); // requestId -> stream aktif

function registerIpc() {
  ipcMain.handle('lib:load', () => readJson(LIB_FILE(), { papers: [] }));
  ipcMain.handle('lib:save', (_e, lib) => { writeJsonAtomic(LIB_FILE(), lib); return true; });

  ipcMain.handle('settings:get', () => {
    const s = loadSettings();
    return {
      provider: s.provider === 'claude' ? 'claude' : 'gemini',
      model: s.model || DEFAULT_MODEL,
      geminiModel: s.geminiModel || DEFAULT_GEMINI_MODEL,
      mailto: s.mailto || '', oaKey: s.oaKey || '',
      hasKey: !!getApiKey(), hasGeminiKey: !!getGeminiKey(),
      keyHint: keyHint(getApiKey()), geminiKeyHint: keyHint(getGeminiKey()),
      dataDir: DATA_DIR()
    };
  });
  ipcMain.handle('settings:set', (_e, patch) => {
    const s = loadSettings();
    if (patch.provider === 'claude' || patch.provider === 'gemini') s.provider = patch.provider;
    if (typeof patch.model === 'string') s.model = patch.model.trim() || DEFAULT_MODEL;
    if (typeof patch.geminiModel === 'string') s.geminiModel = patch.geminiModel.trim() || DEFAULT_GEMINI_MODEL;
    if (typeof patch.mailto === 'string') s.mailto = patch.mailto.trim();
    if (typeof patch.oaKey === 'string') s.oaKey = patch.oaKey.trim();
    if (typeof patch.apiKey === 'string') s.apiKeyEnc = encryptKey(patch.apiKey.trim());
    if (typeof patch.geminiKey === 'string') s.geminiKeyEnc = encryptKey(patch.geminiKey.trim());
    saveSettings(s);
    chats.clear();
    return true;
  });

  // Daftar model Gemini yang tersedia untuk kunci ini
  ipcMain.handle('gemini:models', async () => {
    const key = getGeminiKey();
    if (!key) return { ok: false, error: 'Kunci API Gemini belum diisi.' };
    try {
      const res = await fetch(`${GEMINI_BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(20000) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: geminiErrorText(res.status, j) };
      const models = (j.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent') && /gemini/i.test(m.name))
        .map((m) => ({ id: m.name.replace(/^models\//, ''), label: m.displayName || m.name }));
      return { ok: true, models };
    } catch (err) {
      return { ok: false, error: 'Gagal terhubung: ' + err.message };
    }
  });

  ipcMain.handle('shell:open', (_e, url) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
  ipcMain.handle('shell:showData', () => shell.openPath(DATA_DIR()));

  ipcMain.handle('pdf:url', (_e, fileName) => {
    const p = path.join(PDF_DIR(), path.basename(fileName));
    return fs.existsSync(p) ? pathToFileURL(p).href : null;
  });

  ipcMain.handle('pdf:download', async (_e, { paperId, urls }) => {
    const tried = [];
    for (const url of (urls || []).filter(Boolean)) {
      try {
        const res = await fetch(url, {
          redirect: 'follow',
          headers: { 'User-Agent': 'Babel/0.3 (desktop reference manager)', Accept: 'application/pdf,*/*' },
          signal: AbortSignal.timeout(60000)
        });
        if (!res.ok) { tried.push(`${url} → HTTP ${res.status}`); continue; }
        const buf = Buffer.from(await res.arrayBuffer());
        if (!isPdfBuffer(buf)) { tried.push(`${url} → bukan file PDF (mungkin halaman web/login)`); continue; }
        const fileName = safeName(paperId) + '.pdf';
        fs.writeFileSync(path.join(PDF_DIR(), fileName), buf);
        return { ok: true, fileName };
      } catch (err) {
        tried.push(`${url} → ${err.message}`);
      }
    }
    return { ok: false, error: tried.join('\n') || 'Tidak ada tautan PDF.' };
  });

  // Lampirkan PDF lokal ke paper yang sudah ada
  ipcMain.handle('pdf:attach', async (_e, paperId) => {
    const r = await dialog.showOpenDialog(win, { title: 'Pilih file PDF', filters: [{ name: 'PDF', extensions: ['pdf'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const fileName = safeName(paperId) + '.pdf';
    fs.copyFileSync(r.filePaths[0], path.join(PDF_DIR(), fileName));
    return { fileName };
  });

  // Impor beberapa PDF lokal sebagai entri baru
  ipcMain.handle('pdf:importNew', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Impor PDF', filters: [{ name: 'PDF', extensions: ['pdf'] }], properties: ['openFile', 'multiSelections'] });
    if (r.canceled) return [];
    return r.filePaths.map((src) => {
      const id = 'local-' + crypto.randomUUID();
      const fileName = safeName(id) + '.pdf';
      fs.copyFileSync(src, path.join(PDF_DIR(), fileName));
      return { id, fileName, title: path.basename(src, path.extname(src)) };
    });
  });

  ipcMain.handle('pdf:delete', (_e, fileName) => {
    const p = path.join(PDF_DIR(), path.basename(fileName || ''));
    if (fileName && fs.existsSync(p)) fs.unlinkSync(p);
    return true;
  });

  ipcMain.handle('export:save', async (_e, { content, defaultName, ext }) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: defaultName, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    if (r.canceled || !r.filePath) return false;
    fs.writeFileSync(r.filePath, content, 'utf8');
    return r.filePath;
  });

  ipcMain.handle('ai:cancel', (_e, requestId) => {
    const s = streams.get(requestId);
    if (s) s.abort();
    return true;
  });
  ipcMain.handle('ai:resetChat', (_e, paperId) => { chats.delete(paperId); return true; });
  ipcMain.handle('ai:run', (e, req) => runAi(e.sender, req));
}

// ---------- Analisis AI (Claude) ----------
const SYSTEM_PROMPT = `Kamu adalah asisten riset akademik yang membantu pengguna membaca dan menganalisis paper ilmiah.
Selalu jawab dalam Bahasa Indonesia yang jelas, kecuali pengguna meminta bahasa lain. Istilah teknis boleh tetap dalam bahasa aslinya.
Dasarkan jawaban pada isi paper yang diberikan. Jika sesuatu tidak ada di paper, katakan terus terang dan bedakan dengan jelas antara isi paper dan pengetahuan umummu.
Jika hanya abstrak yang tersedia (bukan teks lengkap), sebutkan bahwa analisis terbatas pada abstrak.
Gunakan format Markdown sederhana: judul kecil (##), poin-poin, dan huruf tebal secukupnya.`;

const MODE_PROMPTS = {
  ringkasan: `Buat ringkasan terstruktur paper ini dengan bagian:
## Inti dalam 3 kalimat
## Pertanyaan / tujuan penelitian
## Metode
## Temuan utama (sertakan angka penting bila ada)
## Kontribusi
## Keterbatasan`,
  metodologi: `Analisis metodologi paper ini secara mendalam: desain penelitian, data/sampel (ukuran, sumber, cara pengambilan), variabel dan pengukuran, teknik analisis, validitas internal & eksternal, reliabilitas, serta apakah metodenya sesuai untuk menjawab pertanyaan penelitian. Akhiri dengan penilaian singkat kekuatan metodologi (kuat/sedang/lemah) dan alasannya.`,
  kritik: `Lakukan telaah kritis (critical appraisal) paper ini seperti reviewer jurnal:
## Kekuatan
## Kelemahan dan ancaman validitas
## Apakah kesimpulan didukung data?
## Pertanyaan yang belum terjawab / arah penelitian lanjutan`,
  literatur: `Siapkan bahan untuk tinjauan pustaka (literature review) dari paper ini:
## Poin kunci yang bisa dikutip (parafrase, dengan nomor halaman bila terlihat)
## Konsep dan definisi penting
## Posisi paper ini dalam bidangnya
## Kata kunci untuk pencarian lanjutan
## Contoh 1 paragraf sintesis yang mengutip paper ini (gaya APA)`
};

function paperContextText(p) {
  const lines = [
    `Judul: ${p.title || '-'}`,
    `Penulis: ${(p.authors || []).join(', ') || '-'}`,
    `Tahun: ${p.year || '-'}`,
    `Sumber/Jurnal: ${p.venue || '-'}`,
    p.doi ? `DOI: ${p.doi}` : '',
    `Abstrak: ${p.abstract || '(tidak tersedia)'}`
  ];
  return lines.filter(Boolean).join('\n');
}

function buildFirstUserContent(paper) {
  const content = [];
  let hasPdf = false;
  if (paper.pdfFile) {
    const p = path.join(PDF_DIR(), path.basename(paper.pdfFile));
    if (fs.existsSync(p)) {
      const size = fs.statSync(p).size;
      if (size < 30 * 1024 * 1024) {
        content.push({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: fs.readFileSync(p).toString('base64') },
          title: paper.title || 'Paper',
          cache_control: { type: 'ephemeral' }
        });
        hasPdf = true;
      }
    }
  }
  content.push({
    type: 'text',
    text: (hasPdf ? 'Berikut teks lengkap paper (PDF) beserta metadatanya.\n\n' : 'Teks lengkap tidak tersedia; hanya metadata dan abstrak berikut.\n\n') + paperContextText(paper)
  });
  return { content, hasPdf };
}

function runAi(sender, req) {
  return loadSettings().provider === 'claude' ? runClaude(sender, req) : runGemini(sender, req);
}

// ---------- Gemini (Google) ----------
const GEMINI_BASE = process.env.JURNALKU_GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta'; // dapat diganti untuk pengujian
const GEMINI_PDF_LIMIT = 14 * 1024 * 1024; // batas permintaan inline 20 MB setelah base64

function geminiErrorText(status, j) {
  const msg = j?.error?.message || '';
  if (status === 400 && /api key/i.test(msg)) return 'Kunci API Gemini tidak valid. Periksa di Pengaturan.';
  if (status === 403) return 'Kunci API Gemini ditolak (403). ' + msg;
  if (status === 429) return 'Kuota gratis Gemini sedang habis (batas per menit atau per hari). Tunggu sebentar lalu coba lagi, atau pilih model Gemini lain di Pengaturan.';
  if (status === 404) return 'Model Gemini tidak ditemukan. Pilih model lain di Pengaturan.';
  if (status >= 500) return `Server Gemini sedang sibuk atau bermasalah (${status}), dan sudah dicoba ulang beberapa kali. Ini masalah di sisi Google, bukan kunci API-mu. Tunggu 1–2 menit lalu coba lagi, atau pilih model lain di Pengaturan.${msg ? '\nPesan dari Google: ' + msg : ''}`;
  return `Galat Gemini (${status}): ${msg}`;
}

function buildGeminiFirstParts(paper) {
  const parts = [];
  let hasPdf = false;
  if (paper.pdfFile) {
    const p = path.join(PDF_DIR(), path.basename(paper.pdfFile));
    if (fs.existsSync(p) && fs.statSync(p).size < GEMINI_PDF_LIMIT) {
      parts.push({ inline_data: { mime_type: 'application/pdf', data: fs.readFileSync(p).toString('base64') } });
      hasPdf = true;
    }
  }
  parts.push({
    text: (hasPdf ? 'Berikut teks lengkap paper (PDF) beserta metadatanya.\n\n' : 'Teks lengkap tidak tersedia; hanya metadata dan abstrak berikut.\n\n') + paperContextText(paper)
  });
  return { parts, hasPdf };
}

async function runGemini(sender, { requestId, paper, mode, question }) {
  const key = getGeminiKey();
  if (!key) return { ok: false, error: 'Kunci API Gemini belum diisi. Buka menu Pengaturan untuk menambahkannya (gratis dari aistudio.google.com).' };
  const model = loadSettings().geminiModel || DEFAULT_GEMINI_MODEL;

  let contents, hasPdf;
  if (mode === 'tanya') {
    let history = chats.get(paper.id);
    if (!history) {
      const first = buildGeminiFirstParts(paper);
      hasPdf = first.hasPdf;
      first.parts.push({ text: question });
      history = [{ role: 'user', parts: first.parts }];
    } else {
      hasPdf = !!paper.pdfFile;
      history.push({ role: 'user', parts: [{ text: question }] });
    }
    chats.set(paper.id, history);
    contents = history;
  } else {
    const first = buildGeminiFirstParts(paper);
    hasPdf = first.hasPdf;
    first.parts.push({ text: MODE_PROMPTS[mode] || MODE_PROMPTS.ringkasan });
    contents = [{ role: 'user', parts: first.parts }];
  }

  const undoQuestion = () => {
    if (mode !== 'tanya') return;
    const h = chats.get(paper.id);
    if (h && h.length && h[h.length - 1].role === 'user') h.pop();
    if (h && h.length === 0) chats.delete(paper.id);
  };

  const controller = new AbortController();
  streams.set(requestId, { abort: () => controller.abort() });
  let text = '';
  let finish = '';
  try {
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents,
      generationConfig: { maxOutputTokens: 16384 }
    });
    const request = (m) => fetch(`${GEMINI_BASE}/models/${encodeURIComponent(m)}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body,
      signal: controller.signal
    });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const busy = (s) => s === 503 || s === 500 || s === 502 || s === 504;

    // Server sibuk (503) sering terjadi di paket gratis: coba ulang, lalu pindah ke model cadangan.
    const plan = [model, model, model];
    if (model !== GEMINI_FALLBACK_MODEL) plan.push(GEMINI_FALLBACK_MODEL);
    let res, usedModel = model, errJson = {};
    for (let i = 0; i < plan.length; i++) {
      usedModel = plan[i];
      if (i > 0 && !sender.isDestroyed()) sender.send('ai:status', { requestId, text: usedModel === model ? `Server Gemini sibuk, mencoba lagi (${i + 1}/3)…` : `Server masih sibuk, beralih ke ${usedModel}…` });
      res = await request(usedModel);
      if (res.ok || !busy(res.status)) break;
      errJson = await res.json().catch(() => ({}));
      if (i < plan.length - 1) await sleep(usedModel === model ? 2500 * (i + 1) : 1000);
    }
    if (!res.ok) {
      undoQuestion();
      // Model cadangan tidak tersedia: laporkan galat asli (server sibuk), bukan "model tidak ditemukan".
      if (usedModel !== model && !busy(res.status)) return { ok: false, error: geminiErrorText(503, errJson) };
      const j = busy(res.status) ? errJson : await res.json().catch(() => ({}));
      return { ok: false, error: geminiErrorText(res.status, j) };
    }
    if (!sender.isDestroyed()) sender.send('ai:status', { requestId, text: '' });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let blocked = '';
    const handleLine = (line) => {
      if (!line.startsWith('data:')) return;
      let j;
      try { j = JSON.parse(line.slice(5).trim()); } catch { return; }
      if (j.promptFeedback?.blockReason) blocked = j.promptFeedback.blockReason;
      const cand = j.candidates?.[0];
      if (!cand) return;
      if (cand.finishReason) finish = cand.finishReason;
      for (const part of cand.content?.parts || []) {
        if (part.thought || typeof part.text !== 'string') continue;
        text += part.text;
        if (!sender.isDestroyed()) sender.send('ai:delta', { requestId, text: part.text });
      }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        handleLine(buf.slice(0, i).replace(/\r$/, ''));
        buf = buf.slice(i + 1);
      }
    }
    if (buf) handleLine(buf);
    streams.delete(requestId);

    if (blocked || (!text && /SAFETY|RECITATION|BLOCKLIST|PROHIBITED/.test(finish))) {
      undoQuestion();
      const why = finish === 'RECITATION'
        ? 'Gemini menghentikan jawaban karena terlalu mirip dengan teks berhak cipta. Coba minta parafrase atau ringkasan, bukan kutipan.'
        : 'Gemini menolak permintaan ini oleh filter keamanannya. Coba ubah pertanyaannya.';
      return { ok: false, error: why };
    }
    if (!text) { undoQuestion(); return { ok: false, error: 'Gemini tidak mengembalikan jawaban. Coba lagi.' }; }
    if (mode === 'tanya') contents.push({ role: 'model', parts: [{ text }] });
    return { ok: true, text, hasPdf, truncated: finish === 'MAX_TOKENS', provider: 'Gemini', model: usedModel, fallback: usedModel !== model };
  } catch (err) {
    streams.delete(requestId);
    undoQuestion();
    if (err.name === 'AbortError') return { ok: false, error: 'Dibatalkan.' };
    return { ok: false, error: 'Gagal terhubung ke Gemini: ' + err.message };
  }
}

// ---------- Claude (Anthropic) ----------
async function runClaude(sender, { requestId, paper, mode, question }) {
  const apiKey = getApiKey();
  if (!apiKey) return { ok: false, error: 'Kunci API Claude belum diisi. Buka menu Pengaturan untuk menambahkannya.' };
  const settings = loadSettings();
  const client = new Anthropic({ apiKey });

  let messages;
  let hasPdf;
  if (mode === 'tanya') {
    let history = chats.get(paper.id);
    if (!history) {
      const first = buildFirstUserContent(paper);
      hasPdf = first.hasPdf;
      first.content.push({ type: 'text', text: question });
      history = [{ role: 'user', content: first.content }];
    } else {
      hasPdf = !!paper.pdfFile;
      history.push({ role: 'user', content: question });
    }
    chats.set(paper.id, history);
    messages = history;
  } else {
    const first = buildFirstUserContent(paper);
    hasPdf = first.hasPdf;
    first.content.push({ type: 'text', text: MODE_PROMPTS[mode] || MODE_PROMPTS.ringkasan });
    messages = [{ role: 'user', content: first.content }];
  }

  try {
    const stream = client.beta.messages.stream({
      model: settings.model || DEFAULT_MODEL,
      max_tokens: 64000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      system: SYSTEM_PROMPT,
      messages
    });
    streams.set(requestId, stream);
    stream.on('text', (delta) => {
      if (!sender.isDestroyed()) sender.send('ai:delta', { requestId, text: delta });
    });
    const msg = await stream.finalMessage();
    streams.delete(requestId);

    if (mode === 'tanya') messages.push({ role: 'assistant', content: msg.content });

    if (msg.stop_reason === 'refusal') {
      if (mode === 'tanya') chats.delete(paper.id);
      return { ok: false, error: 'Permintaan ini ditolak oleh model. Coba ubah pertanyaannya.' };
    }
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return { ok: true, text, hasPdf, truncated: msg.stop_reason === 'max_tokens', provider: 'Claude' };
  } catch (err) {
    streams.delete(requestId);
    if (mode === 'tanya') {
      const h = chats.get(paper.id);
      if (h && h.length && h[h.length - 1].role === 'user') h.pop();
      if (h && h.length === 0) chats.delete(paper.id);
    }
    if (err instanceof Anthropic.APIUserAbortError) return { ok: false, error: 'Dibatalkan.' };
    if (err instanceof Anthropic.AuthenticationError) return { ok: false, error: 'Kunci API tidak valid. Periksa di Pengaturan.' };
    if (err instanceof Anthropic.RateLimitError) return { ok: false, error: 'Batas penggunaan API tercapai. Coba lagi sebentar lagi.' };
    if (err instanceof Anthropic.BadRequestError) return { ok: false, error: 'Permintaan tidak valid: ' + err.message };
    if (err instanceof Anthropic.APIError) return { ok: false, error: `Galat API (${err.status ?? '-'}): ${err.message}` };
    return { ok: false, error: 'Gagal terhubung: ' + err.message };
  }
}
