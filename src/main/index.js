import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, protocol, shell } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { details, remember } from './details'
import { Engine } from './engine'

// Installed (T7.1): the engine is packed into resources\engine\NaqiEngine.exe; in dev it is engine\server.py
const engine = app.isPackaged
  ? new Engine(join(process.resourcesPath, 'engine'), join(process.resourcesPath, 'engine', 'NaqiEngine.exe'))
  : new Engine(join(app.getAppPath(), 'engine'))

// The demo recorder (NAQI_SELFTEST=demo) needs every frame painted, even while the window is covered
if (process.env.NAQI_SELFTEST === 'demo') {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  app.commandLine.appendSwitch('disable-background-timer-throttling')
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
}

// The player's <audio> and <video> read the engine's media through naqi-media://engine/<path>: the main process
// adds the token, so the page never holds it. stream: true lets the media elements read it piece by piece.
protocol.registerSchemesAsPrivileged([
  { scheme: 'naqi-media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }
])

// The theme button's choice (system / light / dark), kept in Electron's user-data folder. Setting
// nativeTheme.themeSource flips the page's prefers-color-scheme and the Windows title bar together.
const THEMES = ['system', 'light', 'dark']
const themeFile = () => join(app.getPath('userData'), 'theme.json')
function loadTheme() {
  try {
    const mode = JSON.parse(readFileSync(themeFile(), 'utf8')).mode
    if (THEMES.includes(mode)) nativeTheme.themeSource = mode
  } catch { /* first start: follow Windows */ }
}
function setTheme(mode) {
  if (!THEMES.includes(mode)) return nativeTheme.themeSource
  nativeTheme.themeSource = mode
  try { writeFileSync(themeFile(), JSON.stringify({ mode })) } catch { /* not remembered, still applied */ }
  return mode
}

// The Home page's choices (format, quality, sizes, save folder, last files folder), kept like the theme.
// Saved files go into a folder per day inside `folder` (old Naqi SPEC R10); default Videos\Naqi.
// clip_asked: the copied links Home already offered to clean (T10.4, a JSON list), so each is asked once.
const settingsFile = () => join(app.getPath('userData'), 'settings.json')
const SETTINGS = ['folder', 'format', 'mp3_quality', 'mp4_quality', 'files_format', 'files_size', 'files_folder', 'volume', 'theater', 'clip_asked']
function readSaved() {
  try { return JSON.parse(readFileSync(settingsFile(), 'utf8')) } catch { return {} /* first start */ }
}
function loadSettings() {
  const settings = { folder: join(app.getPath('videos'), 'Naqi Downloads'), ...readSaved() }
  // The Home self-test saves into its own folder; never written to settings.json, so it cannot stick
  if (process.env.NAQIE_SAVE_DIR) settings.folder = process.env.NAQIE_SAVE_DIR
  return settings
}
function saveSettings(patch) {
  const next = readSaved()
  for (const key of SETTINGS) if (typeof patch?.[key] === 'string') next[key] = patch[key]
  if (!process.env.NAQIE_SAVE_DIR) {
    try { writeFileSync(settingsFile(), JSON.stringify(next, null, 2)) } catch { /* not remembered, still used */ }
  }
  return loadSettings()
}

const MEDIA = ['mp3', 'm4a', 'wav', 'flac', 'ogg', 'opus', 'aac', 'wma', 'mp4', 'mkv', 'webm', 'mov', 'avi', 'wmv', 'm4v']

// several: Home's file list; one: "Report a slip" (the file where the slip was heard)
async function chooseFiles(win, several = true) {
  const { filePaths } = await dialog.showOpenDialog(win, {
    title: several ? 'Choose audio or video files' : 'The file where you heard the slip',
    defaultPath: loadSettings().files_folder || undefined,
    properties: several ? ['openFile', 'multiSelections'] : ['openFile'],
    filters: [{ name: 'Audio or video', extensions: MEDIA }, { name: 'All files', extensions: ['*'] }]
  })
  if (filePaths.length) saveSettings({ files_folder: dirname(filePaths[0]) })
  return filePaths
}

async function chooseFolder(win) {
  const { filePaths } = await dialog.showOpenDialog(win, {
    title: 'Save to', defaultPath: loadSettings().folder, properties: ['openDirectory', 'createDirectory']
  })
  return filePaths[0] ? saveSettings({ folder: filePaths[0] }) : null
}

// Show a saved file in Explorer; its folder when the file is gone (or the folder itself for a folder path).
function showInFolder(path) {
  const p = normalize(String(path || ''))
  if (p && existsSync(p) && !p.endsWith('\\')) return shell.showItemInFolder(p)
  const folder = p && existsSync(dirname(p)) ? dirname(p) : loadSettings().folder
  mkdirSync(folder, { recursive: true })
  return shell.openPath(folder)
}

// Run a command and return its first output line, or null when it is missing.
function firstLine(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return resolve(null)
      const text = (stdout || stderr || '').trim()
      resolve(text.split(/\r?\n/)[0] || null)
    })
  })
}

async function systemInfo() {
  const [python, ffmpeg, gpu] = await Promise.all([
    app.isPackaged ? null : firstLine('py', ['-3.12', '--version']),
    firstLine(app.isPackaged ? join(process.resourcesPath, 'engine', '_internal', 'bin', 'ffmpeg.exe') : 'ffmpeg', ['-version']),
    firstLine('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader'])
  ])
  return {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    python: python ? python.replace(/^Python\s+/, '') : null,
    ffmpeg: ffmpeg ? ffmpeg.split(' ')[2] : null,
    gpu
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    title: 'Naqi | نقي',
    icon: join(app.getAppPath(), 'build', 'icon.ico'),
    show: false,
    // Match the Windows theme before the page paints, so there is no white flash in dark mode.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0f1e' : '#eef3fa',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  win.once('ready-to-show', () => win.show())
  const send = (status) => win.webContents.send('engine-status', status)
  const sendJob = (event, value) => {
    if (event === 'job') win.webContents.send('engine-job', value)
    if (event === 'picture') win.webContents.send('engine-picture', value)
    if (event === 'stream') win.webContents.send('engine-stream', value)
    if (event === 'save') win.webContents.send('engine-save', value)
  }
  engine.on('status', send)
  engine.on('event', sendJob)
  win.on('closed', () => { engine.off('status', send); engine.off('event', sendJob) })

  // NAQI_PAGE=kitchen opens the design sheet directly
  const page = process.env.NAQI_PAGE === 'kitchen' ? 'kitchen.html' : 'index.html'
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/${page}`)
  else win.loadFile(join(__dirname, '../renderer', page))
  return win
}

app.whenReady().then(async () => {
  loadTheme()
  ipcMain.handle('theme-get', () => nativeTheme.themeSource)
  ipcMain.handle('theme-set', (_event, mode) => setTheme(mode))
  const info = systemInfo()
  ipcMain.handle('system-info', () => info)
  ipcMain.handle('engine-status', () => engine.status)
  ipcMain.handle('engine-restart', () => engine.restart())
  ipcMain.handle('job-start', (_event, spec) => engine.call('/jobs', spec))
  ipcMain.handle('job-cancel', (_event, id) => engine.call(`/jobs/${Number(id)}/cancel`, {}))
  ipcMain.handle('picture-start', (_event, spec) => engine.call('/pictures', spec))
  ipcMain.handle('picture-cancel', (_event, id) => engine.call(`/pictures/${Number(id)}/cancel`, {}))
  ipcMain.handle('player-open', (_event, id, action) =>
    engine.call(`/player/${Number(id)}${['convert', 'stream'].includes(action) ? '/' + action : ''}`, {}))
  protocol.handle('naqi-media', (request) => engine.media(request))
  ipcMain.handle('library', () => engine.call('/library'))
  ipcMain.handle('library-remove', (_event, id) => engine.call(`/library/${Number(id)}/remove`, {}))
  // Save goes into the same "Save to" folder as Home's saves (a day folder is made inside it)
  ipcMain.handle('save-start', (_event, id, spec) =>
    engine.call(`/library/${Number(id)}/save`, { ...spec, out: loadSettings().folder }))
  ipcMain.handle('save-cancel', (_event, id) => engine.call(`/saves/${Number(id)}/cancel`, {}))
  ipcMain.handle('library-rate', (_event, id, rating) => engine.call(`/library/${Number(id)}/rate`, { rating }))
  ipcMain.handle('cases-count', () => engine.call('/cases'))
  ipcMain.handle('cases-source', (_event, what) => engine.call('/cases/source', what))
  ipcMain.handle('cases-save', (_event, spec) => engine.call('/cases', spec))
  ipcMain.handle('cases-wave', (_event, id) => engine.call(`/library/${Number(id)}/wave`))
  ipcMain.handle('player-muted', (_event, id) => engine.call(`/library/${Number(id)}/muted`))
  ipcMain.handle('choose-file', (event) => chooseFiles(BrowserWindow.fromWebContents(event.sender), false))
  ipcMain.handle('file-kinds', (_event, paths) => engine.call('/kinds', { paths }))
  ipcMain.handle('settings-get', () => loadSettings())
  ipcMain.handle('settings-set', (_event, patch) => saveSettings(patch))
  ipcMain.handle('choose-files', (event) => chooseFiles(BrowserWindow.fromWebContents(event.sender)))
  ipcMain.handle('choose-folder', (event) => chooseFolder(BrowserWindow.fromWebContents(event.sender)))
  ipcMain.handle('clipboard-text', () => clipboard.readText())
  ipcMain.handle('clipboard-offer', () => (!process.env.NAQI_SELFTEST || process.env.NAQI_SELFTEST === 'clip' ? clipboard.readText() : ''))
  ipcMain.handle('show-in-folder', (_event, path) => showInFolder(path))
  ipcMain.handle('error-details', (_event, what) => details(engine, info, what || {}))
  engine.on('status', (s) => console.log('[naqi] engine:', s.status, s.gpu?.name || '', s.message || ''))
  engine.on('status', (s) => { if (s.status === 'ready') remember(engine) })   // its versions, for Copy details
  engine.start()
  const win = createWindow()
  console.log('[naqi] system info:', await info)
  const tests = { home: () => import('./hometest'), library: () => import('./librarytest'), player: () => import('./playertest'),
    report: () => import('./reporttest'), save: () => import('./savetest'), polish: () => import('./polishtest'),
    speed: () => import('./speedtest'), installed: () => import('./installtest'), demo: () => import('./demorecord'),
    keys: () => import('./keystest'), full: () => import('./fulltest'), mutes: () => import('./mutestest'),
    corner: () => import('./cornertest'), details: () => import('./detailstest'), clip: () => import('./cliptest'),
    gear: () => import('./geartest') }
  if (tests[process.env.NAQI_SELFTEST]) {
    const which = tests[process.env.NAQI_SELFTEST]()
    const test = async () => (await which).run(win, engine)
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', test)
    else test()
  } else if (process.env.NAQI_SELFTEST) (await import('./selftest')).run(win, engine)
})

app.on('window-all-closed', () => app.quit())

// Stop the engine before the app ends, so no python.exe is left behind.
let stopped = false
app.on('before-quit', (event) => {
  if (stopped) return
  event.preventDefault()
  engine.stop().then(() => { stopped = true; app.quit() })
})
