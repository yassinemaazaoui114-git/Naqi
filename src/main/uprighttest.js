import { app, ipcMain } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Dev check for T13.3 (run with NAQI_SELFTEST=upright and NAQIE_DATA pointing to a folder named naqie-t13.3, outside
// OneDrive; empty it before the run, not during: the engine loads yt-dlp from it; GPU + internet, about 3 min): upright pictures on the real page. A 60 s 720x1280 own
// file (samples/vertical/tall_60s.mp4) is cleaned and played: the screen is an upright card shaped like it, as tall as
// the player, in the middle; the bar fits (Miniplayer, Theater, Keys move into the settings menu and work there); the
// same in theater, fullscreen (the picture fills the height), the corner (an upright card) and a small window; sync
// while upright. A wide file still gets the wide player. Then a YouTube Short (NASA, NAQI_TALL_LINK to change it) is
// upright too. The saved theater choice is put back. Log and shots in test_out/t13.3/.
const outDir = join(app.getAppPath(), 'test_out', 't13.3')
const TALL = join(app.getAppPath(), 'samples', 'vertical', 'tall_60s.mp4')
const WIDE = join(app.getAppPath(), 'samples', 'sync_test_5min.mp4')
const LINK = process.env.NAQI_TALL_LINK || 'https://www.youtube.com/shorts/myZ9kn9MIWQ'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function run(win, engine) {
  mkdirSync(outDir, { recursive: true })
  const log = []
  let fails = 0
  let theater0 = null
  const t0 = Date.now()
  const note = (text) => { log.push(`${((Date.now() - t0) / 1000).toFixed(2)} s  ${text}`); console.log('[uprighttest]', text) }
  const check = (name, ok, detail = '') => { fails += !ok; note(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`) }
  const page = (js) => win.webContents.executeJavaScript(js)
  const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(150) } return false }
  const stats = () => page('window.naqiPlayerStats()')
  const shape = () => page('window.naqiShape()')
  const watching = () => page(`!document.querySelector('#watch').hidden`)
  const shot = async (name) => { await sleep(500); writeFileSync(join(outDir, name), (await win.webContents.capturePage()).toPNG()) }
  const press = async (keyCode, wait = 600) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
    if (keyCode.length === 1) win.webContents.sendInputEvent({ type: 'char', keyCode })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
    await sleep(wait)
  }
  // The screen's box against the player's inner box, the picture's own shape, and whether the bar fits
  const measure = () => page(`(() => {
    const s = document.querySelector('#screen').getBoundingClientRect()
    const pl = document.querySelector('.player'); const ps = getComputedStyle(pl); const pr = pl.getBoundingClientRect()
    const innerH = pr.height - parseFloat(ps.paddingTop) - parseFloat(ps.paddingBottom)
    const innerW = pr.width - parseFloat(ps.paddingLeft) - parseFloat(ps.paddingRight)
    const c = document.querySelector('.controls'); const f = document.querySelector('#full-toggle').getBoundingClientRect()
    const shown = (sel) => getComputedStyle(document.querySelector(sel)).display !== 'none'
    return { w: Math.round(s.width), h: Math.round(s.height), ratio: s.width / s.height, fillH: s.height / innerH, fillW: s.width / innerW,
      mid: Math.abs((s.left + s.right) / 2 - (pr.left + pr.right) / 2), card: ps.backgroundColor,
      fits: c.scrollWidth <= c.clientWidth + 1 && f.right <= s.right + 0.5 && f.bottom <= s.bottom + 0.5,
      onBar: ['#keys-toggle', '#mini-toggle', '#theater-toggle', '#gear-toggle', '#full-toggle'].filter(shown).join(' ') }
  })()`)
  const upright = (m, want) => Math.abs(m.ratio - want) < 0.02 && (m.fillH > 0.97 || m.fillW > 0.97) && m.mid < 2
  const syncOver = async (ms) => {
    const n = (await stats()).sync.length
    await sleep(ms)
    const s = (await stats()).sync.slice(n)
    return { n: s.length, max: Math.max(0, ...s.map(([, e]) => Math.abs(e))) }
  }

  try {
    const data = process.env.NAQIE_DATA || ''
    if (!/naqie-t13\.3[\\/]?$/.test(data)) throw new Error('NAQIE_DATA must be a folder named naqie-t13.3 (the real history is never used)')
    theater0 = (await page('window.naqi.getSettings()')).theater ?? null
    await page(`window.naqi.setSettings({ theater: '0' })`)
    await page(`document.body.removeAttribute('data-theater')`)
    check('engine ready with the models', await until(async () => engine.status.status === 'ready' && (await engine.call('/health')).models, 120000), engine.status.gpu?.name)
    ipcMain.removeHandler('choose-files')
    let pick = TALL
    ipcMain.handle('choose-files', () => [pick])
    win.setAlwaysOnTop(true)   // Windows holds fullscreen back for a window that is not in front
    win.moveTop()
    win.focus()

    // ---- An upright own file
    await page(`document.querySelector('#choose').click()`)
    await sleep(800)
    await page(`document.querySelector('#go').click()`)
    check('own upright file: the player opens', await until(watching, 120000))
    check('... the picture shows', await until(async () => (await page(`document.querySelector('#screen').dataset.picture`)) === 'shown', 60000))
    await sleep(600)
    const sh = await shape()
    check('... upright shape from the picture', sh.shape === 'tall' && sh.ratio === '720 / 1280', JSON.stringify(sh))
    let m = await measure()
    check('... the screen is an upright card, as tall as the player, in the middle', upright(m, 720 / 1280), JSON.stringify(m))
    check('... the card around it steps back', m.card === 'rgba(0, 0, 0, 0)', m.card)
    check('... the bar fits: play, volume, time, settings, fullscreen', m.fits && m.onBar === '#gear-toggle #full-toggle', m.onBar)
    await page(`document.querySelector('#screen').dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))`)
    await shot('own-light.png')
    await page(`window.__th = document.documentElement.dataset.theme ?? null; document.documentElement.dataset.theme = 'dark'`)
    await shot('own-dark.png')
    await page(`if (window.__th) document.documentElement.dataset.theme = window.__th; else delete document.documentElement.dataset.theme`)

    // The settings menu has the three that left the bar, and they work
    await page(`document.querySelector('#gear-toggle').click()`)
    await sleep(400)
    const items = await page(`[...document.querySelectorAll('.gear-narrow')].filter((b) => b.getClientRects().length).map((b) => b.id).join(' ')`)
    check('settings menu: Miniplayer, Theater mode, Keys', items === 'gear-mini gear-theater gear-keys', items)
    const menuIn = await page(`(() => { const g = document.querySelector('#gear-menu').getBoundingClientRect(); const s = document.querySelector('#screen').getBoundingClientRect(); return g.left >= s.left - 0.5 && g.right <= s.right + 0.5 })()`)
    check('... the menu stays inside the upright screen', menuIn)
    await shot('own-menu.png')
    await page(`document.querySelector('#gear-theater').click()`)
    await sleep(700)
    check('... Theater mode from the menu', await page(`document.body.hasAttribute('data-theater')`) &&
      (await page(`document.querySelector('#gear-theater').getAttribute('aria-checked')`)) === 'true')
    m = await measure()
    check('theater: still upright and as tall as the player', upright(m, 720 / 1280), JSON.stringify(m))
    await shot('own-theater.png')
    await page(`document.querySelector('#gear-theater').click()`)
    await sleep(700)
    check('... and back from the menu', !(await page(`document.body.hasAttribute('data-theater')`)))
    await page(`document.querySelector('#gear-keys').click()`)
    await sleep(400)
    check('... Keys from the menu opens the keys card', await page(`document.querySelector('#keys-card').matches(':popover-open')`))
    const keysIn = await page(`(() => { const k = document.querySelector('#keys-card').getBoundingClientRect(); return k.left >= 0 && k.right <= innerWidth && k.top >= 0 && k.bottom <= innerHeight })()`)
    check('... inside the window', keysIn)
    await shot('own-keys.png')
    await press('Escape')
    if (!(await watching())) await page(`document.querySelector('#corner-open').click()`)
    await sleep(600)

    // Fullscreen: the whole display, the picture fills its height
    await press('f', 1200)
    const fs = await page(`(() => { const s = document.querySelector('#screen').getBoundingClientRect(); const v = document.querySelector('#picture'); return { el: document.fullscreenElement?.id, w: s.width, h: s.height, sw: screen.width, sh: screen.height, vh: v.getBoundingClientRect().height } })()`)
    check('fullscreen: the whole display, the picture fills its height', fs.el === 'screen' && Math.abs(fs.w - fs.sw) < 2 && Math.abs(fs.vh - fs.sh) < 2, JSON.stringify(fs))
    await page(`document.querySelector('#screen').dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))`)
    await shot('own-fullscreen.png')
    const fsync = await syncOver(15000)
    check('... in sync (15 s)', fsync.n > 100 && fsync.max <= 0.05, `${fsync.n} frames, max ${(fsync.max * 1000).toFixed(0)} ms`)
    await press('f', 1200)
    m = await measure()
    check('... back: upright card again', !(await page('document.fullscreenElement')) && upright(m, 720 / 1280), JSON.stringify(m))
    const nsync = await syncOver(15000)
    check('upright card: in sync (15 s)', nsync.n > 100 && nsync.max <= 0.05, `${nsync.n} frames, max ${(nsync.max * 1000).toFixed(0)} ms`)

    // The corner: an upright small card
    await press('Escape', 900)
    const cn = await page(`(() => { const c = document.querySelector('#corner'); const r = c.querySelector('.corner-screen').getBoundingClientRect(); return { shown: !c.hidden, shape: c.dataset.shape, ratio: r.width / r.height, w: Math.round(c.getBoundingClientRect().width), inside: r.top >= 0 } })()`)
    check('corner: an upright card', cn.shown && cn.shape === 'tall' && Math.abs(cn.ratio - 720 / 1280) < 0.02 && cn.inside, JSON.stringify(cn))
    await shot('own-corner.png')
    const csync = await syncOver(10000)
    check('... in sync (10 s)', csync.n > 50 && csync.max <= 0.05, `${csync.n} frames, max ${(csync.max * 1000).toFixed(0)} ms`)
    await page(`document.querySelector('#corner-open').click()`)
    await sleep(800)
    check('... back to the upright player', await watching() && upright(await measure(), 720 / 1280))

    // A small window
    const size = win.getSize()
    win.setSize(720, 480)
    await sleep(900)
    m = await measure()
    // Too low for an upright card its bar fits on: the card keeps the bar's width (280 px), the picture has thin sides
    const small = (m) => m.w >= 279 && m.fillH > 0.97 && m.mid < 2 && m.fits
    check('small window: as tall as the player, at least the bar wide, the bar fits', small(m), JSON.stringify(m))
    await page(`document.querySelector('#screen').dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))`)
    await shot('own-small.png')
    await press('t', 800)
    m = await measure()
    check('small window, theater: the same', await page(`document.body.hasAttribute('data-theater')`) && small(m), JSON.stringify(m))
    await shot('own-small-theater.png')
    await press('t', 800)
    win.setSize(...size)
    await sleep(800)

    // ---- A wide file still gets the wide player
    await press('Escape', 600)
    await page(`document.querySelector('#corner-close')?.click()`)
    await sleep(800)
    pick = WIDE
    await page(`document.querySelector('#choose').click()`)
    await sleep(800)
    await page(`document.querySelector('#go').click()`)
    check('wide file: the player opens', await until(watching, 120000))
    await until(async () => (await page(`document.querySelector('#screen').dataset.picture`)) === 'shown', 60000)
    await sleep(600)
    m = await measure()
    check('... wide player as before', (await shape()).shape === 'wide' && m.fillW > 0.99 && m.card !== 'rgba(0, 0, 0, 0)' &&
      m.onBar === '#keys-toggle #mini-toggle #theater-toggle #gear-toggle #full-toggle', JSON.stringify(m))
    await shot('wide.png')
    await press('Escape', 600)
    await page(`document.querySelector('#corner-close')?.click()`)
    await sleep(800)

    // ---- A YouTube Short
    await until(() => page(`!document.querySelector('#clear-files').disabled`), 30000)   // the cancelled cleaning has ended
    await page(`document.querySelector('#clear-files')?.click()`)
    await sleep(300)
    await page(`(() => { const u = document.querySelector('#url'); u.value = ${JSON.stringify(LINK)}; u.dispatchEvent(new Event('input')) })()`)
    await sleep(300)
    await page(`document.querySelector('#go').click()`)
    check('Short: the player opens', await until(watching, 120000))
    check('... the streamed picture shows', await until(async () => (await page(`document.querySelector('#screen').dataset.picture`)) === 'shown', 90000))
    await sleep(800)
    const ls = await shape()
    m = await measure()
    check('... upright card shaped like the stream', ls.shape === 'tall' && upright(m, ls.w / ls.h), `${ls.w}x${ls.h} ${JSON.stringify(m)}`)
    await page(`document.querySelector('#screen').dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))`)
    await shot('link.png')
    await press('t', 800)
    check('... theater: upright', await page(`document.body.hasAttribute('data-theater')`) && upright(await measure(), ls.w / ls.h))
    await shot('link-theater.png')
    await press('t', 800)
    check('... back from theater', !(await page(`document.body.hasAttribute('data-theater')`)))
    await press('f', 300)
    // The window takes a moment to become the whole display
    const fills = () => page(`(() => { const v = document.querySelector('#picture'); return { el: document.fullscreenElement?.id, vh: v.getBoundingClientRect().height, sh: screen.height } })()`)
    await until(async () => { const f = await fills(); return f.el === 'screen' && Math.abs(f.vh - f.sh) < 2 }, 5000)
    const lf = await fills()
    check('... fullscreen: the picture fills the height', lf.el === 'screen' && Math.abs(lf.vh - lf.sh) < 2, JSON.stringify(lf))
    await shot('link-fullscreen.png')
    await press('f', 1200)
    await press('Escape', 900)
    const lc = await page(`(() => { const c = document.querySelector('#corner'); const r = c.querySelector('.corner-screen').getBoundingClientRect(); return { shape: c.dataset.shape, ratio: r.width / r.height } })()`)
    check('... corner: upright', lc.shape === 'tall' && Math.abs(lc.ratio - ls.w / ls.h) < 0.02, JSON.stringify(lc))
    await shot('link-corner.png')
    await page(`document.querySelector('#corner-close')?.click()`)
    await sleep(800)
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
