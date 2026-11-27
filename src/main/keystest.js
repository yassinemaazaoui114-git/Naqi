import { app, ipcMain } from 'electron'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Dev check for T10.1 (run with NAQI_SELFTEST=keys and NAQIE_DATA pointing to a folder named naqie-t10.1, outside
// OneDrive; it is emptied first; GPU, about 2 min): the player keys on the real page, pressed as real key events.
// A 5 min file is cleaned and played; while only its first part is clean, L pressed many times stops 3 s before the
// clean edge (like the time bar) and playback waits there. Once all is clean: Left / Right 5 s, Shift + arrows 10 s,
// J / L 10 s, K and Space play / pause, M mute, F fullscreen and back (also with Escape, which then leaves the
// player open), the keys card (keys button, ?, a pressed key lit on it, Escape and a click outside close it, light
// and dark screenshots), keys do nothing while typing in a box, Escape goes back to Home. Also the bar on the picture
// (T10.1b): hides after the mouse stops, a key or the mouse brings it back, it stays while paused, hovered, with the
// keys card open, keyboard focus on it does not hold it, light / dark / small window shots. Log and screenshots in test_out/t10.1/.
const outDir = join(app.getAppPath(), 'test_out', 't10.1')
const SAMPLE = join(app.getAppPath(), 'samples', 'sync_test_5min.mp4')   // a video: the bar hides only over a picture
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function run(win, engine) {
  mkdirSync(outDir, { recursive: true })
  const log = []
  let fails = 0
  const t0 = Date.now()
  const note = (text) => { log.push(`${((Date.now() - t0) / 1000).toFixed(2)} s  ${text}`); console.log('[keystest]', text) }
  const check = (name, ok, detail = '') => { fails += !ok; note(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`) }
  const page = (js) => win.webContents.executeJavaScript(js)
  const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(150) } return false }
  const stats = () => page('window.naqiPlayerStats()')
  const watching = () => page(`!document.querySelector('#watch').hidden`)
  const paused = () => page(`document.querySelector('#player-play').getAttribute('aria-pressed') !== 'true'`)
  const full = () => page('document.fullscreenElement?.id || null')
  const press = async (keyCode, modifiers = [], wait = 250) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    if (keyCode.length === 1) win.webContents.sendInputEvent({ type: 'char', keyCode, modifiers })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await sleep(wait)
  }
  // Presses a jump key and returns how far the jump asked to go from where the sound was
  const step = async (keyCode, modifiers = []) => {
    const before = (await stats()).jumps.length
    const at = (await stats()).at
    await press(keyCode, modifiers)
    const s = await stats()
    if (s.jumps.length !== before + 1) return NaN
    return +(s.jumps.at(-1).asked - at).toFixed(2)
  }
  const near = (a, b, d = 0.4) => Math.abs(a - b) <= d

  try {
    const data = process.env.NAQIE_DATA || ''
    if (!/naqie-t10\.1[\\/]?$/.test(data)) throw new Error('NAQIE_DATA must be a folder named naqie-t10.1 (the real history is never used)')
    try { rmSync(data, { recursive: true, force: true }) } catch { /* the engine may have it open already: emptied before the run */ }
    check('engine ready with the models', await until(async () => engine.status.status === 'ready' && (await engine.call('/health')).models, 120000), engine.status.gpu?.name)
    ipcMain.removeHandler('choose-files')
    ipcMain.handle('choose-files', () => [SAMPLE])
    await page(`document.querySelector('#choose').click()`)
    await sleep(800)
    await page(`document.querySelector('#go').click()`)
    check('the player opens with the 5 min file', await until(watching, 120000))
    await until(async () => (await stats()).firstPlaying !== null, 60000)
    let s = await stats()
    check('it plays while only the first part is clean', s.live && s.ready > 0 && s.ready < s.length, `clean up to ${s.ready.toFixed(0)} of ${s.length.toFixed(0)} s`)

    // A jump past the clean part: L many times stops 3 s before the edge and waits there, like the time bar
    await page(`document.querySelector('#player-play').focus()`)
    for (let i = 0; i < 20; i++) await press('l', [], 60)
    await sleep(300)
    s = await stats()
    const j = s.jumps.at(-1)
    check('L past the clean part stops 3 s before its edge', s.live && j && near(j.to, s.ready - 3, 0.5),
      j && `asked ${j.asked.toFixed(1)} s, went to ${j.to.toFixed(1)} s (clean up to ${s.ready.toFixed(0)} s)`)
    check('... and says why', (await page(`document.querySelector('#watch-note').textContent`)).includes('lit part'))
    check('... playback waits at the clean edge', await until(async () => (await stats()).waiting, 15000))
    check('... and goes on when more is clean', await until(async () => (await stats()).at > j.to + 4, 120000), `at ${(await stats()).at.toFixed(1)} s`)
    check('cleaning done', await until(async () => !(await stats()).live, 120000))

    // All clean: every jump key, from the middle
    await page(`document.querySelector('#timebar').focus()`)
    for (let i = 0; i < 6; i++) await press('Left', ['shift'], 80)
    await sleep(500)
    const right = await step('Right')
    check('Right: forward 5 s', near(right, 5), `${right} s`)
    check('Left: back 5 s', near(await step('Left'), -5))
    check('Shift + Right: forward 10 s', near(await step('Right', ['shift']), 10))
    check('Shift + Left: back 10 s', near(await step('Left', ['shift']), -10))
    check('L: forward 10 s', near(await step('l'), 10))
    check('J: back 10 s', near(await step('j'), -10))
    await page(`document.querySelector('#player-play').focus()`)
    check('arrows work with the play button focused too', near(await step('Right'), 5))

    // Volume
    const vol = () => page(`+document.querySelector('#volume').value`)
    const v0 = await vol()
    await press('Down')
    await press('Down')
    const v1 = await vol()
    await press('Up')
    check('Down / Up: volume 5% a press', near(v1, v0 - 0.1, 0.001) && near(await vol(), v0 - 0.05, 0.001), `${v0} -> ${v1} -> ${await vol()}`)
    await press('Up')
    await page(`document.querySelector('#volume').focus()`)
    await press('Down')
    check('... the volume slider keeps its own arrows (1% a press)', near(await vol(), v0 - 0.01, 0.001), `${await vol()}`)
    await press('Up')
    await page(`document.querySelector('#timebar').focus()`)

    // Play / pause and mute
    const was = await paused()
    await press('k')
    const k1 = await paused()
    await press('k')
    check('K pauses and plays', was === false && k1 === true && (await paused()) === false)
    await page(`document.querySelector('#timebar').focus()`)
    await press('Space')
    const sp = await paused()
    await press('Space')
    check('Space pauses and plays', sp === true && (await paused()) === false)
    await press('m')
    const muted = await page(`document.querySelector('#mute').getAttribute('aria-label')`)
    await press('m')
    check('M mutes and unmutes', muted === 'Unmute (M)' && (await page(`document.querySelector('#mute').getAttribute('aria-label')`)) === 'Mute (M)')

    // Fullscreen
    await page(`window.__fs = []; const t0 = performance.now(); document.addEventListener('fullscreenchange', () => __fs.push([Math.round(performance.now() - t0), String(document.fullscreenElement?.id)])); document.addEventListener('fullscreenerror', () => __fs.push([Math.round(performance.now() - t0), 'error']))`)
    win.webContents.on('console-message', (_e, _l, msg) => { if (msg.includes('fullscreen')) note(`DEBUG ${msg}`) })
    // Windows holds fullscreen back for a window that is not in front (a user pressing F always has it in front),
    // so the test window is put on top for this part
    win.setAlwaysOnTop(true)
    win.moveTop()
    win.focus()
    await press('f')
    check('F: fullscreen', await until(async () => (await full()) === 'screen', 10000))
    writeFileSync(join(outDir, 'fullscreen.png'), (await win.webContents.capturePage()).toPNG())
    await sleep(1000)
    await press('f')
    check('F again: back', await until(async () => (await full()) === null && !win.isFullScreen(), 10000))
    await sleep(1000)
    await press('f')
    await until(async () => (await full()) === 'screen', 10000)
    await sleep(1000)
    await press('Escape')
    check('Escape leaves fullscreen', await until(async () => (await full()) === null && !win.isFullScreen(), 10000))
    await sleep(1000)
    check('... and keeps the player open', await watching())

    // The bar on the picture (T10.1b): hides after the mouse stops, back on a move or a key, stays while needed
    const barState = () => page(`document.querySelector('#screen').dataset.bar`)
    const center = (sel) => page(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] })()`)
    const move = async ([x, y]) => { win.webContents.sendInputEvent({ type: 'mouseMove', x, y }); await sleep(150) }
    await page(`document.activeElement.blur()`)
    const mid = await center('#screen')
    await move([mid[0] - 40, mid[1] - 40])
    await move(mid)
    check('bar: shown when the mouse moves over the picture', (await barState()) === 'shown')
    const shownAt = Date.now()
    check('bar: hides a moment after the mouse stops', await until(async () => (await barState()) === 'hidden', 6000), `${((Date.now() - shownAt) / 1000).toFixed(1)} s`)
    const hidden = await page(`(() => { const b = getComputedStyle(document.querySelector('#screen-bar')); return { cursor: getComputedStyle(document.querySelector('#screen')).cursor, clicks: b.pointerEvents } })()`)
    check('... cursor and clicks go with it', hidden.cursor === 'none' && hidden.clicks === 'none', JSON.stringify(hidden))
    await sleep(500)
    writeFileSync(join(outDir, 'bar-hidden.png'), (await win.webContents.capturePage()).toPNG())
    check('... the hairline keeps the played part in sight', await page(`getComputedStyle(document.querySelector('#screen-peek')).opacity === '1'`))
    await press('Up', [], 0)
    check('bar: a key brings it back at once', (await barState()) === 'shown' && await page(`document.querySelector('#screen').hasAttribute('data-bar-instant')`))
    await press('Down')
    await until(async () => (await barState()) === 'hidden', 6000)
    await move([mid[0] + 30, mid[1]])
    check('bar: the mouse brings it back', (await barState()) === 'shown')
    await press('k')
    await sleep(3500)
    check('bar: stays while paused', (await paused()) && (await barState()) === 'shown')
    await press('k')
    await move(await center('#volume'))
    await sleep(3500)
    check('bar: stays while the mouse is on it', (await barState()) === 'shown')
    await move(await center('#watch-title'))
    check('bar: hides soon when the mouse leaves the picture', await until(async () => (await barState()) === 'hidden', 1500))
    await move(mid)
    await page(`document.querySelector('#keys-toggle').click()`)
    await sleep(3500)
    check('bar: stays while the keys card is open', (await barState()) === 'shown')
    await page(`document.querySelector('#keys-toggle').click()`)
    await page(`document.querySelector('#timebar').focus()`)
    await press('Right')
    check('bar: keyboard focus on it does not hold it', await until(async () => (await barState()) === 'hidden', 6000))
    await page(`document.activeElement.blur()`)
    const theme0 = await page('document.documentElement.dataset.theme || null')
    for (const t of ['light', 'dark']) {
      await page(`document.documentElement.dataset.theme = '${t}'`)
      await move([mid[0] + 10 * (t === 'light' ? 1 : -1), mid[1]])
      await sleep(300)
      writeFileSync(join(outDir, `bar-${t}.png`), (await win.webContents.capturePage()).toPNG())
    }
    await page(`(() => { const d = document.documentElement.dataset; const t = ${JSON.stringify(theme0)}; if (t) d.theme = t; else delete d.theme })()`)
    // A small window: everything still fits on the bar
    const size = win.getSize()
    win.setSize(720, 480)
    await sleep(600)
    await move(await center('#screen'))
    await sleep(300)
    writeFileSync(join(outDir, 'bar-small.png'), (await win.webContents.capturePage()).toPNG())
    const fits = await page(`(() => { const c = document.querySelector('.controls'); const s = document.querySelector('#screen').getBoundingClientRect(); const k = document.querySelector('#keys-toggle').getBoundingClientRect(); return c.scrollWidth <= c.clientWidth + 1 && k.right <= s.right && k.bottom <= s.bottom })()`)
    check('bar: fits a small window', fits)
    win.setSize(...size)
    await sleep(400)

    win.setAlwaysOnTop(false)
    note(`fullscreen events (ms, element): ${JSON.stringify(await page('window.__fs'))}, window focused ${win.isFocused()}`)
    // The keys card
    // Light and dark set on the page only (the saved theme choice is not touched)
    const theme = await page('document.documentElement.dataset.theme || null')
    const setTheme = (t) => page(`(() => { const d = document.documentElement.dataset; if (${JSON.stringify(t)}) d.theme = ${JSON.stringify(t)}; else delete d.theme })()`)
    const cardOpen = () => page(`document.querySelector('#keys-card').matches(':popover-open')`)
    const shot = async (name) => { await sleep(400); writeFileSync(join(outDir, name), (await win.webContents.capturePage()).toPNG()) }
    await page(`document.querySelector('#keys-toggle').click()`)
    check('keys button opens the card', await cardOpen() && (await page(`document.querySelector('#keys-toggle').getAttribute('aria-expanded')`)) === 'true')
    const box = await page(`(() => { const c = document.querySelector('#keys-card').getBoundingClientRect(); const b = document.querySelector('#keys-toggle').getBoundingClientRect(); return { c: [c.left, c.top, c.right, c.bottom], b: [b.left, b.top, b.right, b.bottom], w: innerWidth, h: innerHeight } })()`)
    check('... above the button, inside the window', box.c[3] <= box.b[1] && box.c[0] >= 0 && box.c[2] <= box.w && box.c[1] >= 0, JSON.stringify(box))
    await setTheme('light')
    await shot('keys-card-light.png')
    await setTheme('dark')
    await shot('keys-card-dark.png')
    await press('l', [], 60)
    check('a key pressed lights up on the card', await page(`document.querySelector('#keys-card kbd[data-k="l"]').classList.contains('is-lit')`))
    await sleep(300)
    check('... and goes out', !(await page(`document.querySelector('#keys-card kbd[data-k="l"]').classList.contains('is-lit')`)))
    await page(`document.querySelector('#keys-toggle').click()`)
    check('keys button again closes it', !(await cardOpen()))
    await press('?')
    check('? opens it', await cardOpen())
    await press('?')
    check('? again closes it', !(await cardOpen()))
    await press('?')
    await press('Escape')
    check('Escape closes the card and keeps the player', !(await cardOpen()) && await watching())
    await press('?')
    const r = await page(`(() => { const r = document.querySelector('#watch-title').getBoundingClientRect(); return [Math.round(r.left + 5), Math.round(r.top + r.height / 2)] })()`)
    win.webContents.sendInputEvent({ type: 'mouseDown', x: r[0], y: r[1], button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: r[0], y: r[1], button: 'left', clickCount: 1 })
    await sleep(300)
    check('a click outside closes it', !(await cardOpen()))
    await setTheme(theme)

    // Keys do nothing while typing in a box
    await page(`(() => { const i = document.createElement('input'); i.id = 'keys-box'; document.querySelector('#watch').append(i); i.focus() })()`)
    const at = (await stats()).at
    const jumps = (await stats()).jumps.length
    const volBefore = await vol()
    for (const k of ['k', 'j', 'l', 'f', 'm', '?', 'Space', 'Right', 'Left', 'Up', 'Down']) await press(k, [], 120)
    s = await stats()
    check('typing in a box: no key acts', s.jumps.length === jumps && !(await paused()) && (await full()) === null && !(await cardOpen()) && (await vol()) === volBefore &&
      (await page(`document.querySelector('#mute').getAttribute('aria-label')`)) === 'Mute (M)',
      `box holds "${await page(`document.querySelector('#keys-box').value`)}", sound ${at.toFixed(1)} -> ${s.at.toFixed(1)} s, jumps ${s.jumps.length - jumps}, paused ${await paused()}, full ${await full()}, card ${await cardOpen()}, volume ${volBefore} -> ${await vol()}, mute ${await page(`document.querySelector('#mute').getAttribute('aria-label')`)}`)
    await page(`document.querySelector('#keys-box').remove()`)

    await press('Escape', [], 600)
    check('Escape goes back to Home', !(await watching()))
  } catch (e) {
    check('test ran', false, e.stack || e.message)
  } finally {
    note(fails ? `${fails} check(s) FAILED` : 'ALL PASSED')
    writeFileSync(join(outDir, 'log.txt'), log.join('\n') + '\n')
    setTimeout(() => app.quit(), 500)
  }
}
