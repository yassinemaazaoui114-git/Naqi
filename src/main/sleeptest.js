import { app, ipcMain } from 'electron'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Dev check for T10.5b (run with NAQI_SELFTEST=sleep and NAQIE_DATA pointing to a folder named naqie-t10.5b, outside
// OneDrive; it is emptied first; GPU, about 4 min): the sleep timer in the settings menu, with a "minute" of 1 s, so
// 15 / 30 / 60 min stop after 15 / 30 / 60 s of playing. Each choice by real mouse clicks; the sound must stop at its
// time (measured on the sound's own clock), fade out before it, and not count while paused; 60 runs at 2x (real
// minutes, not the video's); Off stops it; End of video stops at the end. Log and shots in test_out/t10.5b/.
const outDir = join(app.getAppPath(), 'test_out', 't10.5b')
const SAMPLE = join(app.getAppPath(), 'samples', 'sync_test_5min.mp4')
const MINUTE_S = 1
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function run(win, engine) {
  mkdirSync(outDir, { recursive: true })
  const log = []
  let fails = 0
  const t0 = Date.now()
  const note = (text) => { log.push(`${((Date.now() - t0) / 1000).toFixed(2)} s  ${text}`); console.log('[sleeptest]', text) }
  const check = (name, ok, detail = '') => { fails += !ok; note(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`) }
  win.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 'warning') note(`page ${e.level}: ${e.message}`) })
  const page = (js) => win.webContents.executeJavaScript(js)
  const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(100) } return false }
  const stats = () => page('window.naqiPlayerStats()')
  const timer = () => page(`window.naqiSleep()`)
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
  const shown = () => page(`(() => { const c = document.querySelector('#sleep-chip'); const m = document.querySelector('#gear-menu')
    return { chip: !c.hidden && c.getClientRects().length > 0, left: document.querySelector('#sleep-left').textContent,
      value: document.querySelector('#gear-sleep-value').textContent, open: m.dataset.open === 'true', panel: m.dataset.panel,
      corner: !document.querySelector('#corner').hidden, watch: !document.querySelector('#watch').hidden, focus: document.activeElement.id || document.activeElement.textContent.trim().slice(0, 16),
      menu: [Math.round(m.getBoundingClientRect().top), Math.round(m.getBoundingClientRect().bottom)],
      note: document.querySelector('#watch-note').hidden ? '' : document.querySelector('#watch-note').textContent } })()`)
  const choose = async (sel) => {
    await clickButton('#gear-toggle')
    await clickIn(sel)
    // The card grows to the list's height: click only once it has
    const t = Date.now()
    const settled = await until(() => page(`(() => { const m = document.querySelector('#gear-menu'); const p = m.querySelector('.gear-panel[data-name="' + m.dataset.panel + '"]')
      return Math.abs(m.getBoundingClientRect().height - (p.scrollHeight + 2)) < 2 })()`), 3000)
    if (!settled || Date.now() - t > 600) note(`menu took ${Date.now() - t} ms to take its height${settled ? '' : ' (never did)'}`)
    await sleep(200)
  }
  const pickSleep = async (v) => {
    await choose('[data-go="sleep"]')
    const before = await shown()
    const at = await center(`[data-sleep="${v}"]`)
    await clickIn(`[data-sleep="${v}"]`, 700)
    const s = await shown()
    if ((await timer()).mode !== String(v)) { note(`pick ${v} missed: before ${JSON.stringify(before)} click ${at}, after ${JSON.stringify(s)}`); await shot(`missed-${v}.png`) }
    await press('Escape', 300)
    return s
  }
  const pickSpeed = async (r) => {
    await choose('[data-go="speed"]')
    note(`speed list: ${JSON.stringify(await shown())} item at ${await center(`[data-speed="${r}"]`)}`)
    await shot(`speed-list-${r}.png`)
    await clickIn(`[data-speed="${r}"]`, 700)
    if ((await page('window.naqiSpeed()')) !== r) { note(`speed ${r} missed: ${JSON.stringify(await shown())}`); await shot(`missed-${r}x.png`) }
    await press('Escape', 300)
  }
  const playing = () => page(`document.querySelector('#player-play').getAttribute('aria-pressed') === 'true'`)
  const play = async () => { if (!(await playing())) await press('k', 400) }
  // Runs one choice to its end: the sound advances `want` playing seconds times the speed, then pauses
  const runOut = async (v, rate, { pauseMid = false } = {}) => {
    await play()
    const s = await pickSleep(v)
    const a = await stats()
    const t = await timer()
    const want = Number(v) * MINUTE_S
    check(`${v} min: chosen, back to the settings, which count down; the chip shows on the bar`, t.mode === v && s.chip && s.panel === 'main' && /^\d+:\d\d$/.test(s.value) && s.left === s.value,
      `menu ${s.value}, chip ${s.left}, ${t.left.toFixed(2)} s left of ${want}`)
    if (pauseMid) {
      await sleep(4000)
      await press('k', 300)
      const l1 = (await timer()).left
      await sleep(3000)
      const l2 = (await timer()).left
      check(`${v} min: paused, it does not count`, Math.abs(l1 - l2) < 0.05 && !(await playing()), `${l1.toFixed(2)} -> ${l2.toFixed(2)} s left over 3 s paused`)
      await press('k', 300)
    }
    const base = await page(`Number(document.querySelector('#volume').value)`)
    await until(async () => (await timer()).left <= 4, (want + 10) * 1000)
    const mid = await timer()
    check(`${v} min: the sound fades out in its last seconds`, mid.volume < base * 0.65 && mid.volume > 0, `${mid.left.toFixed(1)} s left: volume ${mid.volume.toFixed(2)} of ${base}`)
    if (v === '15') await shot('fading.png')
    const stopped = await until(async () => (await stats()).paused, 12000)
    const b = await stats()
    const after = await timer()
    const s2 = await shown()
    const advanced = (b.at - a.at) / rate
    check(`${v} min: the sound stops at its time`, stopped && Math.abs(advanced - t.left) < 0.5,
      `${(b.at - a.at).toFixed(2)} s of the video at ${rate}x = ${advanced.toFixed(2)} s of playing, timer had ${t.left.toFixed(2)} s`)
    check(`${v} min: then the timer is off, the volume back, the chip gone, a note says why`, after.mode === '0' && Math.abs(after.volume - base) < 0.01 && !s2.chip && s2.value === 'Off' && s2.note.startsWith('Sleep timer'),
      `volume ${after.volume}, note "${s2.note}"`)
  }

  try {
    const data = process.env.NAQIE_DATA || ''
    if (!/naqie-t10\.5b[\\/]?$/.test(data)) throw new Error('NAQIE_DATA must be a folder named naqie-t10.5b (the real history is never used)')
    rmSync(data, { recursive: true, force: true })
    check('engine ready with the models', await until(async () => engine.status.status === 'ready' && (await engine.call('/health')).models, 120000), engine.status.gpu?.name)
    ipcMain.removeHandler('choose-files')
    ipcMain.handle('choose-files', () => [SAMPLE])
    await page(`document.querySelector('#choose').click()`)
    await sleep(800)
    await page(`document.querySelector('#go').click()`)
    check('the player opens with the 5 min file', await until(watching, 120000))
    await until(async () => (await stats()).firstPlaying !== null, 60000)
    // Windows pauses the animations of a covered window (the menu would not grow): in front, like the gear self-test
    win.setAlwaysOnTop(true)
    win.moveTop()
    win.focus()
    await page(`window.naqiSleep(${MINUTE_S})`)
    await sleep(1000)

    // The list, light and dark
    await choose('[data-go="sleep"]')
    let s = await shown()
    check('the settings have Sleep timer: Off; its list opens', s.open && s.panel === 'sleep' && (await timer()).mode === '0')
    for (const t of ['light', 'dark']) {
      await page(`document.documentElement.dataset.theme = '${t}'`)
      await shot(`list-${t}.png`)
    }
    await page(`delete document.documentElement.dataset.theme`)
    await press('Escape', 300)

    // Off stops a running timer
    s = await pickSleep('30')
    await sleep(2000)
    s = await pickSleep('0')
    await sleep(1500)
    check('Off: the timer stops, the chip goes, the sound plays on', (await timer()).mode === '0' && !s.chip && s.value === 'Off' && await playing())

    // Each time; 60 at 2x counts real seconds, not the video's
    await runOut('15', 1, { pauseMid: true })
    await runOut('30', 1)
    await pickSpeed(2)
    await runOut('60', 2)
    await pickSpeed(1)

    // The chip opens its list
    await play()
    await pickSleep('30')
    await shot('chip.png')
    await clickButton('#sleep-chip', 700)
    s = await shown()
    check('a click on the chip opens the sleep list', s.open && s.panel === 'sleep')
    await press('Escape', 300)

    // End of video, once all of it is clean
    check('cleaning done', await until(async () => !(await stats()).live, 240000))
    await pickSleep('0')
    await pickSleep('end')
    s = await shown()
    check('End of video: chosen, the chip says "end"', (await timer()).mode === 'end' && s.chip && s.left === 'end' && s.value === 'end of video', JSON.stringify(s))
    const len = (await stats()).length
    await clickButton('#timebar', 200)   // wakes the bar; then jump near the end by key
    for (let i = 0; i < 60 && (await stats()).at < len - 12; i++) await press('l', 30)
    await play()
    const ended = await until(async () => (await stats()).paused, 30000)
    const e = await stats()
    s = await shown()
    check('End of video: stops at the end, the timer off', ended && e.at >= len - 0.5 && (await timer()).mode === '0' && !s.chip && s.note.includes('ended'),
      `at ${e.at.toFixed(2)} of ${len.toFixed(1)} s, sound ${e.duration}, ended ${e.ended}, readyState ${e.readyState}, timer ${(await timer()).mode}, note "${s.note}"`)
  } catch (err) {
    check('test ran', false, err.stack || err.message)
  } finally {
    win.setAlwaysOnTop(false)
    note(fails ? `${fails} check(s) FAILED` : 'ALL PASSED')
    writeFileSync(join(outDir, 'log.txt'), log.join('\n') + '\n')
    setTimeout(() => app.quit(), 500)
  }
}
