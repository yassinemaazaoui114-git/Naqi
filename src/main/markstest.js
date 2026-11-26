import { app, ipcMain } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Dev check for T10.5d (run with NAQI_SELFTEST=marks and NAQIE_DATA pointing to an empty folder named naqie-t10.5d,
// outside OneDrive; GPU, about 2 min): Muted marks on / off in the gear menu. samples/mutes_5min.mp4 (speech over
// music, its cleaning mutes about 31 parts) is cleaned and played; the switch is flipped by mouse: off the time bar
// has no pinches and hovering a muted part gives only the time, on they are back. The choice is saved, and after the
// window is loaded again (a restart of the page) it is still off and the item opens with a plain bar. The real
// setting is put back. Log and screenshots in test_out/t10.5d/.
const outDir = join(app.getAppPath(), 'test_out', 't10.5d')
const SAMPLE = join(app.getAppPath(), 'samples', 'mutes_5min.mp4')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function run(win, engine) {
  mkdirSync(outDir, { recursive: true })
  const log = []
  let fails = 0
  let realMarks = null
  const t0 = Date.now()
  const note = (text) => { log.push(`${((Date.now() - t0) / 1000).toFixed(2)} s  ${text}`); console.log('[markstest]', text) }
  const check = (name, ok, detail = '') => { fails += !ok; note(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`) }
  win.webContents.on('console-message', (e) => { if (e.level === 'error') note(`page error: ${e.message}`) })
  const page = (js) => win.webContents.executeJavaScript(js)
  const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(150) } return false }
  const stats = () => page('window.naqiPlayerStats()')
  const watching = () => page(`!document.querySelector('#watch').hidden`)
  const shot = async (name) => {
    await sleep(400)
    try { writeFileSync(join(outDir, name), (await win.webContents.capturePage()).toPNG()) } catch (e) { note(`no screenshot ${name}: ${e.message}`) }
  }
  const mask = () => page(`document.querySelector('#timebar-lines').style.getPropertyValue('--muted-mask')`)
  const checked = () => page(`document.querySelector('#gear-marks').getAttribute('aria-checked')`)
  const press = async (keyCode, wait = 250) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
    await sleep(wait)
  }
  const center = (sel) => page(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] })()`)
  const move = async ([x, y]) => { win.webContents.sendInputEvent({ type: 'mouseMove', x, y }); await sleep(200) }
  const click = async ([x, y], wait = 400) => {
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    await sleep(wait)
  }
  // The gear and the switch get real clicks when the window paints; when it does not (the screen is off, so
  // Windows gives it no frames and mouse events find nothing), the same handlers are run by a page click
  let painting = true
  const flip = async () => {
    if (painting) {
      await move(await center('#screen'))
      await move(await center('#gear-toggle'))
      await click(await center('#gear-toggle'), 500)
      await move(await center('#gear-marks'))
      await click(await center('#gear-marks'), 500)
    } else {
      await page(`document.querySelector('#gear-toggle').click()`)
      await sleep(400)
      await page(`document.querySelector('#gear-marks').click()`)
      await sleep(300)
    }
    const c = await checked()
    await press('Escape', 300)
    return c
  }
  // Hover the longest muted part: is it bracketed, and what does the tip say?
  const hover = async () => {
    const s = await stats()
    await move(await center('#screen'))   // the bar comes back first, then it is measured
    await sleep(500)
    const [a, b] = s.mutes.parts.reduce((m, x) => (x[1] - x[0] > m[1] - m[0] ? x : m))
    const r = await page(`(() => { const r = document.querySelector('#timebar').getBoundingClientRect(); return { x: r.left, y: r.top + r.height / 2, w: r.width } })()`)
    const x = Math.round(r.x + (r.w * (a + b)) / 2 / s.length)
    const y = Math.round(r.y)
    if (painting) {
      await move([Math.round(r.x + r.w / 2), Math.round(r.y - 60)])
      await move([x, y])
    } else {
      await page(`document.querySelector('#timebar').dispatchEvent(new PointerEvent('pointermove', { clientX: ${x}, clientY: ${y}, bubbles: true }))`)
      await sleep(200)
    }
    return page(`({ on: document.querySelector('#timebar-span').dataset.on, tip: document.querySelector('#timebar-tip').textContent })`)
  }

  try {
    const data = process.env.NAQIE_DATA || ''
    if (!/naqie-t10\.5d[\\/]?$/.test(data)) throw new Error('NAQIE_DATA must be a folder named naqie-t10.5d (the real history is never used)')
    realMarks = (await page('window.naqi.getSettings()')).marks ?? null
    await page(`window.naqi.setSettings({ marks: '1' }).then(() => {})`)
    check('engine ready with the models', await until(async () => engine.status.status === 'ready' && (await engine.call('/health')).models, 120000), engine.status.gpu?.name)
    if (win.isMinimized()) win.restore()
    win.show()
    win.setAlwaysOnTop(true)
    win.moveTop()
    win.focus()
    note(`window: visible ${win.isVisible()}, minimized ${win.isMinimized()}, focused ${win.isFocused()}`)
    ipcMain.removeHandler('choose-files')
    ipcMain.handle('choose-files', () => [SAMPLE])
    await page(`document.querySelector('#choose').click()`)
    await sleep(800)
    await page(`document.querySelector('#go').click()`)
    check('the player opens with the 5 min video', await until(watching, 120000))
    // Does the window paint? A frame must come within 2 s
    painting = await page(`new Promise((r) => { requestAnimationFrame(() => r(true)); setTimeout(() => r(false), 2000) })`)
    note(painting ? 'the window paints: real mouse clicks and hover' : 'the window does not paint (screen off?): page clicks and pointer events')
    check('cleaning done', await until(async () => !(await stats()).live && (await stats()).mutes.parts.length >= 25, 240000), `${(await stats()).mutes.parts.length} muted parts`)

    // On (the default): pinches drawn, hover brackets a part
    check('on by default: the switch is on', (await checked()) === 'true')
    check('... the marks are drawn', (await mask()).startsWith('url('))
    let h = await hover()
    check('... hovering a muted part brackets it', h.on === 'true' && h.tip.startsWith('Muted '), `"${h.tip}"`)
    await shot('on.png')

    // Off by mouse: plain bar, hover gives only the time, saved
    check('the gear switch turns them off', (await flip()) === 'false')
    check('... no marks on the bar', !(await mask()))
    h = await hover()
    check('... hovering gives only the time', h.on === 'false' && /^\d+:\d\d$/.test(h.tip), `"${h.tip}"`)
    await shot('off.png')
    check('... saved', (await page('window.naqi.getSettings()')).marks === '0')

    // On again
    check('the switch turns them on again', (await flip()) === 'true')
    check('... the marks are back', (await mask()).startsWith('url('))
    check('... saved', (await page('window.naqi.getSettings()')).marks === '1')

    // Off, then the page loaded again: still off, and the item opens with a plain bar
    await flip()
    await page(`document.querySelector('#watch-back').click()`)
    await sleep(600)
    win.webContents.reload()
    await new Promise((r) => win.webContents.once('did-finish-load', r))
    await until(() => page(`!!document.querySelector('#lib li[data-id] [data-act="play"]')`), 20000)
    check('after a restart the switch is still off', (await checked()) === 'false')
    await page(`document.querySelector('#lib li[data-id] [data-act="play"]').click()`)
    check('... the item opens', await until(watching, 30000))
    check('... its muted parts are read', await until(async () => (await stats()).mutes.parts.length >= 25, 15000))
    await sleep(500)
    check('... and the bar stays plain', !(await mask()))
    await move(await center('#screen'))
    await shot('after-restart.png')
    check('... turned on there, the marks show', (await flip()) === 'true' && (await mask()).startsWith('url('))
  } catch (e) {
    check('test ran', false, e.stack || e.message)
  } finally {
    await page(`window.naqi.setSettings({ marks: ${JSON.stringify(realMarks ?? '1')} }).then(() => {})`).catch(() => {})
    win.setAlwaysOnTop(false)
    note(fails ? `${fails} check(s) FAILED` : 'ALL PASSED')
    writeFileSync(join(outDir, 'log.txt'), log.join('\n') + '\n')
    setTimeout(() => app.quit(), 500)
  }
}
