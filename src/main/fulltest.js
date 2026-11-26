import { app, ipcMain } from 'electron'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Dev check for T10.2 (run with NAQI_SELFTEST=full and NAQIE_DATA pointing to a folder named naqie-t10.2, outside
// OneDrive; it is emptied first; GPU, about 7 min): fullscreen and theater mode on the real page, with real mouse and
// key events. Theater: its button and T hide the library and widen the player, come back, stay remembered when the
// player opens again, and the library shows on Home. Fullscreen: its button, a double click on the picture (not on
// the bar), F and Escape; the theater button and T step aside there. Then the whole 5 min file plays in fullscreen
// and its picture/sound sync is measured. Light / dark / small window shots. Log, shots and sync data in test_out/t10.2/.
const outDir = join(app.getAppPath(), 'test_out', 't10.2')
const SAMPLE = join(app.getAppPath(), 'samples', 'sync_test_5min.mp4')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function run(win, engine) {
  mkdirSync(outDir, { recursive: true })
  const log = []
  let fails = 0
  let theater0 = null
  let sidebar0 = null
  const t0 = Date.now()
  const note = (text) => { log.push(`${((Date.now() - t0) / 1000).toFixed(2)} s  ${text}`); console.log('[fulltest]', text) }
  const check = (name, ok, detail = '') => { fails += !ok; note(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`) }
  const page = (js) => win.webContents.executeJavaScript(js)
  const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(150) } return false }
  const stats = () => page('window.naqiPlayerStats()')
  const watching = () => page(`!document.querySelector('#watch').hidden`)
  const full = () => page('document.fullscreenElement?.id || null')
  const theaterOn = () => page(`document.body.hasAttribute('data-theater')`)
  // The width on screen: the library slides off the left edge when it goes (T11.1), it does not shrink
  const width = (sel) => page(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return getComputedStyle(document.querySelector(${JSON.stringify(sel)})).visibility === 'hidden' ? 0 : Math.round(Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0))) })()`)
  const shot = async (name) => { await sleep(400); writeFileSync(join(outDir, name), (await win.webContents.capturePage()).toPNG()) }
  const press = async (keyCode, modifiers = [], wait = 250) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    if (keyCode.length === 1) win.webContents.sendInputEvent({ type: 'char', keyCode, modifiers })
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
  const clickButton = async (sel) => { await move(await center('#screen')); await move(await center(sel)); await click(await center(sel)) }
  const tipOf = (sel) => page(`document.querySelector(${JSON.stringify(sel)}).getAttribute('aria-label')`)

  try {
    const data = process.env.NAQIE_DATA || ''
    if (!/naqie-t10\.2[\\/]?$/.test(data)) throw new Error('NAQIE_DATA must be a folder named naqie-t10.2 (the real history is never used)')
    rmSync(data, { recursive: true, force: true })
    theater0 = (await page('window.naqi.getSettings()')).theater ?? null
    await page(`window.naqi.setSettings({ theater: '0' })`)
    await page(`document.body.removeAttribute('data-theater')`)
    // Theater is measured from the library open (T11.1 can fold it): opened here, the choice put back at the end
    sidebar0 = (await page(`window.naqi.getSettings()`)).sidebar ?? null
    if (await page(`document.body.dataset.side === 'closed'`)) await page(`document.querySelector('#rail-open').click(); document.activeElement.blur()`)
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

    // Theater mode
    const side0 = await width('.side')
    const watch0 = await width('#watch')
    await move(await center('#screen'))
    await move(await center('#theater-toggle'))
    await click(await center('#theater-toggle'), 1, 0)
    const mid = await page(`new Promise((r) => setTimeout(() => r(Math.round(Math.max(0, document.querySelector('.side').getBoundingClientRect().right))), 120))`)
    await sleep(500)
    const side1 = await width('.side')
    const watch1 = await width('#watch')
    check('theater button: library hidden, player wider', await theaterOn() && side1 === 0 && watch1 > watch0,
      `library ${side0} -> ${mid} (mid-way) -> ${side1} px, player ${watch0} -> ${watch1} px`)
    check('... the library folds away in steps (not a jump)', mid > 0 && mid < side0, `${mid} px after 120 ms`)
    check('... the button says the way back', (await tipOf('#theater-toggle')) === 'Default view (T)' &&
      (await page(`document.querySelector('#theater-toggle').getAttribute('aria-pressed')`)) === 'true')
    check('... nothing in the hidden library takes focus', await page(`getComputedStyle(document.querySelector('.side')).visibility === 'hidden'`))
    check('... remembered', (await page('window.naqi.getSettings()')).theater === '1')
    for (const t of ['light', 'dark']) {
      await page(`document.documentElement.dataset.theme = '${t}'`)
      await move(await center('#screen'))
      await shot(`theater-${t}.png`)
    }
    await page(`delete document.documentElement.dataset.theme`)
    await press('t', [], 600)
    check('T: back to the default view', !(await theaterOn()) && (await width('.side')) === side0 && (await width('#watch')) === watch0)
    await press('t', [], 600)
    check('T again: theater', await theaterOn())
    await press('Escape', [], 700)
    check('Home: the library is back', !(await watching()) && !(await theaterOn()) && (await width('.side')) === side0)
    await page(`document.querySelector('#lib li[data-id] [data-act="play"]').click()`)
    await until(watching, 10000)
    await sleep(600)
    check('the player opens again in theater mode', await theaterOn() && (await width('.side')) === 0)
    await clickButton('#theater-toggle')
    await sleep(500)
    check('theater button again: default view', !(await theaterOn()) && (await page('window.naqi.getSettings()')).theater === '0')

    // Fullscreen
    await clickButton('#full-toggle')
    check('fullscreen button: fullscreen', await until(async () => (await full()) === 'screen', 10000))
    await sleep(800)
    check('... the button says the way back', (await tipOf('#full-toggle')) === 'Leave fullscreen (F)' &&
      (await page(`document.querySelector('#full-toggle').getAttribute('aria-pressed')`)) === 'true')
    check('... the theater button steps aside', await page(`getComputedStyle(document.querySelector('#theater-toggle')).display === 'none'`))
    await press('t')
    check('... and T does nothing there', !(await theaterOn()) && (await full()) === 'screen')
    // The mouse stays where the button was (the bar moved away under it) and a key was pressed: the bar still hides
    const t1 = Date.now()
    const hid1 = await until(async () => (await page(`document.querySelector('#screen').dataset.bar`)) === 'hidden', 8000)
    check('... the bar hides after the button click and a key, mouse still', hid1, `${((Date.now() - t1) / 1000).toFixed(1)} s, focus on ${await page('document.activeElement.id')}`)
    await move(await center('#screen'))
    await shot('fullscreen.png')
    await clickButton('#full-toggle')
    check('fullscreen button again: back', await until(async () => (await full()) === null && !win.isFullScreen(), 10000))
    await sleep(1000)
    await move(await center('#screen'))
    await click(await center('#screen'), 2, 300)
    check('double click on the picture: fullscreen', await until(async () => (await full()) === 'screen', 10000))
    await sleep(1000)
    await move(await center('#screen'))
    await click(await center('#screen'), 2, 300)
    check('double click again: back', await until(async () => (await full()) === null && !win.isFullScreen(), 10000))
    await sleep(1000)
    await move(await center('#screen'))
    await click(await center('.times'), 2, 600)
    check('a double click on the bar does not', (await full()) === null)
    const playing = () => page(`document.querySelector('#player-play').getAttribute('aria-pressed') === 'true'`)
    const was = await playing()
    await click(await center('#screen'), 1, 400)
    const once = await playing()
    await click(await center('#screen'), 1, 400)
    check('one click on the picture pauses, one more plays', was && !once && await playing())
    await press('f')
    check('F: fullscreen', await until(async () => (await full()) === 'screen', 10000))
    // The bar in fullscreen: hides 3 s after the last action (keyboard focus on it does not hold it), a key, a mouse
    // move or a click brings it back
    const barState = () => page(`document.querySelector('#screen').dataset.bar`)
    let from = Date.now()
    const hid = await until(async () => (await barState()) === 'hidden', 8000)
    check('fullscreen: the bar hides after about 3 s', hid && Date.now() - from > 2500, `${((Date.now() - from) / 1000).toFixed(1)} s, focus on ${await page('document.activeElement.id')}`)
    await press('Right', [], 100)
    check('... a key brings it back', (await barState()) === 'shown')
    from = Date.now()
    await until(async () => (await barState()) === 'hidden', 8000)
    check('... and it hides again', (await barState()) === 'hidden', `${((Date.now() - from) / 1000).toFixed(1)} s`)
    const fmid = await center('#screen')
    await move([fmid[0] + 20, fmid[1] - 20])
    check('... a mouse move brings it back', (await barState()) === 'shown')
    await until(async () => (await barState()) === 'hidden', 8000)
    await click(fmid, 1, 400)
    check('... one click brings it back and pauses', (await barState()) === 'shown' && (await page(`document.querySelector('#player-play').getAttribute('aria-pressed')`)) === 'false')
    await shot('fullscreen-paused.png')
    await click(fmid, 1, 400)
    check('... one more click plays again (still fullscreen)', (await page(`document.querySelector('#player-play').getAttribute('aria-pressed')`)) === 'true' && (await full()) === 'screen')
    await sleep(1000)
    await press('Escape')
    check('Escape leaves it and keeps the player', await until(async () => (await full()) === null && !win.isFullScreen(), 10000) && await watching())
    await sleep(1000)

    // Sync in fullscreen: the whole 5 min once all of it is clean, from the start (NAQI_QUICK=1 skips it)
    if (!process.env.NAQI_QUICK) {
      check('cleaning done', await until(async () => !(await stats()).live, 180000))
      await page(`document.querySelector('#timebar').focus()`)
      for (let i = 0; i < 40; i++) await press('j', [], 30)
      await page(`document.activeElement.blur()`)
      await sleep(800)
      await move(await center('#screen'))
      await click(await center('#screen'), 2, 300)
      check('fullscreen for the sync run', await until(async () => (await full()) === 'screen', 10000), `from ${(await stats()).at.toFixed(1)} s`)
      const n0 = (await stats()).sync.length
      const len = (await stats()).length
      let outAt = null
      const ended = await until(async () => {
        if (outAt === null && (await full()) !== 'screen') outAt = (await stats()).at
        return page(`document.querySelector('#player-play').getAttribute('aria-pressed') !== 'true'`)
      }, (len + 60) * 1000)
      const s = await stats()
      check('played to the end in fullscreen', ended && s.at > len - 1 && outAt === null, `at ${s.at.toFixed(1)} of ${len.toFixed(1)} s${outAt !== null ? `, left fullscreen at ${outAt.toFixed(1)} s` : ''}`)
      const sync = s.sync.slice(n0)
      const abs = sync.map(([, e]) => Math.abs(e)).sort((a, b) => a - b)
      const pick = (q) => abs[Math.min(abs.length - 1, Math.floor(q * abs.length))] || 0
      const span = sync.length ? sync.at(-1)[0] - sync[0][0] : 0
      writeFileSync(join(outDir, 'sync.json'), JSON.stringify(sync))
      check('sync in fullscreen within 0.05 s', abs.length > 1000 && abs.at(-1) <= 0.05,
        `${abs.length} frames over ${span.toFixed(0)} s: median ${(pick(0.5) * 1000).toFixed(0)} ms, 99% ${(pick(0.99) * 1000).toFixed(0)} ms, max ${(abs.at(-1) * 1000).toFixed(0)} ms`)
      await press('Escape')
      await until(async () => (await full()) === null && !win.isFullScreen(), 10000)
      await sleep(800)

    }
    // A small window: the two new buttons still fit on the bar
    const size = win.getSize()
    win.setSize(720, 480)
    await sleep(600)
    await move(await center('#screen'))
    await shot('small.png')
    const fits = await page(`(() => { const c = document.querySelector('.controls'); const s = document.querySelector('#screen').getBoundingClientRect(); const k = document.querySelector('#full-toggle').getBoundingClientRect(); return { ok: c.scrollWidth <= c.clientWidth + 1 && k.right <= s.right && k.bottom <= s.bottom, need: c.scrollWidth, has: c.clientWidth, button: Math.round(k.right), screen: Math.round(s.right), parts: [...c.children].filter((e) => e.offsetWidth).map((e) => (e.id || e.className.split(' ').at(-1)) + ' ' + e.offsetWidth).join(', ') } })()`)
    check('small window: everything fits on the bar', fits.ok, JSON.stringify(fits))
    await clickButton('#theater-toggle')
    await sleep(500)
    await shot('small-theater.png')
    check('small window: theater works too', await theaterOn() && (await width('.side')) === 0)
    await clickButton('#theater-toggle')
    win.setSize(...size)
    await sleep(400)
  } catch (e) {
    check('test ran', false, e.stack || e.message)
  } finally {
    win.setAlwaysOnTop(false)
    // The saved theater choice is put back as it was
    await page(`window.naqi.setSettings({ theater: ${JSON.stringify(theater0 ?? '0')} })`).catch(() => {})
    if (sidebar0) await page(`window.naqi.setSettings({ sidebar: ${JSON.stringify(sidebar0)} })`).catch(() => {})
    note(fails ? `${fails} check(s) FAILED` : 'ALL PASSED')
    writeFileSync(join(outDir, 'log.txt'), log.join('\n') + '\n')
    setTimeout(() => app.quit(), 500)
  }
}
