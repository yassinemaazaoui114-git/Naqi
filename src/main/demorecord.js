import { app, ipcMain, nativeTheme } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

// The demo video's recorder (run with NAQI_SELFTEST=demo, NAQIE_DATA pointing to a folder named naqie-demo outside
// OneDrive (emptied first), NAQIE_SAVE_DIR to the folder saves go into, NAQI_DEMO_DIR to the output folder; GPU +
// internet). It drives the real app through every feature with a moving pointer, like a person would, and records:
// raw.mp4 (the window, 30 frames a second), frames.jsonl (per frame: pointer, dragged files, the sound playing and
// where), marks.json (named moments for the captions), sound/<id>.bin (each played item's cleaned sound). The video
// itself is put together afterwards by demo/compose (captions, pointer, sound).
const FPS = 30
const CLIPS = 'C:\\Users\\Public\\Videos\\Naqi demo clips'
const LINK = 'https://www.youtube.com/watch?v=GlWNuzrqe7U'   // The Royal Society, David Attenborough (CC BY)
const PLAYLIST = 'https://www.youtube.com/watch?v=GlWNuzrqe7U&list=PLSqpxDmgLp4GjV_3D_czZOndQv8LLOAEa'
const BAD_LINK = 'https://www.youtube.com/watch?v=aaaaaaaaaaa'
const AVI = join(CLIPS, 'Places Afar (Wild Shorts).avi')
const TIKAL = join(CLIPS, 'Guatemala - Tikal.mp4')
const LAKES = join(CLIPS, 'Guatemala - Lakes.mkv')
const NARRATION = join(CLIPS, 'Guatemala - Narration.mp3')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

export async function run(win, engine) {
  const out = process.env.NAQI_DEMO_DIR
  const only = process.env.NAQI_DEMO_ONLY || ''
  const page = (js) => win.webContents.executeJavaScript(js)
  const send = (e) => win.webContents.sendInputEvent(e)
  const notes = []
  const t0 = Date.now()
  const note = (text) => { notes.push(`${((Date.now() - t0) / 1000).toFixed(1)} s  ${text}`); console.log('[demo]', text) }

  // ---------- Recording: the newest painted frame is written 30 times a second, so the video keeps wall-clock time ----------
  let latest = null
  let bitmap = null
  let size = null
  let frames = 0
  let start = 0
  let ffmpeg = null
  let where = 'home'
  let media = []
  const cur = { x: 640, y: 420, down: false, drag: null }
  const marks = []
  const mark = (id, data = {}) => { marks.push({ id, f: frames, ...data }); note(`mark ${id}`) }
  const log = []
  const begin = () => {
    const s = latest.getSize()
    size = { width: s.width & ~1, height: s.height & ~1 }   // the encoder needs even sizes
    ffmpeg = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', `${size.width}x${size.height}`,
      '-r', String(FPS), '-i', '-', '-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '17', '-g', String(FPS),
      '-pix_fmt', 'yuv420p', join(out, 'raw.mp4')], { stdio: ['pipe', 'inherit', 'inherit'] })
    start = Date.now()
    note(`recording ${size.width}x${size.height}`)
  }
  const tick = () => {
    if (!latest) return
    if (!ffmpeg) begin()
    const due = Math.floor(((Date.now() - start) / 1000) * FPS)
    while (frames < due) {
      if (!bitmap) {
        const s = latest.getSize()
        const img = Math.abs(s.width - size.width) < 2 && Math.abs(s.height - size.height) < 2
          ? latest.crop({ x: 0, y: 0, ...size }) : latest.resize(size)
        bitmap = img.toBitmap()
      }
      ffmpeg.stdin.write(bitmap)
      log.push(JSON.stringify({ c: [Math.round(cur.x), Math.round(cur.y), cur.down ? 1 : 0], d: cur.drag, m: media, p: where }))
      frames++
    }
  }

  // ---------- What the page plays: every <audio> that was started, sampled all the time ----------
  const sample = async () => {
    try {
      const s = await page('window.__demoState && window.__demoState()')
      if (s) { media = s.m; where = s.p }
    } catch { /* page busy */ }
  }

  // ---------- The pointer: moves like a hand (eased, a slight bow), real mouse events, so hover and press show ----------
  let seed = 7
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
  async function moveTo(x, y, ms) {
    const x0 = cur.x
    const y0 = cur.y
    const dist = Math.hypot(x - x0, y - y0)
    if (dist < 1) return
    ms = ms ?? Math.min(1000, 380 + dist * 0.55)
    const steps = Math.max(2, Math.round(ms / 16))
    const bow = Math.min(36, dist * 0.08) * (rand() < 0.5 ? -1 : 1)
    const nx = -(y - y0) / dist
    const ny = (x - x0) / dist
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      const e = ease(t)
      const arc = Math.sin(Math.PI * e) * bow
      cur.x = x0 + (x - x0) * e + nx * arc
      cur.y = y0 + (y - y0) * e + ny * arc
      send({ type: 'mouseMove', x: Math.round(cur.x), y: Math.round(cur.y) })
      await sleep(16)
    }
  }
  const rect = (sel) => page(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null;
    const r = el.getBoundingClientRect(); return r.width ? [r.left, r.top, r.width, r.height] : null })()`)
  async function point(sel, fx = 0.5, fy = 0.5) {
    const r = await rect(sel)
    if (!r) throw new Error(`not on the page: ${sel}`)
    return [r[0] + r[2] * fx, r[1] + r[3] * fy]
  }
  async function press(x, y) {
    cur.down = true
    send({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    await sleep(90)
    send({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    cur.down = false
  }
  async function click(sel, { fx = 0.5, fy = 0.5, wait = 450, pause = 140 } = {}) {
    const [x, y] = await point(sel, fx, fy)
    await moveTo(x, y)
    await sleep(pause)
    await press(x, y)
    await sleep(wait)
  }
  // A click on something that may already be gone (a list the app emptied by itself)
  async function clickIf(sel, opts) { if (await rect(sel)) await click(sel, opts) }
  async function hover(sel, ms = 900, fx = 0.5, fy = 0.5) {
    if (!(await rect(sel))) { note(`hover skipped, not shown: ${sel}`); return sleep(ms) }
    const [x, y] = await point(sel, fx, fy)
    await moveTo(x, y)
    await sleep(ms)
  }
  // A key (chip shown in the video); text: typed letter by letter
  async function key(keyCode, label, modifiers = []) {
    mark('key', { label })
    send({ type: 'keyDown', keyCode, modifiers })
    if (!modifiers.length && keyCode.length === 1) send({ type: 'char', keyCode })
    await sleep(70)
    send({ type: 'keyUp', keyCode, modifiers })
    await sleep(350)
  }
  async function type(text, ms = 55) {
    for (const ch of text) {
      send({ type: 'keyDown', keyCode: ch })
      send({ type: 'char', keyCode: ch })
      send({ type: 'keyUp', keyCode: ch })
      await sleep(ms + rand() * 40)
    }
  }
  // Files dragged in from outside the window and dropped on the zone (a real drop, through DevTools)
  const dbg = win.webContents.debugger
  async function dragFiles(paths) {
    if (!dbg.isAttached()) dbg.attach('1.3')
    const data = { items: [], files: paths, dragOperationsMask: 1 }
    cur.x = -60
    cur.y = 520
    send({ type: 'mouseMove', x: 0, y: 520 })
    await sleep(300)
    cur.drag = paths.map((p) => basename(p))
    const [x, y] = await point('#zone', 0.5, 0.62)
    let entered = false
    const x0 = cur.x
    const y0 = cur.y
    const steps = 70
    for (let i = 1; i <= steps; i++) {
      const e = ease(i / steps)
      cur.x = x0 + (x - x0) * e
      cur.y = y0 + (y - y0) * e - Math.sin(Math.PI * e) * 40
      if (cur.x >= 0) {
        await dbg.sendCommand('Input.dispatchDragEvent', { type: entered ? 'dragOver' : 'dragEnter', x: Math.round(cur.x), y: Math.round(cur.y), data })
        entered = true
      }
      await sleep(16)
    }
    await sleep(700)
    await dbg.sendCommand('Input.dispatchDragEvent', { type: 'drop', x: Math.round(x), y: Math.round(y), data })
    cur.drag = null
    await sleep(600)
  }

  // ---------- Waiting for the app ----------
  const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(150) } return false }
  const watching = () => page(`!document.querySelector('#watch').hidden`)
  const stats = () => page('window.naqiPlayerStats()')
  const jobs = []
  const saves = []
  engine.on('event', (event, v) => {
    if (event === 'job' && v.state !== 'running') jobs.push(v)
    if (event === 'save' && v.state !== 'running') saves.push(v)
  })
  const jobEnded = (n) => until(async () => jobs.length > n, 600000)
  const playingAt = () => page(`window.naqiPlayerStats().at`)
  const theme = nativeTheme.themeSource
  const historyDirs = () => (existsSync(join(process.env.NAQIE_DATA, 'history')) ? readdirSync(join(process.env.NAQIE_DATA, 'history')) : [])
  // The theme buttons remember the choice in theme.json; put Yassine's own choice back afterwards
  const themeFile = join(app.getPath('userData'), 'theme.json')
  const themeSaved = existsSync(themeFile) ? readFileSync(themeFile) : null
  const files = (list) => { ipcMain.removeHandler('choose-files'); ipcMain.handle('choose-files', () => list) }

  // Each played item's cleaned sound, for the soundtrack (kept once, when it is complete)
  const kept = new Set()
  async function keepSounds() {
    for (const id of new Set(log.flatMap((l) => JSON.parse(l).m.map((m) => m.s)))) {
      if (kept.has(id)) continue
      try {
        const res = await engine.request(`/media/${id}`)
        if (!res.ok) throw new Error(`engine answered ${res.status}`)
        writeFileSync(join(out, 'sound', `${id.replace(/\W+/g, '_')}.bin`), Buffer.from(await res.arrayBuffer()))
        kept.add(id)
      } catch (e) { note(`sound ${id} not saved: ${e.message}`) }
    }
  }

  const recorder = setInterval(tick, 6)
  const sampler = setInterval(sample, 25)
  try {
    const data = process.env.NAQIE_DATA || ''
    if (!/naqie-demo[\\/]?$/.test(data)) throw new Error('NAQIE_DATA must be a folder named naqie-demo (the real history is never used)')
    if (!out || !process.env.NAQIE_SAVE_DIR) throw new Error('NAQI_DEMO_DIR and NAQIE_SAVE_DIR must be set')
    rmSync(data, { recursive: true, force: true })
    rmSync(process.env.NAQIE_SAVE_DIR, { recursive: true, force: true })
    rmSync(out, { recursive: true, force: true })
    mkdirSync(join(out, 'sound'), { recursive: true })
    // Nothing leaves the window: no Explorer, no real clipboard
    ipcMain.removeHandler('show-in-folder')
    ipcMain.handle('show-in-folder', () => '')
    ipcMain.removeHandler('clipboard-text')
    ipcMain.handle('clipboard-text', () => LINK)
    nativeTheme.themeSource = 'dark'
    win.setContentSize(1216, 760)
    win.center()
    win.webContents.setBackgroundThrottling(false)
    await page(`(() => {
      const all = new Set()
      const play = HTMLMediaElement.prototype.play
      HTMLMediaElement.prototype.play = function () { all.add(this); return play.apply(this, arguments) }
      const shown = (s) => !document.querySelector(s).hidden
      window.__demoState = () => ({
        p: shown('#watch') ? 'watch' : shown('#report') ? 'report' : 'home',
        m: [...all].filter((a) => a instanceof HTMLAudioElement && !a.paused && !a.muted && a.readyState >= 3 && !a.seeking)
          .map((a) => ({ s: a.src.replace('naqi-media://engine/', ''), at: +a.currentTime.toFixed(3), v: +a.volume.toFixed(2) }))
      })
    })()`)
    win.webContents.beginFrameSubscription(false, (image) => { latest = image; bitmap = null })
    await sleep(500)
    send({ type: 'mouseMove', x: cur.x, y: cur.y })

    // ===== 0. The engine starts =====
    mark('boot')
    await until(async () => engine.status.status === 'ready' && (await engine.call('/health')).models, 120000)
    await sleep(600)
    mark('ready')
    await hover('#engine', 900)
    await hover('.headline', 700, 0.3)

    if (only === 'smoke') {
      await dragFiles([AVI])
      await sleep(2500)
      throw new Error('smoke run ends here')
    }

    // ===== 1. A link: Clean and play =====
    mark('ch-link')
    await moveTo(640, 360)
    // Ctrl+V outside the link box: the app's own Paste runs (it reads the demo link, never the real clipboard)
    await page('document.activeElement && document.activeElement.blur()')
    await key('V', 'Ctrl + V', ['control'])
    if ((await page(`document.querySelector('#url').value`)) !== LINK) throw new Error('the link was not pasted')
    await sleep(400)
    mark('go-link')
    let n = jobs.length
    await click('#go', { wait: 300 })
    const clickAt = Date.now()
    await sleep(1200)
    mark('ff+', { x: 6 })
    await until(watching, 180000)
    mark('ff-')
    mark('player-open', { s: (Date.now() - clickAt) / 1000 })
    await until(async () => (await stats()).firstPlaying !== null, 60000)
    mark('plays', { s: (Date.now() - clickAt) / 1000 })
    await moveTo(900, 650)
    // the picture is streamed: wait for it (a few seconds at most)
    await until(() => page(`document.querySelector('#screen').dataset.picture === 'shown'`), 30000)
    note(`picture: ${JSON.stringify(await page(`(() => ({ using: window.naqiPlayerStats().using, pic: document.querySelector('#screen').dataset.picture }))()`))}`)
    if (only === 'link') throw new Error('link run ends here')
    await sleep(1500)
    mark('stream')
    await sleep(2500)
    await hover('#timebar', 1200, 0.1)
    mark('lit')
    await sleep(2500)
    await click('#timebar', { fx: 0.02, wait: 2500 })
    mark('jump-in')
    const st = await stats()
    if (st.live) {
      await click('#timebar', { fx: 0.85, wait: 500 })
      mark('jump-edge')
      await sleep(2800)
      await click('#timebar', { fx: 0.04, wait: 800 })
    }
    await moveTo(700, 420)
    await key('Space', 'Space')
    mark('pause')
    await sleep(700)
    await key('Space', 'Space')
    await sleep(1800)

    // ===== 2. Save =====
    const saveOpen = async () => {
      if ((await page(`document.querySelector('#save-toggle').getAttribute('aria-expanded')`)) !== 'true') { await click('#gear-toggle', { wait: 300 }); await click('#save-toggle', { wait: 300 }) }
      await until(async () => !!(await rect('#save-go')), 3000)
      await sleep(300)
    }
    mark('ch-save')
    mark('ff+', { x: 6 })
    await until(async () => jobs.length > n && !(await page(`document.querySelector('#save-toggle').disabled`)), 300000)
    mark('ff-')
    mark('done-link', { x: jobs.at(-1)?.numbers?.speed_x, vram: jobs.at(-1)?.numbers?.peak_vram_mb })
    const linkRow = jobs.at(-1)?.row_id
    await saveOpen()
    await click('#save-fmt [data-value="mp3"]', { wait: 300 })
    await until(async () => !!(await rect('#save-kbps [data-value="192 kbps"]')), 3000)
    await click('#save-kbps [data-value="192 kbps"]', { wait: 200 })
    let s = saves.length
    await click('#save-go', { wait: 100 })
    await until(async () => saves.length > s, 60000)
    mark('saved-mp3')
    await sleep(1400)
    await click('#save-fmt [data-value="mp4"]', { wait: 300 })
    await until(async () => !!(await rect('#save-size [data-value="720p"]')), 3000)
    await click('#save-size [data-value="720p"]', { wait: 200 })
    s = saves.length
    await click('#save-go', { wait: 1000 })
    mark('ff+', { x: 8 })
    await until(async () => saves.length > s, 300000)
    mark('ff-')
    mark('saved-mp4')
    await sleep(1200)
    await hover('#save-show', 700)

    // ===== 3. Report here =====
    mark('ch-report')
    await click('#timebar', { fx: 0.3, wait: 6200 })
    await click('#gear-toggle', { wait: 400 })   // Save and Report here are in the settings menu (T10.5)
    await click('#report-here', { wait: 1200 })
    mark('report-open')
    await click('#strip-play', { wait: 2600 })
    mark('strip')
    await click('#from-here', { wait: 1800 })
    await click('#to-here', { wait: 500 })
    mark('from-to')
    await click('#play-moment', { wait: 1800 })
    await click('#slip-kind [data-value="music"]', { wait: 300 })
    await click('#note', { wait: 200 })
    await type('faint drums', 35)
    await click('#save-slip', { wait: 1500 })
    mark('slip-saved')
    await sleep(900)
    await click('#report-back', { wait: 1000 })
    mark('back-player')
    await sleep(600)
    await click('#watch-back', { wait: 900 })

    // ===== 4. Rate it =====
    mark('ch-rate')
    await click('#job-rate [data-value="perfect"]', { wait: 1000 })
    mark('rated')

    // ===== 5. Own file, an AVI the window cannot show: dropped =====
    mark('ch-drop')
    await clickIf('#url-clear', { wait: 400 })
    await dragFiles([AVI])
    mark('dropped')
    await sleep(600)
    const dirsBefore = historyDirs()
    n = jobs.length
    await click('#go', { wait: 600 })
    mark('ff+', { x: 6 })
    await until(watching, 180000)
    await until(() => page(`document.querySelector('#screen').dataset.picture === 'shown'`), 60000)
    mark('ff-')
    mark('avi-plays')
    await moveTo(950, 640)
    await sleep(4500)

    // ===== 6. Light =====
    mark('ch-theme')
    await click('#theme [data-mode="light"]', { wait: 2200 })
    mark('light')
    await sleep(1500)
    await click('#watch-back', { wait: 1000 })
    mark('ff+', { x: 8 })
    await until(async () => jobs.length > n, 300000)
    mark('ff-')
    const aviName = historyDirs().find((d) => !dirsBefore.includes(d))
    const aviDir = aviName && join(data, 'history', aviName)

    // ===== 7. Several files: Ctrl+O, options, saved into the day folder =====
    mark('ch-files')
    files([TIKAL, LAKES, NARRATION])
    await moveTo(640, 380)
    await page('document.activeElement && document.activeElement.blur()')
    await key('O', 'Ctrl + O', ['control'])
    await sleep(900)
    mark('three-files')
    await click('#files li:nth-child(2) button', { wait: 600 })
    mark('removed-file')
    files([LAKES])
    await click('#add-more', { wait: 800 })
    await click('#opt-toggle', { wait: 700 })
    mark('options')
    await click('#vsize [data-value="720p"]', { wait: 400 })
    await key('Escape', 'Esc')
    n = jobs.length
    await click('#go', { wait: 1000 })
    mark('files-go')
    await hover('#lib li[data-id]', 800)
    mark('ff+', { x: 10 })
    await jobEnded(n)
    mark('ff-')
    await sleep(500)
    mark('files-done')
    await sleep(1200)

    // ===== 8. Mistakes are plain messages; Cancel stops at once =====
    mark('ch-errors')
    await clickIf('#clear-files', { wait: 500 })
    await click('#url', { wait: 200 })
    await type(BAD_LINK, 8)
    n = jobs.length
    await click('#go', { wait: 300 })
    await jobEnded(n)
    mark('bad-link')
    await sleep(2200)
    await clickIf('#url-clear', { wait: 400 })
    files([AVI])
    await click('#choose', { wait: 800 })
    n = jobs.length
    await click('#go', { wait: 1800 })
    mark('cancel')
    await click('#go', { wait: 200 })
    await jobEnded(n)
    mark('cancelled')
    await sleep(1600)
    await clickIf('#clear-files', { wait: 500 })

    // ===== 9. A playlist link =====
    mark('ch-playlist')
    await click('#url', { wait: 200 })
    await type(PLAYLIST, 6)
    await sleep(600)
    await click('#opt-toggle', { wait: 900 })
    mark('playlist-options')
    await hover('#go', 900)
    await clickIf('#url-clear', { wait: 600 })

    // ===== 10. The library =====
    mark('ch-library')
    await click('#theme [data-mode="dark"]', { wait: 1000 })
    await click(`#lib li[data-id="${linkRow}"] .lib-row`, { fx: 0.4, wait: 1000 })
    mark('picked')
    await click(`#lib li[data-id="${linkRow}"] [data-act="play"]`, { wait: 300 })
    mark('replay')
    await until(async () => (await stats()).firstPlaying !== null, 20000)
    await moveTo(880, 640)
    await sleep(3000)
    await key('Escape', 'Esc')
    await sleep(800)
    // its cleaned sound tidied away: it cleans again when played
    const lib = await engine.call('/library')
    await keepSounds()   // before the AVI's cleaned sound is tidied away
    if (aviDir && existsSync(join(aviDir, 'cleaned.wav'))) unlinkSync(join(aviDir, 'cleaned.wav'))
    await page(`window.dispatchEvent(new Event('focus'))`)
    await sleep(500)
    mark('cleans-again')
    await sleep(1000)
    // Remove with Undo
    const tikal = lib.items.find((it) => /Tikal/.test(it.title))
    if (tikal) {
      await click(`#lib li[data-id="${tikal.id}"] .lib-row`, { fx: 0.4, wait: 700 })
      await click(`#lib li[data-id="${tikal.id}"] [data-act="remove"]`, { wait: 900 })
      mark('removed')
      await click('.toast .btn-ghost', { wait: 1000 })
      mark('undo')
    }
    // Bad opens Report a slip with the file filled in
    const lakes = lib.items.find((it) => /Lakes/.test(it.title))
    if (lakes) {
      await click(`#lib li[data-id="${lakes.id}"] .lib-row`, { fx: 0.4, wait: 700 })
      await click(`#lib li[data-id="${lakes.id}"] .rate [data-value="bad"]`, { wait: 1800 })
      mark('bad-opens-report')
      await sleep(1500)
      await click('#report-back', { wait: 1000 })
    }
    mark('end')
    await moveTo(900, 420)
    await sleep(1500)
  } catch (e) {
    note(`stopped: ${e.stack || e.message}`)
  } finally {
    try { win.webContents.endFrameSubscription() } catch { /* not started */ }
    clearInterval(recorder)
    clearInterval(sampler)
    if (ffmpeg) {
      ffmpeg.stdin.end()
      await new Promise((r) => ffmpeg.on('close', r))
    }
    await keepSounds()
    writeFileSync(join(out, 'frames.jsonl'), log.join('\n') + '\n')
    writeFileSync(join(out, 'marks.json'), JSON.stringify({ fps: FPS, size, scale: size ? size.width / 1216 : 1, marks }, null, 1))
    note(`${frames} frames (${(frames / FPS).toFixed(0)} s)`)
    writeFileSync(join(out, 'log.txt'), notes.join('\n') + '\n')
    nativeTheme.themeSource = theme
    if (themeSaved) writeFileSync(themeFile, themeSaved)
    else rmSync(themeFile, { force: true })
    setTimeout(() => app.quit(), 500)
  }
}
