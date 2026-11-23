import { app, ipcMain, nativeTheme } from 'electron'
import { existsSync, mkdirSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Dev check for T4.1 (run with NAQI_SELFTEST=player and NAQIE_DATA pointing to a folder named naqie-t4.1, outside
// OneDrive; it is emptied first; GPU + internet, about 12 min): the player on the real page.
// A. a 19 s YouTube link with "Clean and play": the player opens by itself, its picture is streamed; start delay and
//    sync measured to the end. B. played again from the library (from the cache). C. its cleaned sound tidied away:
//    Play cleans it again first. D. a 9 min 1080p Xvid video (picture converted: first part, then full): a jump
//    past the clean part stops at its edge, playback waits there and goes on by itself, the picture switches to the
//    full copy, sync measured. E. a 5 min H.264 video watched to the end: sync over 5 min (as T1.1 measured).
// Meanwhile the page's frames are timed (the window never freezes). Log and screenshots in test_out/t4.1/.
const outDir = join(app.getAppPath(), 'test_out', 't4.1')
const samples = join(app.getAppPath(), 'samples')
const LINK = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'   // "Me at the zoo", 19 s
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function run(win, engine) {
  mkdirSync(outDir, { recursive: true })
  const log = []
  let fails = 0
  const t0 = Date.now()
  const note = (text) => { log.push(`${((Date.now() - t0) / 1000).toFixed(2)} s  ${text}`); console.log('[playertest]', text) }
  const check = (name, ok, detail = '') => { fails += !ok; note(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`) }
  const page = (js) => win.webContents.executeJavaScript(js)
  const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(200) } return false }
  const stats = () => page('window.naqiPlayerStats()')
  const watching = () => page(`!document.querySelector('#watch').hidden`)
  const shot = async (name) => { await sleep(300); await readGap(); writeFileSync(join(outDir, name), (await win.webContents.capturePage()).toPNG()); await sleep(100); await page('window.__gap = 0') }
  const theme = nativeTheme.themeSource
  let gapMax = 0
  const readGap = async () => { gapMax = Math.max(gapMax, await page('window.__gap')) }
  const jobs = []
  engine.on('event', (event, v) => { if (event === 'job' && v.state !== 'running') jobs.push(v) })
  const lastDone = () => jobs.filter((j) => j.kind === 'play').at(-1)

  // Sync of the frames shown so far (seconds): picture time minus sound time
  const syncSummary = async () => {
    const s = await stats()
    const errs = s.sync.map((x) => Math.abs(x[1])).sort((a, b) => a - b)
    const pct = (q) => (errs.length ? errs[Math.min(errs.length - 1, Math.floor(q * errs.length))] : NaN)
    return { frames: errs.length, median: pct(0.5), p95: pct(0.95), max: errs.at(-1) ?? NaN, from: s.sync[0]?.[0], to: s.sync.at(-1)?.[0] }
  }
  const dump = async (name) => writeFileSync(join(outDir, `${name}.json`), JSON.stringify(await stats()))
  const ms = (x) => `${(x * 1000).toFixed(0)} ms`
  const syncText = (y) => `${y.frames} frames from ${y.from?.toFixed(0)} s to ${y.to?.toFixed(0)} s: median ${ms(y.median)}, 95% ${ms(y.p95)}, max ${ms(y.max)}`
  // A real click on the time bar at fraction f (0..1)
  const clickBar = async (f) => {
    const r = await page(`(() => { const r = document.querySelector('#timebar').getBoundingClientRect(); return [r.left, r.top, r.width, r.height] })()`)
    const x = Math.round(r[0] + f * r[2])
    const y = Math.round(r[1] + r[3] / 2)
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y })
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    await sleep(60)
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    await sleep(200)
  }
  // "Clean and play" from Home; returns the page time of the click
  const cleanAndPlay = async (setup) => {
    await setup()
    await sleep(800)
    return page(`(() => { const t = performance.now(); document.querySelector('#go').click(); return t })()`)
  }
  const startDelay = async (clickAt) => {
    await until(async () => (await stats()).firstPlaying !== null, 240000)
    return ((await stats()).firstPlaying - clickAt) / 1000
  }

  try {
    const data = process.env.NAQIE_DATA || ''
    if (!/naqie-t4\.1[\\/]?$/.test(data)) throw new Error('NAQIE_DATA must be a folder named naqie-t4.1 (the real history is never used)')
    rmSync(data, { recursive: true, force: true })
    check('engine ready with the models', await until(async () => engine.status.status === 'ready' && (await engine.call('/health')).models, 120000), engine.status.gpu?.name)
    await page(`window.__gap = 0; (() => { let last = performance.now(); const f = (t) => { window.__gap = Math.max(window.__gap, t - last); last = t; requestAnimationFrame(f) }; requestAnimationFrame(f) })()`)
    nativeTheme.themeSource = 'dark'

    // A. A 19 s link
    let clickAt = await cleanAndPlay(() => page(`(() => { const u = document.querySelector('#url'); u.value = ${JSON.stringify(LINK)}; u.dispatchEvent(new Event('input')) })()`))
    check('A. the player opens by itself once the first part is clean', await until(watching, 120000))
    let delay = await startDelay(clickAt)
    check('A. link plays', delay > 0, `sound plays ${delay.toFixed(1)} s after the click (download + first part)`)
    const streamed = await until(async () => (await stats()).using === 'stream' && await page(`document.querySelector('#screen').dataset.picture === 'shown'`), 30000)
    check('A. its picture is streamed and shown', streamed, `picture after ${(((await stats()).now - clickAt) / 1000).toFixed(1)} s`)
    await sleep(4000)
    await shot('1-link-dark.png')
    nativeTheme.themeSource = 'light'
    await shot('2-link-light.png')
    await until(async () => page(`window.naqiPlayerStats().at >= 18.5`), 40000)
    let y = await syncSummary()
    await dump('sync-a')
    check('A. picture in sync with the sound (within 0.05 s)', y.frames > 100 && y.max <= 0.05, syncText(y))
    const linkDone = lastDone()
    const linkRow = linkDone?.row_id
    check('A. cleaning done', linkDone?.state === 'done', linkDone && `${linkDone.numbers?.speed_x?.toFixed(1)}x, peak VRAM ${(linkDone.numbers?.peak_vram_mb / 1024).toFixed(2)} GB`)

    // B. Back, then played again from the library (the cache)
    await page(`document.querySelector('#watch-back').click()`)
    await sleep(500)
    check('B. Back returns to Home, the item goes on in the corner (T10.2c)', !(await watching()) && await page(`!document.querySelector('#corner').hidden`))
    await page(`document.querySelector('#corner').hidden || document.querySelector('#corner-close').click()`)   // Stop: closed, so Play opens it anew
    await sleep(500)
    check('B. Stop in the corner stops it', (await stats()).id === null)
    clickAt = await page(`(() => { const t = performance.now(); document.querySelector('#lib li[data-id="${linkRow}"] [data-act="play"]').click(); return t })()`)
    check('B. Play in the library opens it', await until(watching, 5000))
    delay = await startDelay(clickAt)
    const s = await stats()
    check('B. plays from the cache at once, all of it clean', delay < 3 && !s.live, `${delay.toFixed(2)} s`)
    check('B. its picture is shown again', await until(async () => (await stats()).using === 'stream', 20000), `after ${(((await stats()).now - clickAt) / 1000).toFixed(1)} s`)
    await page(`document.querySelector('#watch-back').click()`)
    await page(`document.querySelector('#corner').hidden || document.querySelector('#corner-close').click()`)
    await sleep(500)

    // C. Its cleaned sound tidied away: Play cleans it again first (the kept original is used, nothing downloaded)
    for (const f of readdirSync(join(data, 'history'))) {
      const wav = join(data, 'history', f, 'cleaned.wav')
      if (existsSync(wav)) unlinkSync(wav)
    }
    await page(`window.dispatchEvent(new Event('focus'))`)
    await until(async () => (await page(`document.querySelector('#lib li[data-id="${linkRow}"] .lib-meta').textContent`)).includes('Cleans again'), 5000)
    check('C. the item says it cleans again', true)
    await page(`document.querySelector('#lib li[data-id="${linkRow}"] [data-act="play"]').click()`)
    await sleep(500)
    check('C. Play starts its cleaning on Home', await page(`document.querySelector('#job-title').textContent`) === 'Cleaning your video again…')
    check('C. ... and the player opens by itself', await until(watching, 60000))
    check('C. cleaned again into the same item', await until(async () => lastDone()?.state === 'done' && lastDone()?.row_id === linkRow, 60000))
    await page(`document.querySelector('#watch-back').click()`)

    // D. A 9 min 1080p Xvid video: converted picture (first part, then full), jumps, waiting at the clean edge
    ipcMain.removeHandler('choose-files')
    ipcMain.handle('choose-files', () => [join(samples, 'codecs_long', 'xvid_9min.avi')])
    nativeTheme.themeSource = 'dark'
    clickAt = await cleanAndPlay(() => page(`document.querySelector('#choose').click()`))
    check('D. the player opens by itself', await until(watching, 120000))
    delay = await startDelay(clickAt)
    let st = await stats()
    check('D. 9 min video plays after the first chunk', st.live && st.ready >= 100 && st.ready < 200, `${delay.toFixed(1)} s after the click, clean up to ${st.ready.toFixed(0)} s`)
    check('D. its first-part picture is shown', await until(async () => ['part', 'full'].includes((await stats()).using), 30000), (await stats()).using)
    await sleep(3000)
    await shot('3-long-dark.png')
    await clickBar(0.9)
    st = await stats()
    const j = st.jumps.at(-1)
    check('D. a jump past the clean part stops 3 s before its edge', j && Math.abs(j.to - (st.ready - 3)) < 0.5, j && `asked ${j.asked.toFixed(0)} s, went to ${j.to.toFixed(1)} s (clean up to ${st.ready.toFixed(0)} s)`)
    check('D. ... and says why', (await page(`document.querySelector('#watch-note').textContent`)).includes('lit part'))
    check('D. playback waits at the clean edge', await until(async () => (await stats()).waiting, 15000))
    await shot('4-waiting.png')
    const edge = st.ready
    check('D. ... and goes on by itself when more is clean', await until(async () => (await stats()).at > edge + 2, 120000),
      (await stats()).waits.filter((w) => w.at > edge - 2).map((w) => `waited ${w.s.toFixed(1)} s at ${w.at.toFixed(0)} s`).join(', '))
    check('D. the picture switches to the full copy', await until(async () => (await stats()).using === 'full', 120000))
    await clickBar(0.05)   // inside the clean part
    await sleep(2500)
    const from = (await stats()).sync.length
    await sleep(45000)
    const all = await stats()
    const part = all.sync.slice(from).map((x) => Math.abs(x[1])).sort((a, b) => a - b)
    const q = (v) => part[Math.min(part.length - 1, Math.floor(v * part.length))]
    check('D. picture (converted copy) in sync for 45 s after a jump', part.length > 500 && part.at(-1) <= 0.05,
      `${part.length} frames: median ${ms(q(0.5))}, 95% ${ms(q(0.95))}, max ${ms(part.at(-1))}`)
    check('D. cleaning done', await until(async () => lastDone()?.state === 'done' && lastDone()?.row_id !== linkRow, 120000),
      `${lastDone()?.numbers?.speed_x?.toFixed(1)}x, peak VRAM ${(lastDone()?.numbers?.peak_vram_mb / 1024).toFixed(2)} GB`)
    await page(`document.querySelector('#watch-back').click()`)

    // E. A 5 min H.264 video watched to the end: sync over 5 min
    ipcMain.removeHandler('choose-files')
    ipcMain.handle('choose-files', () => [join(samples, 'sync_test_5min.mp4')])
    clickAt = await cleanAndPlay(() => page(`document.querySelector('#choose').click()`))
    check('E. the player opens by itself', await until(watching, 120000))
    delay = await startDelay(clickAt)
    check('E. 5 min video plays after the first chunk', delay > 0, `${delay.toFixed(1)} s after the click`)
    await until(async () => page(`window.naqiPlayerStats().at >= 308`), 400000)
    y = await syncSummary()
    await dump('sync-e')
    check('E. picture in sync over 5 min (within 0.05 s)', y.frames > 5000 && y.max <= 0.05, syncText(y))
    const done = lastDone()
    note(`E. cleaning ${done?.numbers?.speed_x?.toFixed(1)}x real time, peak VRAM ${(done?.numbers?.peak_vram_mb / 1024).toFixed(2)} GB, waits ${(await stats()).waits.length}`)
    await readGap()
    check('the window never froze (longest frame gap)', gapMax < 1000, `${gapMax.toFixed(0)} ms`)
  } catch (e) {
    check('test ran', false, e.stack || e.message)
  } finally {
    nativeTheme.themeSource = theme
    note(fails ? `${fails} check(s) FAILED` : 'ALL PASSED')
    writeFileSync(join(outDir, 'log.txt'), log.join('\n') + '\n')
    setTimeout(() => app.quit(), 500)
  }
}
