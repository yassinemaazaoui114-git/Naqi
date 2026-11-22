import { contextBridge, ipcRenderer, webUtils } from 'electron'

// The page has no Node access; it only gets these few named calls.
contextBridge.exposeInMainWorld('naqi', {
  systemInfo: () => ipcRenderer.invoke('system-info'),
  engineStatus: () => ipcRenderer.invoke('engine-status'),
  restartEngine: () => ipcRenderer.invoke('engine-restart'),
  onEngineStatus: (fn) => ipcRenderer.on('engine-status', (_event, status) => fn(status)),
  // Theme: 'system' | 'light' | 'dark' (remembered by the main process)
  getTheme: () => ipcRenderer.invoke('theme-get'),
  setTheme: (mode) => ipcRenderer.invoke('theme-set', mode),
  // Cleaning jobs (engine/jobs.py): spec = { kind: 'play', source } or { kind: 'play', row } (clean again), { kind: 'sound', src, wav }, { kind: 'file', src, dst, kbps, height },
  // { kind: 'files', files, out, fmt, height, kbps } or { kind: 'link', url, out, fmt, quality, playlist }
  startJob: (spec) => ipcRenderer.invoke('job-start', spec),
  cancelJob: (id) => ipcRenderer.invoke('job-cancel', id),
  onJob: (fn) => ipcRenderer.on('engine-job', (_event, job) => fn(job)),
  // A video's picture for the player (engine/picture.py): spec = { src, folder, how? ('convert' to force a copy) }
  startPicture: (spec) => ipcRenderer.invoke('picture-start', spec),
  cancelPicture: (id) => ipcRenderer.invoke('picture-cancel', id),
  onPicture: (fn) => ipcRenderer.on('engine-picture', (_event, item) => fn(item)),
  // Player (engine/player.py): open a library item -> { id, title, from, added, kind, rating, live, length, picture },
  // picture = { type: 'none' } | { type: 'file', item: picture item } | { type: 'stream', state, at, text };
  // action 'convert' (the picture did not play as it is) or 'stream' (the stream was refused: look it up again).
  // Its media are at naqi-media://engine/<id>/sound, /pictures/<picture id>/part|full, /stream/<id>
  openPlayer: (id, action) => ipcRenderer.invoke('player-open', id, action),
  onStream: (fn) => ipcRenderer.on('engine-stream', (_event, s) => fn(s)),
  // Save (engine/saves.py): a played item as MP3 / MP4 into the Save to day folder; spec = { fmt: 'mp3' | 'mp4',
  // size: 'Original' | '1080p' | '720p' | '480p', kbps: 128 | 192 | 320 } -> the save { id, row_id, state, frac, text, path }
  startSave: (id, spec) => ipcRenderer.invoke('save-start', id, spec),
  cancelSave: (id) => ipcRenderer.invoke('save-cancel', id),
  onSave: (fn) => ipcRenderer.on('engine-save', (_event, s) => fn(s)),
  // Library (engine/library.py): -> { items: [{ id, title, added, from, kind, format, state, show, rating }] }, newest first;
  // state = 'ready' | 'cleaning' | 'again' (cleaned again on Play) | 'gone'. Remove keeps saved and own files.
  library: () => ipcRenderer.invoke('library'),
  removeFromLibrary: (id) => ipcRenderer.invoke('library-remove', id),
  rate: (id, rating) => ipcRenderer.invoke('library-rate', id, rating),   // 'bad' | 'good' | 'perfect' -> the item
  // Report a slip (engine/cases.py): the number saved; what a report is about ({ row } or { path } ->
  // { source, row, title, hint }); save one ({ source, start, end, expect, note, row } -> { count })
  slipCount: () => ipcRenderer.invoke('cases-count'),
  slipSource: (what) => ipcRenderer.invoke('cases-source', what),
  saveSlip: (spec) => ipcRenderer.invoke('cases-save', spec),
  // The sound strip: the shape of a library item's cleaned sound -> { length, peaks: [0..1] } (it plays from
  // naqi-media://engine/<id>/sound); throws the page's words when Naqi has no cleaned sound of it
  slipWave: (id) => ipcRenderer.invoke('cases-wave', id),
  chooseFile: () => ipcRenderer.invoke('choose-file'),             // one file -> [path] or []
  // Home page helpers
  fileKinds: (paths) => ipcRenderer.invoke('file-kinds', paths),   // -> { kinds: { path: 'audio' | 'video' } }
  pathForFile: (file) => webUtils.getPathForFile(file),             // a dropped File -> its path on disk
  getSettings: () => ipcRenderer.invoke('settings-get'),
  setSettings: (patch) => ipcRenderer.invoke('settings-set', patch),
  chooseFiles: () => ipcRenderer.invoke('choose-files'),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),         // -> new settings, or null
  clipboardText: () => ipcRenderer.invoke('clipboard-text'),
  showInFolder: (path) => ipcRenderer.invoke('show-in-folder', path)
})
