import { app, clipboard, nativeTheme } from 'electron'
import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Dev check for T6.1 (run with NAQI_SELFTEST=polish and NAQIE_DATA pointing to a folder named naqie-t6.1, outside
// OneDrive; it is emptied first): the window's look at every size and scale. A seeded history (engine/seed_report.py)
// gives library rows and a played link with its cleaned sound. Each page (Home empty, Home with a link error, the
// player, Report a slip, the engine stopped) is shot at the smallest window, the usual one and a large one, and at
// 150% scale (high-DPI), in light and dark. Keyboard: Tab reaches every control in order with a visible focus ring,
// Escape goes back from the player and the report page. No GPU work and no internet. Results in test_out/t6.1/.
const outDir = join(app.getAppPath(), 'test_out', 't6.1')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function run(win, engine) {
  mkdirSync(outDir, { recursive: true })
  const log = []
  let fails = 0
  const t0 = Date.now()
  const note = (text) => { log.push(`${((Date.now() - t0) / 1000).toFixed(2)} s  ${text}`); console.log('[polishtest]', text) }
  const check = (name, ok, detail = '') => { fails += !ok; note(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`) }
  const page = (js) => win.webContents.executeJavaScript(js)
  const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(150) } return false }
  const shot = async (name) => { await sleep(700); writeFileSync(join(outDir, name), (await win.webContents.capturePage()).toPNG()) }
  const key = async (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await sleep(120)
  }
  const shown = () => page(`(() => ['.home', '#watch', '#report'].find((s) => !document.querySelector(s).hidden))()`)
  // No part of the page sticks out sideways (a horizontal scroll bar or a cut-off control)
  const overflow = () => page(`(() => {
    const bad = []
    for (const el of document.querySelectorAll('.side, .content, .home, .watch, .report, .card, .controls, .save-panel'))
      if (el.offsetParent && el.scrollWidth > el.clientWidth + 1) bad.push((el.id || el.className).toString().slice(0, 30))
    return bad.join(', ')
  })()`)
  const sizes = [['small', 720, 480], ['usual', 1100, 720], ['large', 1680, 1020]]

  try {
    const data = process.env.NAQIE_DATA || ''
    if (!/naqie-t6\.1[\\/]?$/.test(data)) throw new Error('NAQIE_DATA must be a folder named naqie-t6.1 (the real history is never used)')
    check('engine ready', await until(() => engine.status.status === 'ready', 90000), engine.status.gpu?.name)
    // Before the history is seeded (the folder is emptied by the run command): the empty library, both themes
    for (const theme of ['light', 'dark']) {
      nativeTheme.themeSource = theme
      await page(`window.dispatchEvent(new Event('focus'))`)
      await shot(`${theme}-usual-empty.png`)
    }
    check('empty library shows its sign', await page(`!document.querySelector('#lib-empty').hidden && !!document.querySelector('#lib-empty .empty-wave')`))
    // The engine stopped: the light turns red and says so, the main button says why it is off
    win.webContents.send('engine-status', { status: 'stopped', message: 'The engine stopped 3 times in a row.' })
    await page(`(() => { const u = document.querySelector('#url'); u.value = 'https://youtu.be/x'; u.dispatchEvent(new Event('input')) })()`)
    await shot('dark-usual-stopped.png')
    check('engine stopped: light and button say so', await page(`document.querySelector('#engine').dataset.state === 'stopped' &&
      !document.querySelector('#engine-restart').hidden && document.querySelector('#go').disabled &&
      document.querySelector('#go').textContent.includes('not running')`))
    win.webContents.send('engine-status', engine.status)
    await page(`(() => { const u = document.querySelector('#url'); u.value = ''; u.dispatchEvent(new Event('input')) })()`)
    // A toast: an error stays 8 s and can be closed; at most three at once
    await page(`for (let i = 0; i < 4; i++) window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', { promise: Promise.resolve(), reason: new Error('Test message ' + i) }))`)
    await sleep(400)
    check('unexpected errors show as a message, at most three', (await page(`document.querySelectorAll('.toast:not(.is-leaving)').length`)) === 3)
    await shot('dark-usual-toasts.png')
    await sleep(4500)
    check('... an error is still there after 4.9 s', (await page(`document.querySelectorAll('.toast:not(.is-leaving)').length`)) === 3)
    await page(`document.querySelectorAll('.toast .toast-close').forEach((b) => b.click())`)
    await sleep(800)
    check('... Close takes them away', (await page(`document.querySelectorAll('.toast').length`)) === 0)
    const seeded = JSON.parse(await new Promise((resolve, reject) => execFile('py',
      ['-3.12', join(app.getAppPath(), 'engine', 'seed_report.py'), join(outDir, 'files')],
      { env: process.env, windowsHide: true }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)))))
    await page(`window.dispatchEvent(new Event('focus'))`)
    await sleep(800)

    const pages = {
      home: async () => { await page(`document.querySelector('#watch-back').click(); document.querySelector('#url').value = ''; document.querySelector('#url').dispatchEvent(new Event('input'))`) },
      error: async () => {
        await page(`(() => { const u = document.querySelector('#url'); u.focus(); u.value = 'not a link'; u.dispatchEvent(new Event('input')) })()`)
        await key('Enter')
      },
      player: async () => {
        await page(`window.dispatchEvent(new CustomEvent('naqi-play', { detail: { id: ${seeded.link_row} } }))`)
        await until(async () => (await shown()) === '#watch', 5000)
        await sleep(1200)
        await page(`document.querySelector('#player-play').getAttribute('aria-pressed') === 'true' && document.querySelector('#player-play').click()`)
      },
      report: async () => {
        await page(`document.querySelector('#open-report').click()`)
        await until(async () => (await shown()) === '#report', 3000)
        await sleep(400)
        await page(`document.querySelector('#recent li[data-id="${seeded.link_row}"] .lib-row').click()`)
        await sleep(900)
      }
    }
    for (const theme of ['light', 'dark']) {
      nativeTheme.themeSource = theme
      for (const [size, w, h] of sizes) {
        win.unmaximize(); win.setContentSize(w, h)
        for (const zoom of size === 'usual' ? [1, 1.5] : [1]) {
          win.webContents.setZoomFactor(zoom)
          for (const [name, go] of Object.entries(pages)) {
            await go()
            const tag = `${theme}-${size}${zoom !== 1 ? '-150' : ''}-${name}`
            await shot(`${tag}.png`)
            note(`${tag}: page shown ${await shown()}`)
            const bad = await overflow()
            check(`${tag}: nothing sticks out sideways`, !bad, bad)
            if (name === 'player' || name === 'report') await page(`document.querySelector('${name === 'player' ? '#watch-back' : '#report-back'}').click()`)
            await sleep(300)
          }
        }
        win.webContents.setZoomFactor(1)
      }
    }
    win.setContentSize(1100, 720)
    nativeTheme.themeSource = 'dark'
    await sleep(500)

    // ---------- Theme button: the circle opens, no error message, the page really changes ----------
    for (const mode of ['light', 'dark', 'light', 'dark']) {
      const t = Date.now()
      await page(`document.querySelector('#theme [data-mode="${mode}"]').click()`)
      const ok = await until(() => page(`matchMedia('(prefers-color-scheme: dark)').matches === ${mode === 'dark'}`), 3000)
      await sleep(900)
      const toasts = await page(`[...document.querySelectorAll('.toast .msg-text')].map((x) => x.textContent).join(' | ')`)
      check(`theme button ${mode}: switches, no error`, ok && !toasts, `${Date.now() - t} ms${toasts ? `, ${toasts}` : ''}`)
    }
    // Report a slip and Home: the scroll bar is at the window's right edge, not beside the 700 px column
    for (const [name, sel] of [['report', '#report'], ['home', '.home']]) {
      if (name === 'report') { await page(`document.querySelector('#open-report').click()`); await sleep(600) }
      const edge = await page(`document.querySelector('.content').offsetWidth - document.querySelector('${sel}').offsetWidth`)
      check(`${name}: the scrolling column reaches the window's right edge`, edge === 0, `${edge} px narrower than the column`)
      if (name === 'report') { await page(`document.querySelector('#report-back').click()`); await sleep(400) }
    }

    // ---------- Keyboard ----------
    win.unmaximize(); win.setContentSize(1100, 720); win.focus(); await sleep(300)
    // Tab through Home: every stop shows a focus ring (an outline, or the field's ring around its box). Windows
    // only lets a window take the focus when the user is not busy in another one; without it no focus ring is
    // drawn, so then the style sheets are checked instead: no rule takes the ring away except the two that draw
    // their own (the link box's field ring, the sound strip's well)
    const focused = await page('document.hasFocus()')
    await page(`document.activeElement.blur()`)
    const stops = []
    for (let i = 0; i < 14; i++) {
      await key('Tab')
      stops.push(await page(`(() => { const el = document.activeElement; const cs = getComputedStyle(el); const body = el === document.body
        const box = el.closest('.field') ? getComputedStyle(el.closest('.field')).boxShadow : 'none'
        const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || box !== 'none'
        return { body, what: (el.id || el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 24), ring } })()`))
    }
    note(`Tab order: ${stops.map((x) => x.what).join(' > ')}`)
    if (focused) {
      const blind = stops.filter((x) => !x.ring && !x.body).map((x) => x.what)
      check('every Tab stop shows a focus ring', blind.length === 0, blind.join(', '))
    } else {
      const off = await page(`[...document.styleSheets].flatMap((sh) => [...sh.cssRules]).filter((r) => r.style &&
        /^(none|0|0px)$/.test(r.style.outlineStyle === 'none' ? 'none' : r.style.outlineWidth)).map((r) => r.selectorText)`)
      const allowed = ['.field input', '.strip-bar']
      const bad = off.filter((sel) => !allowed.includes(sel))
      check('window not in front: no style takes a focus ring away', bad.length === 0, bad.join(', ') || `only ${off.join(', ')}`)
    }
    await shot('dark-usual-tabbing.png')
    // Ctrl+V outside a field pastes the link
    clipboard.writeText('https://www.youtube.com/watch?v=jNQXAC9IVRw')
    await page(`document.activeElement.blur()`)
    await key('V', ['control'])
    await sleep(300)
    check('Ctrl+V on Home fills the link box', (await page(`document.querySelector('#url').value`)) === 'https://www.youtube.com/watch?v=jNQXAC9IVRw')
    await page(`(() => { const u = document.querySelector('#url'); u.value = ''; u.dispatchEvent(new Event('input')) })()`)
    // Library: Enter picks a row, Enter again plays it, Escape goes back at once (no slide)
    await page(`document.querySelector('#lib li[data-id="${seeded.link_row}"] .lib-row').focus()`)
    const picked = await page(`document.querySelector('#lib li[data-id="${seeded.link_row}"]').dataset.open === 'true'`)
    if (!picked) await key('Return')
    await key('Return')
    check('Enter on a picked library row plays it', await until(async () => (await shown()) === '#watch', 5000))
    await sleep(800)
    await key('Escape')
    check('Escape in the player goes back to Home at once', (await shown()) === '.home' &&
      !(await page(`document.querySelector('.home').classList.contains('is-entering')`)))
    check('... the link box has the focus', (await page(`document.activeElement.id`)) === 'url')
    await page(`document.querySelector('#open-report').click()`)
    await until(async () => (await shown()) === '#report', 3000)
    check('the report page slides in from the right', (await page(`document.querySelector('#report').dataset.way`)) === 'forward')
    await sleep(500)
    await page(`document.activeElement.blur()`)
    await key('Escape')
    check('Escape on the report page goes back', (await shown()) === '.home')
    // The player at its narrowest: everything still fits, Save and Report here keep their icons
    win.setContentSize(720, 480)
    await page(`window.dispatchEvent(new CustomEvent('naqi-play', { detail: { id: ${seeded.link_row} } }))`)
    await until(async () => (await shown()) === '#watch', 5000)
    await sleep(800)
    const play = await page(`(() => { const r = document.querySelector('#player-play').getBoundingClientRect(); return [r.width, r.height] })()`)
    check('small player: the play button stays round', Math.abs(play[0] - play[1]) < 1, play.join(' x '))
    win.setContentSize(1100, 720)
    await page(`document.querySelector('#watch-back').click()`)
  } catch (e) {
    fails++
    note(`FAIL ${e.stack || e.message}`)
  }
  note(fails ? `${fails} check(s) failed` : 'all checks passed')
  writeFileSync(join(outDir, 'log.txt'), log.join('\n') + '\n')
  app.quit()
}
