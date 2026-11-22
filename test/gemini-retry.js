// Uji coba-ulang Gemini dengan server tiruan: `npx electron test/gemini-retry.js`
// Skenario: model utama selalu 503, model cadangan menjawab lewat SSE.
const { app, BrowserWindow } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const hits = [];
const server = http.createServer((req, res) => {
  hits.push(req.url);
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.url.includes('gemini-flash-lite-latest')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"candidates":[{"content":{"parts":[{"text":"## Inti\\nPaper ini "}]}}]}\r\n\r\n');
      res.end('data: {"candidates":[{"content":{"parts":[{"text":"membahas stunting."}]},"finishReason":"STOP"}]}\r\n\r\n');
    } else {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 503, message: 'The model is overloaded. Please try again later.' } }));
    }
  });
});

server.listen(0, '127.0.0.1', () => {
  process.env.JURNALKU_GEMINI_BASE = `http://127.0.0.1:${server.address().port}/v1beta`;
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'jurnalku-gem-')));
  require('../main.js');
  app.on('browser-window-created', (_e, win) => {
    win.webContents.once('did-finish-load', async () => {
      const js = (c) => win.webContents.executeJavaScript(c);
      const r = await js(`(async () => {
        const statuses = [];
        window.api.onAiStatus((d) => statuses.push(d.text));
        await window.api.setSettings({ provider: 'gemini', geminiKey: 'kunci-uji-palsu-1234' });
        const s = await window.api.getSettings();
        const r = await window.api.aiRun({ requestId: 'x', mode: 'tanya', question: 'Apa isinya?',
          paper: { id: 'W1', title: 'Uji', authors: [], abstract: 'abstrak' } });
        return { r, statuses, hint: s.geminiKeyHint };
      })()`);
      console.log('RESULT', JSON.stringify(r));
      console.log('HITS', JSON.stringify(hits.map((h) => h.split('/models/')[1])));
      server.close(); app.quit();
    });
  });
});
