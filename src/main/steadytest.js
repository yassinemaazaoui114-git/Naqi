import { app, ipcMain } from 'electron'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Dev check for T10.5c (run with NAQI_SELFTEST=steady and NAQIE_DATA pointing to a folder named naqie-t10.5c, outside
// OneDrive; it is emptied first; GPU, about 4 min): Steady volume in the settings menu, by real mouse clicks, on
// samples/steady_3min.mp4 (speech whose level drops 16.5 dB every other 10 s). The page listens before and after the
// chain: on, the loud and quiet parts must come closer, the loud ones stay about as loud, with no clipping;
// off, the sound must be the plain one. The picture's sync is measured while it is on; the choice is remembered (the
// real setting is put back at the end). Log, shots and the loudness rows in test_out/t10.5c/.
const outDir = join(app.getAppPath(), 'test_out', 't10.5c')
const SAMPLE = join(app.getAppPath(), 'samples', 'steady_3min.mp4')
const ON_S = 120
const OFF_S = 20
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN }

export async function run(win, engine) {
  mkdirSync(outDir, { recursive: true })
  const log = []
  let fails = 0
  const t0 = Date.now()
  const note = (text) => { log.push(`${((Date.now() - t0) / 1000).toFixed(2)} s  ${text}`); console.log('[steadytest]', text) }
  const check = (name, ok, detail = '') => { fails += !ok; note(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`) }
  win.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 'warning') note(`page ${e.level}: ${e.message}`) })
  const page = (js) => win.webContents.executeJavaScript(js)
  const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(100) } return false }
  const stats = () => page('window.naqiPlayerStats()')
  const state = () => page('window.naqiSteady()')
  const watching = () => page(`!document.querySelector('#watch').hidden`)
  const shot = async (name) => { await sleep(400); writeFileSync(join(outDir, name), (await win.webContents.capturePage()).toPNG()) }
  const press = async (keyCode, wait = 250) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
    if (keyCode.length === 1) win.webContents.sendInputEvent({ type: 'char', keyCode })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
    await sleep(wait)
  }
  const center = (sel) => page(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] })()`)
  const move = async ([x, y]) => { win.webContents.sendInputEvent({ type: 'mouseMove', x, y }); await sleep(150) }
  const click = async ([x, y], wait = 300) => {
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    await sleep(wait)
  }
  const clickButton = async (sel, wait = 400) => { await move(await center('#screen')); await move(await center(sel)); await click(await center(sel), wait) }
  const clickIn = async (sel, wait = 400) => { await move(await center(sel)); await click(await center(sel), wait) }
  const item = () => page(`(() => { const b = document.querySelector('#gear-steady'); const m = document.querySelector('#gear-menu')
    return { checked: b.getAttribute('aria-checked'), open: m.dataset.open === 'true', panel: m.dataset.panel, focus: document.activeElement.id } })()`)
  const flip = async () => {
    await clickButton('#gear-toggle', 500)
    await clickIn('#gear-steady', 500)
    const s = await item()
    await press('Escape', 300)
    return s
  }
  // Loudness of each 0.34 s window before and after the chain, every 0.35 s while the sound plays
  const meter = () => page(`(() => {
    if (window.__meter) return
    const s = window.naqiSteadyNodes()
    const mk = () => new AnalyserNode(s.ctx, { fftSize: 16384 })
    const pre = mk(), post = mk()
    s.src.connect(pre)
    s.mix.connect(post)
    const buf = new Float32Array(16384)
    const db = (a) => { a.getFloatTimeDomainData(buf); let sum = 0, peak = 0; for (const x of buf) { sum += x * x; peak = Math.max(peak, Math.abs(x)) } return [10 * Math.log10(sum / buf.length + 1e-12), peak] }
    const rows = []
    setInterval(() => {
      const st = window.naqiPlayerStats()
      if (st.paused || st.waiting) return
      const [a, pa] = db(pre), [b, pb] = db(post)
      rows.push([+st.at.toFixed(2), +a.toFixed(2), +b.toFixed(2), +pa.toFixed(3), +pb.toFixed(3)])
    }, 350)
    window.__meter = rows
  })()`)
  const rowsFrom = (n) => page(`window.__meter.slice(${n})`)
  const rowCount = () => page('window.__meter.length')
  const playing = () => page(`document.querySelector('#player-play').getAttribute('aria-pressed') === 'true'`)

  let realSteady = null
  try {
    const data = process.env.NAQIE_DATA || ''
    if (!/naqie-t10\.5c[\\/]?$/.test(data)) throw new Error('NAQIE_DATA must be a folder named naqie-t10.5c (the real history is never used)')
    rmSync(data, { recursive: true, force: true })
    realSteady = (await page('window.naqi.getSettings()')).steady ?? '0'
    await page(`window.naqi.setSettings({ steady: '0' })`)
    check('engine ready with the models', await until(async () => engine.status.status === 'ready' && (await engine.call('/health')).models, 120000), engine.status.gpu?.name)
    ipcMain.removeHandler('choose-files')
    ipcMain.handle('choose-files', () => [SAMPLE])
    await page(`document.querySelector('#choose').click()`)
    await sleep(800)
    await page(`document.querySelector('#go').click()`)
    check('the player opens with the 3 min file', await until(watching, 120000))
    await until(async () => (await stats()).firstPlaying !== null, 60000)
    // Windows pauses the animations of a covered window: in front, like the gear self-test
    win.setAlwaysOnTop(true)
    win.moveTop()
    win.focus()
    await page(`window.naqi.setSettings({ steady: '0' }).then(() => {})`)
    await page(`document.querySelector('#volume').value = 1; document.querySelector('#volume').dispatchEvent(new Event('input'))`)
    let st = await state()
    check('starts off, the sound plain (no Web Audio chain yet)', !st.on && !st.built && st.volume === 1, JSON.stringify(st))

    // The switch, light and dark
    await clickButton('#gear-toggle', 500)
    for (const t of ['light', 'dark']) {
      await page(`document.documentElement.dataset.theme = '${t}'`)
      await shot(`menu-off-${t}.png`)
    }
    await press('Escape', 300)
    let s = await flip()
    st = await state()
    const saved = (await page('window.naqi.getSettings()')).steady
    check('a click turns it on; the menu stays open; remembered', s.checked === 'true' && s.open && s.panel === 'main' && st.on && st.built && st.state === 'running' && saved === '1',
      `${JSON.stringify(s)}, ${JSON.stringify(st)}, saved ${saved}`)
    await clickButton('#gear-toggle', 500)
    for (const t of ['light', 'dark']) {
      await page(`document.documentElement.dataset.theme = '${t}'`)
      await shot(`menu-on-${t}.png`)
    }
    await page(`delete document.documentElement.dataset.theme`)
    await press('Escape', 300)
    check('the sound plays through the chain', await playing() && st.state === 'running', `the chain adds ${(st.lag * 1000).toFixed(1)} ms, the picture waits for it`)

    // On: loud and quiet closer, the level about the same, no clipping; the picture in sync
    await meter()
    await sleep(1500)
    const syncFrom = (await stats()).sync.length
    let n = await rowCount()
    await until(async () => (await rowCount()) - n >= ON_S / 0.35, (ON_S + 60) * 1000)
    const on = (await rowsFrom(n)).filter((r) => r[1] > -55)
    const sync = (await stats()).sync.slice(syncFrom).map((x) => Math.abs(x[1]))
    const mid = median(on.map((r) => r[1]))
    const loud = on.filter((r) => r[1] > mid)
    const quiet = on.filter((r) => r[1] <= mid)
    const gapPlain = median(loud.map((r) => r[1])) - median(quiet.map((r) => r[1]))
    const gapSteady = median(loud.map((r) => r[2])) - median(quiet.map((r) => r[2]))
    const shift = median(loud.map((r) => r[2])) - median(loud.map((r) => r[1]))
    const peak = Math.max(...on.map((r) => r[4]))
    note(`on: ${on.length} windows with sound; plain loud ${median(loud.map((r) => r[1])).toFixed(1)} / quiet ${median(quiet.map((r) => r[1])).toFixed(1)} dB, steady loud ${median(loud.map((r) => r[2])).toFixed(1)} / quiet ${median(quiet.map((r) => r[2])).toFixed(1)} dB; peak plain ${Math.max(...on.map((r) => r[3])).toFixed(3)}, steady ${peak.toFixed(3)}`)
    check('on: the loud and quiet parts are closer', on.length > 200 && gapSteady <= gapPlain - 6, `gap ${gapPlain.toFixed(1)} dB plain -> ${gapSteady.toFixed(1)} dB steady`)
    check('on: the loud parts stay about as loud, no clipping', Math.abs(shift) <= 3 && peak < 1, `loud parts ${shift >= 0 ? '+' : ''}${shift.toFixed(1)} dB, peak ${peak.toFixed(3)}`)
    check('on: the picture in sync within 0.05 s', sync.length > 1000 && Math.max(...sync) < 0.05,
      `${sync.length} frames, median ${(median(sync) * 1000).toFixed(0)} ms, max ${(Math.max(...sync) * 1000).toFixed(0)} ms`)
    writeFileSync(join(outDir, 'loudness-on.json'), JSON.stringify(on))

    // The volume still turns it down after the chain
    await page(`document.querySelector('#volume').value = 0.5; document.querySelector('#volume').dispatchEvent(new Event('input'))`)
    st = await state()
    check('on: the volume is the gain after the chain', st.level === 0.5 && st.volume === 1, JSON.stringify(st))
    await page(`document.querySelector('#volume').value = 1; document.querySelector('#volume').dispatchEvent(new Event('input'))`)

    // Off: the plain sound
    s = await flip()
    await sleep(1500)
    n = await rowCount()
    await until(async () => (await rowCount()) - n >= OFF_S / 0.35, (OFF_S + 30) * 1000)
    const off = (await rowsFrom(n)).filter((r) => r[1] > -55)
    const diff = Math.max(...off.map((r) => Math.abs(r[2] - r[1])))
    const saved2 = (await page('window.naqi.getSettings()')).steady
    check('off: the switch is off and remembered; the sound is the plain one', s.checked === 'false' && !(await state()).on && saved2 === '0' && off.length > 30 && diff < 0.05,
      `${off.length} windows, largest difference ${diff.toFixed(3)} dB`)
    check('off: still playing', await playing())
  } catch (err) {
    check('test ran', false, err.stack || err.message)
  } finally {
    win.setAlwaysOnTop(false)
    if (realSteady !== null) await page(`window.naqi.setSettings({ steady: '${realSteady}' }).then(() => {})`).catch(() => {})
    note(fails ? `${fails} check(s) FAILED` : 'ALL PASSED')
    writeFileSync(join(outDir, 'log.txt'), log.join('\n') + '\n')
    setTimeout(() => app.quit(), 500)
  }
}
