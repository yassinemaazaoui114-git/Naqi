import { app, ipcMain } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Dev check for T13.5 (run with NAQI_SELFTEST=preview and NAQIE_DATA pointing to an empty folder named naqie-t13.5,
// outside OneDrive; GPU + internet, about 4 min): the preview picture over the time bar. The 5 min
// samples/sync_test_5min.mp4 is cleaned and played: while it is cleaned a hover past the clean part shows no picture,
// inside it does; once clean, 20 spots show their picture (time measured), the same spots again at once, the picture
// is the one of that moment (compared with the player's own picture there), sync stays while hovering, light and dark,
// a small window. Then a YouTube link (Big Buck Bunny): its preview comes from the small stream, the player's picture
// stays at its size. Log and screenshots in test_out/t13.5/.
const outDir = join(app.getAppPath(), 'test_out', 't13.5')
const FILE = join(app.getAppPath(), 'samples', 'sync_test_5min.mp4')
const LINK = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'   // Big Buck Bunny, 10.6 min, 1080p
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function run(win, engine) {
  mkdirSync(outDir, { recursive: true })
  const log = []
  let fails = 0
  const t0 = Date.now()
  const note = (text) => { log.push(`${((Date.now() - t0) / 1000).toFixed(2)} s  ${text}`); console.log('[previewtest]', text) }
  const check = (name, ok, detail = '') => { fails += !ok; note(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`) }
  win.webContents.on('console-message', (e) => { if (e.level === 'error') note(`page error: ${e.message}`) })
  const page = (js) => win.webContents.executeJavaScript(js)
  const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(100) } return false }
  const stats = () => page('window.naqiPlayerStats()')
  const pv = () => page('window.naqiPreview()')
  const watching = () => page(`!document.querySelector('#watch').hidden`)
  const shot = async (name) => {
    await sleep(350)
    try { writeFileSync(join(outDir, name), (await win.webContents.capturePage()).toPNG()) } catch (e) { note(`no screenshot ${name}: ${e.message}`) }
  }
  // The pointer over the time bar at second t: the page's pointer events (the same handler as the mouse; the window
  // may not paint with the screen off) and, for the screenshots, the real mouse too
  const bar = () => page(`(() => { const r = document.querySelector('#timebar').getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height } })()`)
  const hover = async (t, real = false) => {
    const len = (await stats()).length
    const r = await bar()
    const x = r.left + (t / len) * r.width
    const y = r.top + r.height / 2
    if (real) win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) })
    await page(`document.querySelector('#timebar').dispatchEvent(new PointerEvent('pointermove', { clientX: ${x}, clientY: ${y}, bubbles: true }))`)
  }
  const leave = () => page(`document.querySelector('#timebar').dispatchEvent(new PointerEvent('pointerleave'))`)
  // Hover at t and wait for its picture; returns the preview state and the time it took (ms)
  const peekAt = async (t, ms = 8000) => {
    const start = Date.now()
    await hover(t)
    const key = (await pv()).want   // the second the page took from the pointer (t, up to the pixel)
    const ok = Math.abs(key - t) < 1.5 && await until(async () => { const s = await pv(); return s.on && s.drawn === key }, ms)
    const s = await pv()
    return { ok, key, s, ms: ok ? s.times.at(-1) : null, wall: Date.now() - start }
  }
  const stat = (xs) => {
    const v = xs.filter((x) => x !== null).sort((a, b) => a - b)
    return v.length ? `median ${v[Math.floor(v.length / 2)].toFixed(0)} ms, max ${v.at(-1).toFixed(0)} ms (${v.length})` : 'none'
  }
  const cleanAndPlay = async (link) => {
    await page(`(() => { const u = document.querySelector('#url'); u.value = ${JSON.stringify(link)}; u.dispatchEvent(new Event('input')) })()`)
    await sleep(800)
    await page(`document.querySelector('#go').click()`)
  }

  try {
    const data = process.env.NAQIE_DATA || ''
    if (!/naqie-t13\.5[\\/]?$/.test(data)) throw new Error('NAQIE_DATA must be a folder named naqie-t13.5 (the real history is never used)')
    check('engine ready with the models', await until(async () => engine.status.status === 'ready' && (await engine.call('/health')).models, 120000), engine.status.gpu?.name)
    if (win.isMinimized()) win.restore()
    win.show()
    win.setSize(1280, 800)
    ipcMain.removeHandler('choose-files')
    ipcMain.handle('choose-files', () => [FILE])

    // ---------- An own video ----------
    note('--- own video, 5 min')
    await page(`document.querySelector('#choose').click()`)
    await sleep(800)
    await page(`document.querySelector('#go').click()`)
    check('the player opens', await until(watching, 120000))
    check('the picture shows', await until(async () => (await page(`document.querySelector('#screen').dataset.picture`)) === 'shown', 120000))
    await until(async () => (await stats()).ready > 60, 60000)
    let s = await stats()
    if (s.live && s.ready < s.length - 30) {
      await hover(Math.min(s.length - 5, s.ready + 20))
      await sleep(700)
      const far = await pv()
      const blocked = await page(`document.querySelector('#timebar-tip').dataset.blocked`)
      check('while cleaned: no picture past the clean part', !far.on && blocked === 'true', `clean up to ${s.ready.toFixed(0)} s`)
      const inside = await peekAt(s.ready / 2)
      check('while cleaned: a picture inside the clean part', inside.ok && inside.s.lit > 20, `${inside.ms?.toFixed(0)} ms, contrast ${inside.s.lit?.toFixed(0)}`)
    } else note('cleaned too fast to see the part not clean yet')
    await until(async () => !(await stats()).live, 180000)
    s = await stats()
    check('all clean', !s.live, `${s.length.toFixed(0)} s`)

    // 20 spots never seen, then 10 of them again
    const spots = Array.from({ length: 20 }, (_, i) => 7 + ((i * 137.3) % (s.length - 15)))
    const fresh = []
    let rightTime = true
    for (const t of spots) {
      const r = await peekAt(t)
      fresh.push(r.ms)
      if (!r.ok || Math.abs(r.s.at - (r.key + 0.5)) > 0.05) { rightTime = false; note(`  spot ${t.toFixed(1)} s: ok ${r.ok}, drawn ${r.s.drawn}, at ${r.s.at.toFixed(3)}`) }
    }
    check('20 new spots each show the picture of their second', rightTime && fresh.every((x) => x !== null), stat(fresh))
    check('... quickly (median under 250 ms)', fresh.filter((x) => x !== null).sort((a, b) => a - b)[10] < 250, stat(fresh))
    const again = []
    for (const t of spots.slice(0, 10)) {
      await hover(Math.min(s.length - 1, t + 30))   // somewhere else first
      await sleep(150)
      const r = await peekAt(t)
      again.push(r.ms)
    }
    check('the same spots again show at once (under 30 ms)', again.every((x) => x !== null && x < 30), stat(again))

    // The picture is the one of that moment: the preview of second k against the player's own picture at k + 0.5
    await page(`document.querySelector('#player-play').click()`)
    await until(async () => (await stats()).paused, 3000)
    const k = 123
    await peekAt(k + 0.2)
    const cmp = async (at) => {
      await page(`(() => { const v = document.querySelector('#picture'); v.currentTime = ${at} })()`)
      await sleep(1200)
      return page(`(() => {
        const pc = document.querySelector('#timebar-frame canvas'), v = document.querySelector('#picture')
        const c = document.createElement('canvas'); c.width = pc.width; c.height = pc.height
        const g = c.getContext('2d'); g.drawImage(v, 0, 0, c.width, c.height)
        const a = g.getImageData(0, 0, c.width, c.height).data, b = pc.getContext('2d').getImageData(0, 0, c.width, c.height).data
        let d = 0; for (let i = 0; i < a.length; i += 4) d += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])
        return d / (a.length / 4) / 3
      })()`)
    }
    const same = await cmp(k + 0.5)
    const other = await cmp(k + 40.5)
    check('the preview is the picture of that moment', same < other / 2, `difference ${same.toFixed(1)} at the same moment, ${other.toFixed(1)} 40 s later (0 to 255)`)

    // Playing while hovering: the picture stays in sync
    await page(`document.querySelector('#player-play').click()`)
    await until(async () => !(await stats()).paused, 3000)
    await sleep(1500)
    const n = (await stats()).sync.length
    for (let i = 0; i < 30; i++) { await hover(10 + ((i * 53.7) % (s.length - 20))); await sleep(400) }
    const sync = (await stats()).sync.slice(n)
    const worst = Math.max(...sync.map(([, e]) => Math.abs(e)))
    check('in sync while hovering (12 s, 30 spots)', sync.length > 100 && worst <= 0.05, `${sync.length} frames, max ${(worst * 1000).toFixed(0)} ms`)

    await leave()
    await sleep(300)
    check('leaving the bar hides it', !(await pv()).on)

    // Light and dark, the real mouse for the shots
    for (const theme of ['dark', 'light']) {
      await page(`document.documentElement.dataset.theme = '${theme}'`)
      await hover(150, true)
      await until(async () => (await pv()).on, 3000)
      const p1 = await pv()
      const gap = p1.tip.height ? p1.tip.top - (p1.box.top + p1.box.height) : null
      check(`${theme}: shown over the time`, p1.on && p1.lit > 20, gap === null ? 'tip not measured' : `frame ${p1.box.width.toFixed(0)} x ${p1.box.height.toFixed(0)} px, ${gap.toFixed(1)} px above the tip`)
      await shot(`own-${theme}.png`)
      await hover(2, true)   // at the left end: kept inside the bar
      await sleep(400)
      const r = await bar()
      const p2 = await pv()
      check(`${theme}: at the bar's start it stays inside`, p2.box.left >= r.left - 13, `frame from ${p2.box.left.toFixed(0)} px, bar from ${r.left.toFixed(0)} px`)
      await shot(`own-${theme}-start.png`)
    }
    await page(`delete document.documentElement.dataset.theme`)

    // A small window
    win.setSize(720, 480)
    await sleep(800)
    await hover(200, true)
    await until(async () => (await pv()).on, 3000)
    const small = await pv()
    const scr = await page(`(() => { const r = document.querySelector('#screen').getBoundingClientRect(); return { top: r.top } })()`)
    check('small window: inside the screen', small.on && small.box.top >= scr.top, `frame ${small.box.width.toFixed(0)} x ${small.box.height.toFixed(0)} px, top ${small.box.top.toFixed(0)}, screen top ${scr.top.toFixed(0)}`)
    await shot('own-small.png')
    win.setSize(1280, 800)
    await leave()

    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await sleep(700)
    await page(`document.querySelector('#corner-close')?.click()`)
    await sleep(500)
    check('closing the item clears the preview', !(await pv()).src)

    // ---------- A link ----------
    note('--- link, Big Buck Bunny')
    await cleanAndPlay(LINK)
    check('the link opens', await until(watching, 120000))
    check('its picture shows', await until(async () => (await page(`document.querySelector('#screen').dataset.picture`)) === 'shown', 120000))
    await until(async () => (await stats()).ready > 100, 120000)
    s = await stats()
    const warm = await pv()
    note(`before the first hover: preview ${warm.src ? 'opened' : 'not opened'}, readyState ${warm.readyState}, opened ${warm.opened?.toFixed(0)} ms ago, metadata after ${warm.meta?.toFixed(0)} ms`)
    const first = await peekAt(s.ready / 3, 20000)
    const lp = first.s
    check('link: a picture from the small stream', first.ok && lp.src.endsWith('/preview') && lp.height > 0 && lp.height <= 360 && lp.lit > 20,
      `${lp.width} x ${lp.height}, first ${first.ms?.toFixed(0)} ms`)
    const linkTimes = []
    let linkOk = true
    for (let i = 0; i < 10; i++) {
      const r = await peekAt(5 + ((i * 41.7) % Math.max(10, (await stats()).ready - 10)))
      linkTimes.push(r.ms)
      if (!r.ok) linkOk = false
    }
    check('link: 10 new spots show their picture', linkOk, stat(linkTimes))
    const main = await page(`document.querySelector('#picture').videoHeight`)
    check('link: the player\'s own picture keeps its size', main >= 720, `${main} lines`)
    await hover(s.length - 10)
    await sleep(700)
    const linkFar = await pv()
    if ((await stats()).live) check('link: no picture past the clean part', !linkFar.on)
    await page(`document.documentElement.dataset.theme = 'dark'`)
    await hover((await stats()).ready / 2, true)
    await until(async () => (await pv()).on, 5000)
    await shot('link-dark.png')
    await page(`delete document.documentElement.dataset.theme`)
    await leave()
  } catch (e) {
    check('test ran', false, e.stack || e.message)
  } finally {
    note(fails ? `${fails} check(s) FAILED` : 'ALL PASSED')
    writeFileSync(join(outDir, 'log.txt'), log.join('\n') + '\n')
    setTimeout(() => app.quit(), 500)
  }
}
