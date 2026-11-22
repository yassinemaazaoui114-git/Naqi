// T1.2 codec probe (spike, not product code). Run from the project folder:
//   node_modules/.bin/electron spike/t1.2/probe.cjs [folder]
// Tries every video in [folder] (default samples/codecs) in a muted <video>, like the player's picture: loads it,
// plays 2 s, jumps to 20 s, and checks the frames are real pictures. Results: test_out/t1.2/<folder name>.json
const { app, BrowserWindow } = require('electron')
const { readdirSync, mkdirSync, writeFileSync, statSync, createReadStream } = require('node:fs')
const http = require('node:http')
const { join, basename, resolve } = require('node:path')

const root = join(__dirname, '..', '..')
const dir = resolve(root, process.argv.slice(2).find((a) => !a.startsWith('-') && !a.endsWith('.cjs')) || 'samples/codecs')
const files = readdirSync(dir).filter((f) => /\.(mp4|mkv|webm|mov|avi|wmv|m4v)$/i.test(f)).sort()

const pageJs = `
async function tryFile(url) {
  const v = document.createElement('video'); v.muted = true; v.width = 320; document.body.append(v)
  const r = { load: false, frames: 0, seek: false, picture: false, error: null }
  const wait = (ev, ms) => new Promise((ok) => { const t = setTimeout(() => ok(false), ms)
    v.addEventListener(ev, () => { clearTimeout(t); ok(true) }, { once: true })
    v.addEventListener('error', () => { clearTimeout(t); ok(false) }, { once: true }) })
  const t0 = performance.now()
  v.src = url
  r.load = await wait('loadeddata', 8000)
  r.load_ms = Math.round(performance.now() - t0)
  if (r.load) {
    r.size = v.videoWidth + 'x' + v.videoHeight
    let n = 0; const count = () => { n++; v.requestVideoFrameCallback(count) }; v.requestVideoFrameCallback(count)
    try { await v.play() } catch (e) { r.error = 'play: ' + e.message }
    await new Promise((ok) => setTimeout(ok, 2000))
    r.frames = n
    r.played_s = +v.currentTime.toFixed(2)
    r.decoded = v.getVideoPlaybackQuality().totalVideoFrames
    v.currentTime = 20; r.seek = await wait('seeked', 5000)
    await new Promise((ok) => setTimeout(ok, 300))
    const c = document.createElement('canvas'); c.width = 64; c.height = 36
    const g = c.getContext('2d'); g.drawImage(v, 0, 0, 64, 36)
    const px = g.getImageData(0, 0, 64, 36).data; let sum = 0, sq = 0
    for (let i = 0; i < px.length; i += 4) { const y = (px[i] + px[i + 1] + px[i + 2]) / 3; sum += y; sq += y * y }
    const m = sum / (px.length / 4); r.mean = Math.round(m); r.spread = Math.round(Math.sqrt(sq / (px.length / 4) - m * m))
    r.picture = r.spread > 5   // a real picture, not a blank / black / green frame
    r.dropped = v.getVideoPlaybackQuality().droppedVideoFrames
  }
  if (v.error) r.error = 'media error ' + v.error.code + ': ' + v.error.message
  r.plays = r.load && r.frames >= 30 && r.seek && r.picture
  v.remove()
  return r
}
`

// The files are read over a local web server with Range support (how the player gets its picture too).
function serve() {
  return new Promise((ok) => {
    const srv = http.createServer((req, res) => {
      if (req.url === '/') return res.end('<body></body>')
      const file = join(dir, decodeURIComponent(req.url.slice(1)))
      const size = statSync(file).size
      const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '')
      const a = m && m[1] ? Number(m[1]) : 0, b = m && m[2] ? Number(m[2]) : size - 1
      res.writeHead(m ? 206 : 200, { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes',
        'Content-Length': b - a + 1, ...(m ? { 'Content-Range': `bytes ${a}-${b}/${size}` } : {}) })
      createReadStream(file, { start: a, end: b }).pipe(res).on('error', () => {})
    }).listen(0, '127.0.0.1', () => ok(srv.address().port))
  })
}

app.whenReady().then(async () => {
  const port = await serve()
  const win = new BrowserWindow({ width: 400, height: 300, x: 20, y: 20, webPreferences: { backgroundThrottling: false } })
  await win.loadURL(`http://127.0.0.1:${port}/`)
  await win.webContents.executeJavaScript(pageJs)
  const results = {}
  // One untimed play first: the window's first video pays for starting the media pipeline
  await win.webContents.executeJavaScript(`tryFile(${JSON.stringify(`http://127.0.0.1:${port}/${encodeURIComponent(files[0])}`)})`)
  for (const f of files) {
    const r = await win.webContents.executeJavaScript(`tryFile(${JSON.stringify(`http://127.0.0.1:${port}/${encodeURIComponent(f)}`)})`)
    results[f] = r
    console.log(`${r.plays ? 'PLAYS ' : 'FAILS '} ${f.padEnd(22)} load=${r.load} frames=${r.frames} seek=${r.seek} picture=${r.picture}${r.error ? ' ' + r.error : ''}`)
  }
  mkdirSync(join(root, 'test_out', 't1.2'), { recursive: true })
  writeFileSync(join(root, 'test_out', 't1.2', basename(dir) + '.json'), JSON.stringify({ electron: process.versions.electron, chrome: process.versions.chrome, results }, null, 1))
  app.quit()
})
