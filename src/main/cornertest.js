import { app, ipcMain } from 'electron'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Dev check for T10.2c (run with NAQI_SELFTEST=corner and NAQIE_DATA pointing to a folder named naqie-t10.2c, outside
// OneDrive; it is emptied first; GPU, about 4 min): keep playing in a corner, with real mouse and key events. Back and
// Escape leave the 5 min video playing in the corner on Home (its picture moved there, the sound never stops); its
// sync is measured there; its play / pause; a click returns to the full player at the same moment; the report page
// (side bar, Report here) keeps it, the sound strip pauses it and it pauses the strip; a library row of the same item
// returns to it; Stop closes it; a new Clean and play opens by itself over it; a sound only is a slim row. Light /
// dark / small window shots. NAQI_QUICK=1 measures the sync for 20 s instead of 2 min. Log, shots, sync in test_out/t10.2c/.
const outDir = join(app.getAppPath(), 'test_out', 't10.2c')
const VIDEO = join(app.getAppPath(), 'samples', 'sync_test_5min.mp4')
const SOUND = join(app.getAppPath(), 'samples', 'narration_30s.mp3')
const SYNC_S = process.env.NAQI_QUICK ? 20 : 120
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function run(win, engine) {
  mkdirSync(outDir, { recursive: true })
  const log = []
  let fails = 0
  const t0 = Date.now()
  const note = (text) => { log.push(`${((Date.now() - t0) / 1000).toFixed(2)} s  ${text}`); console.log('[cornertest]', text) }
  const check = (name, ok, detail = '') => { fails += !ok; note(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`) }
  const page = (js) => win.webContents.executeJavaScript(js)
  const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(150) } return false }
  const stats = () => page('window.naqiPlayerStats()')
  const visible = (sel) => page(`!document.querySelector(${JSON.stringify(sel)}).hidden`)
  const watching = () => visible('#watch')
  const home = () => visible('.home')
  const corner = () => visible('#corner')
  const picIn = () => page(`document.querySelector('#picture').parentElement.id`)
  const pressed = (sel) => page(`document.querySelector(${JSON.stringify(sel)}).getAttribute('aria-pressed') === 'true'`)
  const shot = async (name) => { await sleep(400); writeFileSync(join(outDir, name), (await win.webContents.capturePage()).toPNG()) }
  const press = async (keyCode, wait = 400) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
    if (keyCode.length === 1) win.webContents.sendInputEvent({ type: 'char', keyCode })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
    await sleep(wait)
  }
  const center = (sel) => page(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] })()`)
  const click = async (sel, wait = 500) => {
    // A control on the picture's bar: the mouse first wakes the bar (a hidden bar lets the click through to the picture)
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
  const themed = async (name) => {
    for (const t of ['light', 'dark']) {
      await page(`document.documentElement.dataset.theme = '${t}'`)
      await shot(`${name}-${t}.png`)
    }
    await page(`delete document.documentElement.dataset.theme`)
  }
  // The playhead moves on by itself
  const moving = async () => { const a = (await stats()).at; await sleep(1500); return (await stats()).at - a > 1 }
  const cleanAndPlay = async (file) => {
    ipcMain.removeHandler('choose-files')
    ipcMain.handle('choose-files', () => [file])
    await page(`document.querySelector('#choose').click()`)
    await sleep(800)
    await page(`document.querySelector('#go').click()`)
  }

  try {
    const data = process.env.NAQIE_DATA || ''
    if (!/naqie-t10\.2c[\\/]?$/.test(data)) throw new Error('NAQIE_DATA must be a folder named naqie-t10.2c (the real history is never used)')
    rmSync(data, { recursive: true, force: true })
    await page(`document.body.removeAttribute('data-theater')`)
    check('engine ready with the models', await until(async () => engine.status.status === 'ready' && (await engine.call('/health')).models, 120000), engine.status.gpu?.name)
    await cleanAndPlay(VIDEO)
    check('the player opens with the 5 min video', await until(watching, 120000))
    await until(async () => (await stats()).firstPlaying !== null, 60000)
    await sleep(3000)
    const idA = (await stats()).id
    // A covered window shows no frames (the sync would measure Windows, not Naqi): kept in front, like the full self-test
    win.setAlwaysOnTop(true)
    win.moveTop()

    // Back: Home, the item goes on in the corner
    await click('#watch-back', 100)
    const entering = await page(`document.querySelector('#corner').classList.contains('is-entering')`)
    await sleep(500)
    check('Back: Home shows, the corner holds the item', await home() && await corner() && (await stats()).id === idA)
    check('... it rises in (Back is a click)', entering)
    check('... the picture moved into the corner and shows', (await picIn()) === 'corner-pic' &&
      (await page(`document.querySelector('#corner').dataset.picture`)) === 'shown')
    check('... the sound goes on', await moving())
    check('... the corner says Pause', await pressed('#corner-play'))
    await themed('home-corner')

    // Sync in the corner
    await sleep(1000)
    const n0 = (await stats()).sync.length
    await sleep(SYNC_S * 1000)
    const s = await stats()
    const sync = s.sync.slice(n0)
    const abs = sync.map(([, e]) => Math.abs(e)).sort((a, b) => a - b)
    const pick = (q) => abs[Math.min(abs.length - 1, Math.floor(q * abs.length))] || 0
    const span = sync.length ? sync.at(-1)[0] - sync[0][0] : 0
    writeFileSync(join(outDir, 'sync.json'), JSON.stringify(sync))
    check('sync in the corner within 0.05 s', abs.length > SYNC_S * 20 && abs.at(-1) <= 0.05 && s.corner,
      `${abs.length} frames over ${span.toFixed(0)} s: median ${(pick(0.5) * 1000).toFixed(0)} ms, 99% ${(pick(0.99) * 1000).toFixed(0)} ms, max ${(abs.at(-1) * 1000).toFixed(0)} ms`)

    // Play / pause in the corner
    await click('#corner-play')
    const paused = (await stats()).paused && !(await pressed('#corner-play'))
    await click('#corner-play')
    check('corner play / pause', paused && !(await stats()).paused && await pressed('#corner-play'))

    // A click on the picture: the full player at the same moment
    const before = (await stats()).at
    await click('#corner-open', 700)
    const after = (await stats()).at
    check('a click on the corner: the full player', await watching() && !(await corner()) && (await picIn()) === 'screen')
    check('... at the same moment, still playing', after >= before && after - before < 1.2 && !(await stats()).paused, `${before.toFixed(2)} -> ${after.toFixed(2)} s`)
    check('... picture shown in the player', (await page(`document.querySelector('#screen').dataset.picture`)) === 'shown' && await moving())

    // The miniplayer button and I: the corner too (I at once, like Escape)
    await click('#mini-toggle', 700)
    check('miniplayer button: the corner, still playing', await home() && await corner() && !(await stats()).paused)
    await click('#corner-open', 700)
    await press('i', 100)
    check('I: the corner at once', await home() && await corner() &&
      !(await page(`document.querySelector('#corner').classList.contains('is-entering')`)))
    await click('#corner-open', 700)

    // Volume like YouTube: the speaker alone, the line slides out on hover and for a moment after Up / Down
    const volW = () => page(`Math.round(document.querySelector('#volume').getBoundingClientRect().width)`)
    const w0 = await volW()
    await click('#mute', 0); await click('#mute', 500)   // muted and back: the mouse stays on the speaker
    const w1 = await volW()
    await shot('volume-open.png')
    await click('.times', 500)   // the mouse leaves (a click on the times does nothing)
    const w2 = await volW()
    await press('Down', 400)
    const w3 = await volW()
    await press('Up', 1800)
    check('volume: hidden, opens on hover, closes after, shows a moment after Up / Down', w0 === 0 && w1 > 60 && w2 === 0 && w3 > 60 && (await volW()) === 0,
      `${w0} / ${w1} / ${w2} / ${w3} / ${await volW()} px`)

    // Escape: the corner, at once (a key does not wait for motion)
    await press('Escape', 100)
    check('Escape: the corner at once', await home() && await corner() &&
      !(await page(`document.querySelector('#corner').classList.contains('is-entering')`)))
    await sleep(400)

    // The report page keeps it; the strip and the corner never play together
    await click('#open-report', 900)
    check('side bar Report a slip: the corner stays, playing', await visible('#report') && await corner() && !(await stats()).paused,
      `paused ${(await stats()).paused}`)
    await click('#recent li[data-id] .lib-row', 300)
    check('the strip gets the file', await until(async () => (await page(`document.querySelector('#strip').dataset.state`)) === 'ready', 20000))
    await click('#strip-play', 600)
    check('the strip plays: the corner pauses', await pressed('#strip-play') && (await stats()).paused && !(await pressed('#corner-play')))
    await themed('report-corner')
    await click('#corner-play', 600)
    check('the corner plays: the strip pauses', !(await pressed('#strip-play')) && !(await stats()).paused)
    await click('#report-back', 700)
    check('Back from the report: Home, the corner stays', await home() && await corner())

    // Report here: the corner waits paused; Back returns to the player at that moment
    await click('#corner-open', 700)
    await click('#gear-toggle', 400)   // Report here is in the settings menu (T10.5)
    await click('#report-here', 900)
    const at1 = (await stats()).at
    check('Report here: the report page, the corner paused', await visible('#report') && await corner() && (await stats()).paused)
    await click('#report-back', 700)
    check('... Back: the player at the same moment', await watching() && !(await corner()) && Math.abs((await stats()).at - at1) < 0.1)
    await click('#player-play', 400)

    // A library row of the same item: back to it at the same moment (not opened again from the start)
    await press('Escape', 600)
    const at2 = (await stats()).at
    await page(`document.querySelector('#lib li[data-id="${idA}"] [data-act="play"]').click()`)
    await sleep(700)
    const at3 = (await stats()).at
    check('its library row: the full player at the same moment', await watching() && !(await corner()) && at3 >= at2 && at3 - at2 < 1.5,
      `${at2.toFixed(2)} -> ${at3.toFixed(2)} s`)

    // A small window
    await press('Escape', 600)
    const size = win.getSize()
    win.setSize(720, 480)
    await sleep(600)
    const fits = await page(`(() => { const r = document.querySelector('#corner').getBoundingClientRect(); return r.right <= innerWidth && r.bottom <= innerHeight && r.left > 0 })()`)
    await shot('small.png')
    check('small window: the corner fits', fits)
    win.setSize(...size)
    await sleep(500)

    // A new Clean and play opens by itself over the corner (a sound only), which then is a slim row
    await cleanAndPlay(SOUND)
    check('a new Clean and play opens the player over the corner', await until(async () => await watching() && (await stats()).id !== idA, 120000) && !(await corner()))
    await until(async () => (await stats()).firstPlaying !== null, 30000)
    await sleep(1500)
    await click('#watch-back', 700)
    check('a sound only in the corner', await corner() && (await page(`document.querySelector('#corner').dataset.kind`)) === 'audio' && await moving())
    await themed('home-corner-sound')

    // Stop closes it
    await click('#corner-close', 600)
    const st = await stats()
    check('Stop: the corner closes, the sound stops, Home stays', !(await corner()) && st.id === null && st.paused && await home(),
      `corner ${await corner()}, id ${st.id}, paused ${st.paused}, home ${await home()}`)
  } catch (e) {
    check('test ran', false, e.stack || e.message)
  } finally {
    win.setAlwaysOnTop(false)
    note(fails ? `${fails} check(s) FAILED` : 'ALL PASSED')
    writeFileSync(join(outDir, 'log.txt'), log.join('\n') + '\n')
    setTimeout(() => app.quit(), 500)
  }
}
