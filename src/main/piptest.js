import { app, ipcMain } from 'electron'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Dev check for T10.7 (run with NAQI_SELFTEST=pip and NAQIE_DATA pointing to a folder named naqie-t10.7, outside
// OneDrive; it is emptied first; GPU, about 4 min): picture-in-picture, with real mouse and key events. The 5 min
// video goes into the floating window from the settings menu; its sync is measured there, also with Naqi minimized;
// the floating window's play / pause reach the sound; its sound stays muted; Escape keeps it floating with a slim
// corner; P, "Bring the picture back" and fullscreen bring the picture back; closing the item closes it; a sound only
// has no item. NAQI_QUICK=1 measures the sync for 15 + 10 s instead of 60 + 30 s. Log, shots, sync in test_out/t10.7/.
const outDir = join(app.getAppPath(), 'test_out', 't10.7')
const VIDEO = join(app.getAppPath(), 'samples', 'sync_test_5min.mp4')
const SOUND = join(app.getAppPath(), 'samples', 'narration_30s.mp3')
const SHOWN_S = process.env.NAQI_QUICK ? 15 : 60
const MIN_S = process.env.NAQI_QUICK ? 10 : 30
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function run(win, engine) {
  mkdirSync(outDir, { recursive: true })
  const log = []
  let fails = 0
  const t0 = Date.now()
  const note = (text) => { log.push(`${((Date.now() - t0) / 1000).toFixed(2)} s  ${text}`); console.log('[piptest]', text) }
  const check = (name, ok, detail = '') => { fails += !ok; note(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`) }
  const page = (js) => win.webContents.executeJavaScript(js)
  const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(150) } return false }
  const stats = () => page('window.naqiPlayerStats()')
  const pip = () => page('window.naqiPip()')
  const visible = (sel) => page(`!document.querySelector(${JSON.stringify(sel)}).hidden`)
  const watching = () => visible('#watch')
  const corner = () => visible('#corner')
  const shot = async (name) => { await sleep(400); writeFileSync(join(outDir, name), (await win.webContents.capturePage()).toPNG()) }
  const themed = async (name) => {
    for (const t of ['light', 'dark']) {
      await page(`document.documentElement.dataset.theme = '${t}'`)
      await shot(`${name}-${t}.png`)
    }
    await page(`delete document.documentElement.dataset.theme`)
  }
  const press = async (keyCode, wait = 600) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
    if (keyCode.length === 1) win.webContents.sendInputEvent({ type: 'char', keyCode })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
    await sleep(wait)
  }
  const center = (sel) => page(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] })()`)
  const click = async (sel, wait = 600) => {
    if (await page(`!!document.querySelector(${JSON.stringify(sel)}).closest('#screen-bar')`)) {
      const [sx, sy] = await center('#screen')
      win.webContents.sendInputEvent({ type: 'mouseMove', x: sx, y: sy - 20 })
      await sleep(150)
    }
    const [x, y] = await center(sel)
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y })
    await sleep(120)
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    await sleep(wait)
  }
  const moving = async () => { const a = (await stats()).at; await sleep(1500); return (await stats()).at - a > 1 }
  const cleanAndPlay = async (file) => {
    ipcMain.removeHandler('choose-files')
    ipcMain.handle('choose-files', () => [file])
    await page(`document.querySelector('#choose').click()`)
    await sleep(800)
    await page(`document.querySelector('#go').click()`)
  }
  // Sync of the frames shown from now for `s` seconds
  const measure = async (s) => {
    const n0 = (await stats()).sync.length
    await sleep(s * 1000)
    const sync = (await stats()).sync.slice(n0)
    const abs = sync.map(([, e]) => Math.abs(e)).sort((a, b) => a - b)
    const pick = (q) => abs[Math.min(abs.length - 1, Math.floor(q * abs.length))] || 0
    return { sync, n: abs.length, max: abs.at(-1) ?? 1, text: `${abs.length} frames over ${s} s: median ${(pick(0.5) * 1000).toFixed(0)} ms, 99% ${(pick(0.99) * 1000).toFixed(0)} ms, max ${((abs.at(-1) ?? 0) * 1000).toFixed(0)} ms` }
  }

  try {
    const data = process.env.NAQIE_DATA || ''
    if (!/naqie-t10\.7[\\/]?$/.test(data)) throw new Error('NAQIE_DATA must be a folder named naqie-t10.7 (the real history is never used)')
    rmSync(data, { recursive: true, force: true })
    await page(`document.body.removeAttribute('data-theater')`)
    check('engine ready with the models', await until(async () => engine.status.status === 'ready' && (await engine.call('/health')).models, 120000), engine.status.gpu?.name)
    await cleanAndPlay(VIDEO)
    check('the player opens with the 5 min video', await until(watching, 120000))
    await until(async () => (await stats()).firstPlaying !== null, 60000)
    await until(async () => (await pip()).ready, 20000)
    await sleep(2000)
    win.setAlwaysOnTop(true)   // a covered window shows no frames
    win.moveTop()

    // The settings menu: Picture-in-picture opens the floating window
    await click('#gear-toggle', 400)
    const item = await pip()
    check('the settings menu has Picture-in-picture', item.item && !item.disabled)
    await shot('menu.png')
    await click('#gear-pip', 1200)
    let s = await pip()
    check('a click: the picture floats, the screen says so', s.on && s.shown === 'true' && await moving())
    check('... the menu closed, the bar stays', (await page(`document.querySelector('#gear-menu').dataset.open`)) === 'false' &&
      (await page(`document.querySelector('#screen').dataset.bar`)) === 'shown')
    await themed('screen-pip')

    // Sync in the floating window, then with Naqi minimized (where it is used most)
    await sleep(1000)
    const shown = await measure(SHOWN_S)
    check('sync in the floating window within 0.05 s', shown.n > SHOWN_S * 20 && shown.max <= 0.05, shown.text)
    win.minimize()
    await sleep(500)
    const min = await measure(MIN_S)
    check('... with Naqi minimized within 0.05 s', min.n > MIN_S * 20 && min.max <= 0.05 && (await pip()).on, min.text)
    win.restore()
    win.moveTop()
    await sleep(800)
    writeFileSync(join(outDir, 'sync.json'), JSON.stringify({ shown: shown.sync, minimized: min.sync }))

    // The floating window's own buttons act on the picture: they reach the sound
    await page(`document.querySelector('#picture').pause()`)
    await sleep(500)
    const paused = (await stats()).paused
    await page(`document.querySelector('#picture').play()`)
    await sleep(800)
    check('its pause and play pause and play the sound', paused && !(await stats()).paused && !(await pip()).vpaused && await moving())
    await page(`document.querySelector('#picture').muted = false`)
    await sleep(200)
    check("the picture's own sound stays muted", (await pip()).muted)

    // Escape: Home, it keeps floating, the corner is a slim row; a click returns
    await press('Escape')
    check('Escape: Home, still floating, slim corner, sound on', await corner() && (await pip()).on &&
      (await page(`document.querySelector('#corner').dataset.kind`)) === 'audio' && await moving())
    await themed('home-corner-pip')
    await click('#corner-title', 800)
    check('... its title: the full player, still floating', await watching() && (await pip()).on)

    // P brings it back and sends it again; the screen's button brings it back
    await press('p', 1200)
    s = await pip()
    check('P: the picture back in the window, the sound on', !s.on && s.shown === 'false' && !s.vpaused && await moving())
    await sleep(1500)
    const back = await measure(8)
    check('... in sync again', back.n > 100 && back.max <= 0.05, back.text)
    await press('p', 1200)
    check('P again: floating', (await pip()).on)
    await click('#pip-back', 1200)
    check('"Bring the picture back": back, still playing', !(await pip()).on && !(await stats()).paused)

    // Fullscreen takes the picture back
    await press('p', 1200)
    await press('f', 1500)
    check('F while floating: fullscreen with the picture', !(await pip()).on && await page('!!document.fullscreenElement'))
    await press('Escape', 1000)

    // Closing the item closes the floating window
    await press('p', 1200)
    await press('Escape', 600)
    await click('#corner-close', 800)
    s = await pip()
    check('Stop in the corner: the floating window closes with the item', !s.on && (await stats()).id === null)

    // A sound only: no item, P does nothing
    await cleanAndPlay(SOUND)
    await until(async () => await watching() && (await stats()).firstPlaying !== null, 120000)
    await sleep(1000)
    await click('#gear-toggle', 400)
    check('a sound only: no Picture-in-picture item', !(await pip()).item)
    await press('Escape', 300)
    await press('p', 800)
    check('... P does nothing', !(await pip()).on)
  } catch (e) {
    check('test ran', false, e.stack || e.message)
  } finally {
    win.setAlwaysOnTop(false)
    note(fails ? `${fails} check(s) FAILED` : 'ALL PASSED')
    writeFileSync(join(outDir, 'log.txt'), log.join('\n') + '\n')
    setTimeout(() => app.quit(), 500)
  }
}
