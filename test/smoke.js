// Uji asap: jalankan dengan `npx electron test/smoke.js <folder-output>`
// Memakai folder data sementara agar tidak menyentuh perpustakaan asli.
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const outDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'jurnalku-smoke'));
fs.mkdirSync(outDir, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'jurnalku-data-')));

require('../main.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (e) => {
    const level = e.level ?? e.params?.level;
    if (level === 'error' || level === 3) errors.push(e.message ?? e.params?.message);
  });
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code);
    const shot = async (name) => {
      try { fs.writeFileSync(path.join(outDir, name), (await win.webContents.capturePage()).toPNG()); }
      catch (e) { console.log('SHOT_FAILED', name, e.message); }
    };
    try {
      await wait(800);
      await js(`document.querySelector('#q').value='stunting children Indonesia'; document.querySelector('#search-form').requestSubmit();`);
      for (let i = 0; i < 40 && !(await js(`document.querySelectorAll('#search-results .item').length`)); i++) await wait(500);
      const n = await js(`document.querySelectorAll('#search-results .item').length`);
      console.log('SEARCH_RESULTS', n, await js(`document.querySelector('#search-head').textContent`));
      if (n) {
        await js(`document.querySelector('#search-results .item').click()`);
        await wait(300);
        await shot('1-cari.png');
        await js(`document.querySelector('[data-act=save]')?.click()`);
        await wait(500);
        await js(`document.querySelector('.nav-btn[data-view=library]').click()`);
        await wait(300);
        await js(`document.querySelector('#lib-list .item')?.click()`);
        await wait(300);
        await shot('2-perpustakaan.png');
        console.log('APA', await js(`(()=>{const p=state.lib.papers[0];return toApa(p)})()`));
        console.log('BIB', (await js(`toBibtex(state.lib.papers)`)).split('\n')[0]);
        await js(`openReader(state.lib.papers[0].id,'library')`);
        await wait(8000);
        await js(`document.querySelector('.tab[data-tab=ai]').click()`);
        await shot('3-baca.png');
        console.log('READER_HAS_PDF', await js(`!!document.querySelector('#reader-doc iframe')`));
        await js(`document.querySelector('[data-mode=ringkasan]').click()`);
        await wait(1500);
        console.log('AI_NO_KEY_MSG', await js(`document.querySelector('#ai-out .body')?.textContent`));
        await js(`window.api.setSettings({ geminiKey: 'AIzaKunciPalsuUntukUji' })`);
        await js(`document.querySelector('[data-mode=ringkasan]').click()`);
        for (let i = 0; i < 30 && await js(`!!document.querySelector('#ai-out .spin')`); i++) await wait(500);
        console.log('AI_FAKE_KEY_MSG', await js(`document.querySelector('#ai-out .msg')?.textContent`));
        await js(`window.api.setSettings({ geminiKey: '' })`);
      }
      await js(`document.querySelector('.nav-btn[data-view=analysis]').click(); document.querySelector('#trend-q').value='stunting'; document.querySelector('#trend-form').requestSubmit();`);
      for (let i = 0; i < 40 && !(await js(`!!document.querySelector('#trend-result .vchart, #trend-result .panel[style]')`)); i++) await wait(500);
      await wait(500);
      await shot('4-analisis.png');
      console.log('TREND', await js(`document.querySelector('#trend-result .card')?.textContent`));
      await js(`document.querySelector('.nav-btn[data-view=settings]').click()`);
      await wait(300);
      await shot('5-pengaturan.png');
    } catch (err) {
      console.log('SMOKE_ERROR', err.message);
    }
    console.log('CONSOLE_ERRORS', JSON.stringify(errors));
    app.quit();
  });
});
