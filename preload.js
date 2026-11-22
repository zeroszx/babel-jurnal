const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadLibrary: () => ipcRenderer.invoke('lib:load'),
  saveLibrary: (lib) => ipcRenderer.invoke('lib:save', lib),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  showDataFolder: () => ipcRenderer.invoke('shell:showData'),
  pdfUrl: (fileName) => ipcRenderer.invoke('pdf:url', fileName),
  downloadPdf: (paperId, urls) => ipcRenderer.invoke('pdf:download', { paperId, urls }),
  attachPdf: (paperId) => ipcRenderer.invoke('pdf:attach', paperId),
  importPdfs: () => ipcRenderer.invoke('pdf:importNew'),
  deletePdf: (fileName) => ipcRenderer.invoke('pdf:delete', fileName),
  saveExport: (content, defaultName, ext) => ipcRenderer.invoke('export:save', { content, defaultName, ext }),
  geminiModels: () => ipcRenderer.invoke('gemini:models'),
  aiRun: (req) => ipcRenderer.invoke('ai:run', req),
  aiCancel: (requestId) => ipcRenderer.invoke('ai:cancel', requestId),
  aiResetChat: (paperId) => ipcRenderer.invoke('ai:resetChat', paperId),
  onAiStatus: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('ai:status', h);
    return () => ipcRenderer.removeListener('ai:status', h);
  },
  onAiDelta: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('ai:delta', h);
    return () => ipcRenderer.removeListener('ai:delta', h);
  }
});
