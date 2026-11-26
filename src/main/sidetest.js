import { app, nativeTheme } from 'electron'
import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Dev check for T11.1 (run with NAQI_SELFTEST=side and NAQIE_DATA pointing to a folder named naqie-t11.1, outside
// OneDrive; it is emptied first): the library side bar that folds away. A seeded history (engine/seed_library.py)
// fills the list, then: the button folds it (in steps, not a jump) to the strip and Naqi remembers it, a hover on the
// strip slides it out over the page and leaving puts it back, the strip's search and Report a slip, a press on the
// page, Escape, Ctrl+B (at once), pinning it from the hover, a page reload keeping it folded, theater's left edge, a
// small window. Real mouse and key events. The real setting is put back. Log and shots in test_out/t11.1/.
const outDir = join(app.getAppPath(), 'test_out', 't11.1')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function run(win, engine) {
  mkdirSync(outDir, { recursive: true })
  const log = []
  let fails = 0
  const t0 = Date.now()
  const note = (text) => { log.push(`${((Date.now() - t0) / 1000).toFixed(2)} s  ${text}`); console.log('[sidetest]', text) }
  const check = (name, ok, detail = '') => { fails += !ok; note(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`) }
  const page = (js) => win.webContents.executeJavaScript(js)
  const shot = async (name) => { await sleep(450); writeFileSync(join(outDir, name), (await win.webContents.capturePage()).toPNG()) }
  const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(100) } return false }
  const move = async ([x, y], wait = 120) => { win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) }); await sleep(wait) }
  const click = async ([x, y], wait = 300) => {
    win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    await sleep(wait)
  }
  const center = (sel) => page(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()`)
  const key = async (keyCode, modifiers = [], wait = 150) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await sleep(wait)
  }
  // Where the page column starts (the library's column), how much of the library is on screen, and its left edge
  const state = () => page(`(() => {
    const s = document.querySelector('.side').getBoundingClientRect()
    const b = document.body
    return { col: Math.round(document.querySelector('.content').getBoundingClientRect().left),
      shown: getComputedStyle(document.querySelector('.side')).visibility === 'hidden' ? 0 : Math.round(Math.max(0, Math.min(s.right, innerWidth) - Math.max(s.left, 0))), left: Math.round(s.left),
      folded: b.dataset.side === 'closed', peek: b.hasAttribute('data-peek'),
      hidden: getComputedStyle(document.querySelector('.side')).visibility === 'hidden',
      rail: getComputedStyle(document.querySelector('#rail')).visibility === 'visible',
      focus: document.activeElement?.id || document.activeElement?.tagName }
  })()`)
  // Every frame for a while: the gap between the library's right edge and the page column's edge (the two must move as
  // one piece while folding and opening), and how many frames moved
  const track = (ms) => page(`new Promise((done) => {
    const end = performance.now() + ${ms}
    let gap = 0, frames = 0, moved = 0, clipped = 0, last = null
    const step = () => {
      // The library's edge as seen: its box, less what its clip hides (the button's strip-grows motion)
      const sideEl = document.querySelector('.side')
      const clip = /inset\\(([^)]*)\\)/.exec(getComputedStyle(sideEl).clipPath)
      const cut = clip ? (clip[1].trim().split(/\\s+/).map(parseFloat)[1] ?? parseFloat(clip[1])) : 0
      const edge = sideEl.getBoundingClientRect().right - cut
      if (clip) clipped++
      const col = document.querySelector('.content').getBoundingClientRect().left
      gap = Math.max(gap, Math.abs(edge - col)); frames++
      if (last !== null && col !== last) moved++
      last = col
      if (performance.now() < end) requestAnimationFrame(step); else done({ gap: Math.round(gap * 10) / 10, frames, moved, clipped })
    }
    requestAnimationFrame(step)
  })`)
  const saved = async () => (await page('window.naqi.getSettings()')).sidebar
  const farRight = async () => { const [w, h] = win.getContentSize(); return [w - 60, h / 2] }
  const theme = nativeTheme.themeSource
  let before = null

  try {
    const data = process.env.NAQIE_DATA || ''
    if (!/naqie-t11\.1[\\/]?$/.test(data)) throw new Error('NAQIE_DATA must be a folder named naqie-t11.1 (the real history is never used)')
    before = (await saved()) || 'open'
    check('engine ready', await until(() => engine.status.status === 'ready', 90000), engine.status.gpu?.name)
    await new Promise((resolve, reject) => execFile('py', ['-3.12', join(app.getAppPath(), 'engine', 'seed_library.py'), join(outDir, 'files')],
      { env: process.env, windowsHide: true }, (err, _out, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve())))
    await page(`window.dispatchEvent(new Event('focus'))`)
    await until(() => page(`document.querySelectorAll('#lib li[data-id]').length > 3`), 5000)
    await sleep(2500)   // the launch intro has gone
    if ((await state()).folded) { await click(await center('#rail-open'), 600) }
    await page(`document.documentElement.dataset.theme = 'light'`)
    const open0 = await state()
    check('at first: the library open in its column, no strip', !open0.folded && open0.shown > 200 && open0.col === open0.shown && !open0.rail, JSON.stringify(open0))
    await shot('1-open-light.png')

    // The button folds it: the library slides off while the page column narrows to the strip
    await move(await center('#side-toggle'))
    const folding = track(700)
    await click(await center('#side-toggle'), 0)
    await sleep(160)
    const mid = await state()
    const fold = await folding
    const shut = await state()
    check('the button folds the library to the strip', shut.folded && shut.shown === 0 && shut.hidden && shut.rail && shut.col === 60, JSON.stringify(shut))
    check('... in steps, not a jump', mid.col > 60 && mid.col < open0.col && fold.moved > 10, `column ${open0.col} -> ${mid.col} (160 ms) -> ${shut.col} px, ${fold.moved} of ${fold.frames} frames moved`)
    check("... the library's edge and the page's edge move as one (no gap)", fold.gap <= 1, `largest gap ${fold.gap} px`)
    const opening = track(700)
    await click(await center('#rail-open'), 0)
    await sleep(170)
    const parts = await page(`[...document.querySelectorAll('.side [data-grow]')].map((el) => Number(getComputedStyle(el).opacity).toFixed(2))`)
    const unfold = await opening
    const reopened = await state()
    check("the strip's button opens it the same way (no gap)", !reopened.folded && reopened.col === open0.col && unfold.moved > 10 && unfold.gap <= 1,
      `largest gap ${unfold.gap} px, ${unfold.moved} of ${unfold.frames} frames moved`)
    check('... the strip grows into it (its edge uncovered, not slid in)', unfold.clipped > 10, `${unfold.clipped} frames clipped`)
    check('... its parts come in one after another', parts.length >= 4 && Number(parts[0]) > Number(parts.at(-1)), `opacity at 170 ms: ${parts.join(' ')}`)
    check('... and settle', await page(`!document.querySelector('.side [data-grow]') && getComputedStyle(document.querySelector('.side')).clipPath === 'none'`))
    await move(await center('#side-toggle'))
    await click(await center('#side-toggle'), 700)
    check('... the focus moves to the strip\'s button', shut.focus === 'rail-open', shut.focus)
    check('... remembered', (await saved()) === 'closed')
    await move(await farRight())
    await shot('2-folded-light.png')

    // Hover: out over the page (the page does not move), back when the mouse leaves
    const [rx] = await center('#rail')
    const logo = await center('.rail-logo')
    const report = await center('#rail-report')
    const emptyRail = [rx, (logo[1] + report[1]) / 2]
    await move(emptyRail, 300)   // less than the 0.4 s hover wait
    check('a mouse only passing does not open it', !(await state()).peek)
    await sleep(500)   // the hover wait (0.4 s) and the slide out (300 ms) have ended
    const out = await state()
    check('a hover on the strip slides the library out over the page', out.peek && !out.hidden && out.left === 60 && out.shown > 200 && out.col === 60, JSON.stringify(out))
    check('... its button now says it keeps it open', await page(`document.querySelector('#side-toggle').dataset.tip`) === 'Keep the library open (Ctrl+B)')
    await shot('3-peek-light.png')
    await page(`document.documentElement.dataset.theme = 'dark'`)
    await shot('4-peek-dark.png')
    await move([out.left + 120, 300], 500)
    check('moving into the library keeps it out', (await state()).peek)
    await move(await farRight(), 700)
    const back = await state()
    check('leaving it slides it back', !back.peek && back.shown === 0 && back.hidden, JSON.stringify(back))
    await shot('5-folded-dark.png')

    // The strip's search and Report a slip do not open it on hover; search opens it with the box ready
    await move(await center('#rail-search'), 450)
    check('a hover on the strip\'s search button does not open it', !(await state()).peek)
    await click(await center('#rail-search'))
    check('search opens it with the search box focused', (await state()).peek && (await state()).focus === 'lib-q')
    win.webContents.insertText('desert')
    await sleep(200)
    check('... typing narrows the list', await page(`document.querySelectorAll('#lib li[data-id]:not([hidden])').length === 1`))
    // Search pressed again: the library stays (it used to close on the press and open again on the click)
    await page(`window.__shut = 0; window.__watch = new MutationObserver(() => { if (!document.body.hasAttribute('data-peek')) window.__shut++ }); window.__watch.observe(document.body, { attributes: true, attributeFilter: ['data-peek'] })`)
    await click(await center('#rail-search'))
    const closes = await page(`(() => { window.__watch.disconnect(); return window.__shut })()`)
    check('search pressed again: it stays open, the box focused again', closes === 0 && (await state()).peek && (await state()).focus === 'lib-q', `closed ${closes} time(s)`)
    await move(await farRight(), 700)
    check('... the mouse leaving does not close it while typing', (await state()).peek)
    await key('Escape')
    await key('Escape', [], 300)
    check('Escape clears the box, then the library goes', !(await state()).peek && await page(`document.querySelector('#lib-q').value === ''`), JSON.stringify(await state()))
    await move(emptyRail, 800)
    await move([out.left + 100, 400], 200)
    await click(await farRight(), 300)
    check('a press on the page puts it away', !(await state()).peek)
    await move(await farRight())
    await click(await center('#rail-report'), 600)
    check('the strip\'s Report a slip opens the report page', await page(`!document.querySelector('#report').hidden`))
    await key('Escape', [], 500)
    check('... and Escape comes back to Home', await page(`!document.querySelector('.home').hidden`))

    // Ctrl+B: at once (a key); a reload keeps the choice
    await key('B', ['control'], 40)
    const kOpen = await state()
    check('Ctrl+B opens it at once', !kOpen.folded && kOpen.col === open0.col && kOpen.shown === open0.shown, JSON.stringify(kOpen))
    check('... remembered', (await saved()) === 'open')
    await key('B', ['control'], 40)
    const kShut = await state()
    check('Ctrl+B folds it at once', kShut.folded && kShut.col === 60 && kShut.shown === 0, JSON.stringify(kShut))
    win.webContents.reload()
    await new Promise((r) => win.webContents.once('did-finish-load', r))
    await sleep(300)
    const reload = await state()
    check('after a reload it is still folded', reload.folded && reload.col === 60 && reload.shown === 0, JSON.stringify(reload))
    await sleep(3000)   // the intro is gone by 3 s whatever happens (launch.js)
    check('... the launch intro ended', await page(`!document.querySelector('#launch')`))
    await until(() => page(`document.querySelectorAll('#lib li[data-id]').length > 3`), 5000)

    // Pinned from the hover
    await move(await farRight())
    await move(emptyRail, 800)
    await click(await center('#side-toggle'), 600)
    const pinned = await state()
    check('its button in the hover pins it open', !pinned.folded && !pinned.peek && pinned.col === open0.col && pinned.shown === open0.shown, JSON.stringify(pinned))
    check('... remembered', (await saved()) === 'open')
    check('... the button says hide again', await page(`document.querySelector('#side-toggle').dataset.tip`) === 'Hide the library (Ctrl+B)')

    // Theater (the player's attribute set here: the player itself is tested by NAQI_SELFTEST=full): no strip, the
    // window's left edge does the hover, Ctrl+B shows and hides it over the player
    await page(`document.body.setAttribute('data-theater', '')`)
    await sleep(500)
    const th = await state()
    check('theater: no column, no strip', th.col === 0 && th.shown === 0 && !th.rail, JSON.stringify(th))
    await move([2, 300], 900)   // hover wait 0.4 s + slide out 300 ms
    const thPeek = await state()
    check('theater: the left edge slides it out from the edge', thPeek.peek && thPeek.left === 0 && thPeek.shown > 200, JSON.stringify(thPeek))
    check('... with nothing to pin', await page(`getComputedStyle(document.querySelector('#side-toggle')).display === 'none'`))
    await move(await farRight(), 700)
    check('theater: leaving puts it away', !(await state()).peek)
    await key('B', ['control'], 450)
    check('theater: Ctrl+B shows it', (await state()).peek)
    await key('B', ['control'], 450)
    check('... and hides it, the choice unchanged', !(await state()).peek && (await saved()) === 'open')
    await page(`document.body.removeAttribute('data-theater')`)
    await sleep(500)

    // Small window: the narrow library folds and comes out the same way
    const [w, h] = win.getSize()
    win.setSize(780, 620)
    await sleep(600)
    await page(`document.documentElement.dataset.theme = 'light'`)
    await click(await center('#side-toggle'), 600)
    await move(emptyRail, 800)
    const small = await state()
    check('small window: folds and comes out', small.folded && small.peek && small.col === 60 && small.shown > 180, JSON.stringify(small))
    await shot('6-small-peek-light.png')
    await move([700, 300], 700)
    await shot('7-small-folded-light.png')
    win.setSize(w, h)
    await sleep(400)
  } catch (e) {
    check('test ran', false, e.message)
  } finally {
    nativeTheme.themeSource = theme
    // The real setting is put back
    await page(`window.naqi.setSettings({ sidebar: ${JSON.stringify(before || 'open')} })`).catch(() => {})
    note(fails ? `${fails} check(s) FAILED` : 'ALL PASSED')
    writeFileSync(join(outDir, 'log.txt'), log.join('\n') + '\n')
    setTimeout(() => app.quit(), 500)
  }
}
