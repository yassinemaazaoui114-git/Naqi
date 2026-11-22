// T1.1 player spike, window side (not product code). Run from the project folder:
//   node_modules/.bin/electron spike/t1.1/main.cjs --mode=<element|webaudio|early-element|early-webaudio|plain|mpv>
// Starts spike/t1.1/serve.py (cleans samples/sync_test_5min.mp4 into a growing WAV), opens page.html, which runs
// the test and saves its numbers in test_out/t1.1/<mode>.json. The page asks for things by setting its title:
// "shot:<name>" = screenshot of the window as it is on screen (mpv draws outside Chromium), "quit" = done.
const { app, BrowserWindow } = require('electron')
const { spawn, execFile } = require('node:child_process')
const { randomBytes } = require('node:crypto')
const { join } = require('node:path')

const root = join(__dirname, '..', '..')
const mode = (process.argv.find((a) => a.startsWith('--mode=')) || '--mode=element').slice(7)
const token = randomBytes(16).toString('hex')
let server

function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn('py', ['-3.12', '-u', join(__dirname, 'serve.py')], {
      cwd: __dirname,
      env: { ...process.env, SPIKE_TOKEN: token, SPIKE_SRC: join(root, 'samples', 'sync_test_5min.mp4'),
        SPIKE_NAME: mode, PYTHONIOENCODING: 'utf-8' },
      stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true
    })
    let out = ''
    server.stdout.on('data', (d) => {
      out += d
      const m = out.match(/\{"port": (\d+)\}/)
      if (m) resolve(Number(m[1]))
    })
    server.on('exit', (code) => reject(new Error('server stopped ' + code)))
  })
}

// Screenshot of the screen area of the window (what the user really sees, mpv included).
function shot(win, name) {
  const b = win.getBounds()
  const file = join(root, 'test_out', 't1.1', name + '.png')
  const ps = `Add-Type -AssemblyName System.Drawing; $b=New-Object Drawing.Bitmap ${b.width},${b.height};` +
    `$g=[Drawing.Graphics]::FromImage($b); $g.CopyFromScreen(${b.x},${b.y},0,0,$b.Size); $b.Save('${file}')`
  execFile('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true }, (e) => console.log('[spike] shot', name, e ? e.message : 'ok'))
}

app.whenReady().then(async () => {
  const port = await startServer()
  const win = new BrowserWindow({
    width: 1280, height: 800, x: 40, y: 40, backgroundColor: '#111',
    webPreferences: { autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false }
  })
  win.setAlwaysOnTop(true)   // keeps the window in view for the screenshots
  const hwnd = win.getNativeWindowHandle().readBigUInt64LE(0).toString()
  win.webContents.on('console-message', (e) => console.log('[page]', e.message))
  win.on('page-title-updated', (e, title) => {
    if (title.startsWith('shot:')) shot(win, title.slice(5))
    if (title === 'quit') app.quit()
  })
  win.loadFile(join(__dirname, 'page.html'), { query: { port: String(port), t: token, mode, hwnd } })
})

app.on('will-quit', () => { if (server) server.kill() })
