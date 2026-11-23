import { app, ipcMain } from 'electron'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Dev check for T10.5 (run with NAQI_SELFTEST=gear and NAQIE_DATA pointing to a folder named naqie-t10.5, outside
// OneDrive; it is emptied first; GPU, about 15 min): the settings menu on the player bar with real mouse and key
// events, in the normal player, theater mode, fullscreen and the corner; each speed plays at its rate; then the whole
// 5 min file at 2x and at 0.5x with its picture/sound sync measured (NAQI_QUICK=1: 60 s of the file each).
// Light / dark / small window shots. Log, shots and sync data in test_out/t10.5/.
const outDir = join(app.getAppPath(), 'test_out', 't10.5')
const SAMPLE = join(app.getAppPath(), 'samples', 'sync_test_5min.mp4')
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function run(win, engine) {
  mkdirSync(outDir, { recursive: true })
  const log = []
  let fails = 0
  let theater0 = null
  const t0 = Date.now()
  const note = (text) => { log.push(`${((Date.now() - t0) / 1000).toFixed(2)} s  ${text}`); console.log('[geartest]', text) }
  const check = (name, ok, detail = '') => { fails += !ok; note(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`) }
  const page = (js) => win.webContents.executeJavaScript(js)
  const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(150) } return false }
  const stats = () => page('window.naqiPlayerStats()')
  const watching = () => page(`!document.querySelector('#watch').hidden`)
  const full = () => page('document.fullscreenElement?.id || null')
  const shot = async (name) => { await sleep(400); writeFileSync(join(outDir, name), (await win.webContents.capturePage()).toPNG()) }
  const press = async (keyCode, modifiers = [], wait = 250) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    if (keyCode.length === 1) win.webContents.sendInputEvent({ type: 'char', keyCode, modifiers })
    if (keyCode === 'Return') win.webContents.sendInputEvent({ type: 'char', keyCode: String.fromCharCode(13), modifiers })   // a button acts on Enter's char
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await sleep(wait)
  }
  const center = (sel) => page(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] })()`)
  const move = async ([x, y]) => { win.webContents.sendInputEvent({ type: 'mouseMove', x, y }); await sleep(150) }
  const click = async ([x, y], count = 1, wait = 300) => {
    for (let n = 1; n <= count; n++) {
      win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: n })
      win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: n })
    }
    await sleep(wait)
  }
  // A real click on a bar button: the mouse first wakes the bar
  const clickButton = async (sel, wait = 400) => { await move(await center('#screen')); await move(await center(sel)); await click(await center(sel), 1, wait) }
  const clickIn = async (sel, wait = 400) => { await move(await center(sel)); await click(await center(sel), 1, wait) }
  const gear = () => page(`(() => { const m = document.querySelector('#gear-menu'); const r = m.getBoundingClientRect(); const s = (document.fullscreenElement || m.parentElement).getBoundingClientRect();
    return { open: m.dataset.open === 'true', shown: getComputedStyle(m).visibility === 'visible' && +getComputedStyle(m).opacity > 0.9, panel: m.dataset.panel, in: m.parentElement.id,
      focusIn: m.contains(document.activeElement), focus: document.activeElement.id || document.activeElement.textContent.trim().slice(0, 20),
      top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), h: Math.round(r.height),
      fits: r.top >= -1 && r.bottom <= innerHeight + 1 && r.left >= -1 && r.right <= innerWidth + 1,
      value: document.querySelector('#gear-speed-value').textContent } })()`)
  const speedItem = (r) => `#gear-speeds [data-speed="${r}"]`
  const rate = () => page('window.naqiSpeed()')
  const playing = () => page(`document.querySelector('#player-play').getAttribute('aria-pressed') === 'true'`)
  // The sound's own pace: media seconds per real second over `ms`
  const pace = async (ms = 2500) => {
    const a = await stats()
    await sleep(ms)
    const b = await stats()
    return (b.at - a.at) / ((b.now - a.now) / 1000)
  }
  const pick = (abs, q) => abs[Math.min(abs.length - 1, Math.floor(q * abs.length))] || 0
  const syncRun = async (r, mediaS) => {
    await page(`document.querySelector('#timebar').focus()`)
    for (let i = 0; i < 40; i++) await press('j', [], 30)
    await page(`document.activeElement.blur()`)
    await clickButton('#gear-toggle')
    await clickIn('[data-go="speed"]')
    await clickIn(speedItem(r), 700)
    await press('Escape', [], 400)
    await move(await center('#screen'))
    await click(await center('#screen'), 2, 300)
    if (!(await until(async () => (await full()) === 'screen', 10000))) return check(`fullscreen for the ${r}x run`, false)
    await sleep(500)
    const n0 = (await stats()).sync.length
    const from = (await stats()).at
    const len = (await stats()).length
    const end = Math.min(len - 0.5, from + mediaS)
    const ended = await until(async () => {
      const s = await stats()
      return s.at >= end || s.paused
    }, (mediaS / r + 60) * 1000)
    const s = await stats()
    const sync = s.sync.slice(n0)
    const abs = sync.map(([, e]) => Math.abs(e)).sort((a, b) => a - b)
    const span = sync.length ? sync.at(-1)[0] - sync[0][0] : 0
    writeFileSync(join(outDir, `sync-${r}x.json`), JSON.stringify(sync))
    check(`${r}x: played ${(s.at - from).toFixed(0)} s of the file`, ended && s.at >= end - 1, `at ${s.at.toFixed(1)} of ${len.toFixed(1)} s, paused ${s.paused}, rate ${s.rate}`)
    check(`${r}x: sync in fullscreen within 0.05 s`, abs.length > 200 && abs.at(-1) <= 0.05,
      `${abs.length} frames over ${span.toFixed(0)} s of the file: median ${(pick(abs, 0.5) * 1000).toFixed(0)} ms, 99% ${(pick(abs, 0.99) * 1000).toFixed(0)} ms, max ${((abs.at(-1) || 0) * 1000).toFixed(0)} ms`)
    await press('Escape')
    await until(async () => (await full()) === null && !win.isFullScreen(), 10000)
    await sleep(800)
  }

  try {
    const data = process.env.NAQIE_DATA || ''
    if (!/naqie-t10\.5[\\/]?$/.test(data)) throw new Error('NAQIE_DATA must be a folder named naqie-t10.5 (the real history is never used)')
    rmSync(data, { recursive: true, force: true })
    theater0 = (await page('window.naqi.getSettings()')).theater ?? null
    await page(`window.naqi.setSettings({ theater: '0' })`)
    await page(`document.body.removeAttribute('data-theater')`)
    check('engine ready with the models', await until(async () => engine.status.status === 'ready' && (await engine.call('/health')).models, 120000), engine.status.gpu?.name)
    ipcMain.removeHandler('choose-files')
    ipcMain.handle('choose-files', () => [SAMPLE])
    await page(`document.querySelector('#choose').click()`)
    await sleep(800)
    await page(`document.querySelector('#go').click()`)
    check('the player opens with the 5 min file', await until(watching, 120000))
    await until(async () => (await stats()).firstPlaying !== null, 60000)
    // Windows holds fullscreen back for a window that is not in front (see the keys self-test)
    win.setAlwaysOnTop(true)
    win.moveTop()
    win.focus()
    await sleep(1500)

    // Normal player, mouse
    await clickButton('#gear-toggle')
    let g = await gear()
    check('gear click: the menu opens on the screen', g.open && g.shown && g.in === 'screen' && g.panel === 'main' && g.fits, JSON.stringify(g))
    check('... focus is on its first item, the gear says it is open', g.focusIn &&
      (await page(`document.querySelector('#gear-toggle').getAttribute('aria-expanded')`)) === 'true')
    const acts = () => page(`(() => { const v = (id) => { const b = document.querySelector(id); return b.getClientRects().length ? (b.disabled ? 'off' : 'on') : 'none' }
      return { save: v('#save-toggle'), report: v('#report-here'), saveValue: document.querySelector('#gear-save-value').textContent,
        onBar: !!document.querySelector('#screen-bar #save-toggle, #screen-bar #report-here') } })()`)
    let a = await acts()
    check('Save and Report here are in the menu, not on the bar; Save waits while cleaning', a.report === 'on' && a.save === 'off' && a.saveValue === 'when all is clean' && !a.onBar, JSON.stringify(a))
    const h0 = g.h
    await sleep(3600)
    check('... the bar stays while it is open', (await page(`document.querySelector('#screen').dataset.bar`)) === 'shown')
    for (const t of ['light', 'dark']) {
      await page(`document.documentElement.dataset.theme = '${t}'`)
      await shot(`menu-${t}.png`)
    }
    await clickIn('[data-go="speed"]', 500)
    g = await gear()
    check('Speed: its list opens in the same card, taller', g.panel === 'speed' && g.h > h0 && g.fits, `${h0} -> ${g.h} px`)
    for (const t of ['light', 'dark']) {
      await page(`document.documentElement.dataset.theme = '${t}'`)
      await shot(`speeds-${t}.png`)
    }
    await page(`delete document.documentElement.dataset.theme`)
    await clickIn(speedItem(1.5), 700)
    g = await gear()
    check('1.5x: chosen, back to the settings, which say 1.5x', (await rate()) === 1.5 && g.panel === 'main' && g.value === '1.5x' && g.open, JSON.stringify(g))
    check('... the sound plays at 1.5x, the voice pitch kept', Math.abs((await pace()) - 1.5) < 0.12 && (await stats()).pitch === true)
    await click(await center('#picture'), 1, 500)
    g = await gear()
    check('a click on the picture closes it and does not pause', !g.open && await playing())
    await clickButton('#gear-toggle')
    await clickButton('#gear-toggle')
    check('the gear again closes it', !(await gear()).open)

    // Each speed plays at its rate
    for (const r of SPEEDS) {
      await clickButton('#gear-toggle')
      await clickIn('[data-go="speed"]')
      await clickIn(speedItem(r), 700)
      await press('Escape', [], 300)
      const got = await pace(3000)
      check(`${r}x plays at its rate`, (await rate()) === r && Math.abs(got - r) < 0.08 * r + 0.05 && await playing(), `${got.toFixed(3)} s a second`)
    }

    // Keys: Enter opens, arrows move, Right opens Speed, Enter picks, Escape closes (the player stays)
    await page(`document.querySelector('#gear-toggle').focus()`)
    await press('Return', [], 400)
    g = await gear()
    check('keys: Enter on the gear opens it, focus inside', g.open && g.focusIn, g.focus)
    await press('Down')
    await press('Up')
    await press('Right', [], 400)
    g = await gear()
    check('... Right opens Speed, focus on the chosen speed', g.panel === 'speed' && g.focus === '2x', g.focus)
    await press('Up', [], 200)
    await press('Return', [], 700)
    g = await gear()
    check('... Up + Enter picks 1.75x and goes back', (await rate()) === 1.75 && g.panel === 'main' && g.value === '1.75x' && g.focus === 'Speed1.75x', g.focus)
    await press('Right', [], 400)
    await press('Left', [], 400)
    g = await gear()
    check('... Left goes back to the settings', g.panel === 'main' && g.focusIn)
    await press('Escape', [], 400)
    g = await gear()
    check('... Escape closes it, focus back on the gear, the player stays', !g.open && g.focus === 'gear-toggle' && await watching())
    await press('Up', [], 200)
    check('... arrows are the player\'s again once it is closed', (await rate()) === 1.75 && !(await gear()).open)

    // Theater
    await clickButton('#theater-toggle')
    await sleep(500)
    await clickButton('#gear-toggle')
    g = await gear()
    check('theater: the menu opens', g.open && g.shown && g.fits, JSON.stringify(g))
    await shot('theater.png')
    await press('Escape', [], 400)
    check('theater: Escape closes it', !(await gear()).open && await watching())
    await clickButton('#theater-toggle')
    await sleep(500)

    // Fullscreen
    await press('f')
    check('F: fullscreen', await until(async () => (await full()) === 'screen', 10000))
    await sleep(800)
    await clickButton('#gear-toggle')
    await clickIn('[data-go="speed"]')
    g = await gear()
    check('fullscreen: the menu opens on the fullscreen picture', g.open && g.shown && g.in === 'screen' && g.fits && g.panel === 'speed', JSON.stringify(g))
    await shot('fullscreen.png')
    await clickIn(speedItem(1.25), 700)
    check('fullscreen: 1.25x chosen there', (await rate()) === 1.25)
    await press('Escape', [], 800)
    const stillFull = (await full()) === 'screen'
    check('fullscreen: Escape closes the menu', !(await gear()).open, stillFull ? 'still fullscreen' : 'and leaves fullscreen (Escape is the browser\'s there)')
    if (!stillFull) { await press('f'); await until(async () => (await full()) === 'screen', 10000); await sleep(800) }
    await clickButton('#gear-toggle')
    const gm = await center('#screen')
    await click([gm[0] - 200, gm[1] - 100], 1, 500)
    check('fullscreen: a click outside closes it', !(await gear()).open && await playing() && (await full()) === 'screen', JSON.stringify(await stats().then((x) => ({ paused: x.paused, at: x.at }))))
    if ((await full()) === 'screen') { await press('Escape'); await until(async () => (await full()) === null && !win.isFullScreen(), 10000) }
    await sleep(800)

    // The corner (small player)
    await press('i', [], 800)
    check('I: the item plays in the corner, its letter not typed into the link box', (await stats()).corner && (await page(`document.querySelector('#url').value`)) === '')
    await clickIn('#corner-gear', 500)
    g = await gear()
    check('corner: its gear opens the menu above the small player', g.open && g.shown && g.in === 'corner' && g.fits, JSON.stringify(g))
    a = await acts()
    check('... with no Save or Report here there', a.save === 'none' && a.report === 'none', JSON.stringify(a))
    await clickIn('[data-go="speed"]', 500)
    check('corner: the speed list fits too', (await gear()).fits)
    await shot('corner.png')
    await clickIn(speedItem(2), 700)
    const cp = await pace()
    check('corner: 2x chosen there', (await rate()) === 2 && Math.abs(cp - 2) < 0.2, `rate ${await rate()}, ${cp.toFixed(2)} s a second`)
    await click([60, 60], 1, 500)
    check('corner: a click outside closes it', !(await gear()).open)
    await clickIn('#corner-gear', 400)
    await press('Escape', [], 400)
    check('corner: Escape closes it', !(await gear()).open && (await stats()).corner)
    await clickIn('#corner-open', 800)
    check('back in the player: speed kept, the menu opens on the screen again', await watching() && (await rate()) === 2)
    await clickButton('#gear-toggle')
    check('... in the screen', (await gear()).in === 'screen')
    await press('Escape', [], 400)

    // A small window
    const size = win.getSize()
    win.setSize(720, 480)
    await sleep(700)
    await clickButton('#gear-toggle')
    g = await gear()
    await clickIn('[data-go="speed"]', 500)
    const gs = await gear()
    const inScreen = await page(`(() => { const m = document.querySelector('#gear-menu').getBoundingClientRect(); const s = document.querySelector('#screen').getBoundingClientRect(); return m.top >= s.top - 1 && m.bottom <= s.bottom + 1 })()`)
    await shot('small.png')
    check('small window: the menu and its speed list fit on the screen', g.fits && gs.fits && inScreen, `settings ${g.h} px, speeds ${gs.h} px`)
    await press('Escape', [], 400)
    win.setSize(...size)
    await sleep(600)

    // Sync at 2x and 0.5x, in fullscreen, once all of it is clean
    check('cleaning done', await until(async () => !(await stats()).live, 240000))
    // Save and Report here from the menu, by mouse
    await clickButton('#gear-toggle')
    a = await acts()
    check('all clean: Save in the menu is ready', a.save === 'on' && a.saveValue === 'MP3 or MP4', JSON.stringify(a))
    await clickIn('#save-toggle', 600)
    check('... a click opens the Save row and closes the menu', !(await gear()).open &&
      (await page(`document.querySelector('#save-panel').dataset.open`)) === 'true' && (await page('document.activeElement.id')) === 'save-go')
    await press('Escape', [], 400)
    check('... Escape closes the Save row, focus on the gear', (await page(`document.querySelector('#save-panel').dataset.open`)) === 'false' && (await page('document.activeElement.id')) === 'gear-toggle')
    await clickButton('#gear-toggle')
    const shown = await page(`document.querySelector('#gear-report-value').textContent`)
    const at1 = (await stats()).at
    await clickIn('#report-here', 900)
    const rp = await page(`({ on: !document.querySelector('#report').hidden, from: document.querySelector('#from').value || '', to: document.querySelector('#to').value || '' })`)
    check('Report here in the menu: the report page at the playhead, the player paused', rp.on && (await stats()).paused, `menu said ${shown}, at ${at1.toFixed(1)} s, from ${rp.from} to ${rp.to}`)
    await clickIn('#report-back', 900)
    check('... Back: the player again', await watching())
    if (await page(`!!document.querySelector('#corner') && !document.querySelector('#corner').hidden`)) await clickIn('#corner-open', 800)
    if (!(await playing())) await clickButton('#player-play', 400)
    const mediaS = process.env.NAQI_QUICK ? 60 : 300
    await syncRun(2, mediaS)
    await syncRun(0.5, mediaS)
    // Back to normal for the next tests
    await clickButton('#gear-toggle')
    await clickIn('[data-go="speed"]')
    await clickIn(speedItem(1), 700)
    await press('Escape', [], 400)
  } catch (e) {
    check('test ran', false, e.stack || e.message)
  } finally {
    win.setAlwaysOnTop(false)
    await page(`window.naqi.setSettings({ theater: ${JSON.stringify(theater0 ?? '0')} })`).catch(() => {})
    note(fails ? `${fails} check(s) FAILED` : 'ALL PASSED')
    writeFileSync(join(outDir, 'log.txt'), log.join('\n') + '\n')
    setTimeout(() => app.quit(), 500)
  }
}
