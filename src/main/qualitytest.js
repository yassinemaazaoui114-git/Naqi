import { app } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Dev check for T10.5e (run with NAQI_SELFTEST=quality and NAQIE_DATA pointing to an empty folder named naqie-t10.5e,
// outside OneDrive; GPU + internet, about 4 min): picture quality for links in the gear menu. A 10.6 min YouTube link
// with every size (Big Buck Bunny, CC BY) is cleaned and played; Auto plays 1080p, then 720p, 480p, 360p, 1080p and
// Auto are picked in the menu: each plays at that height, the sound never stops, the picture comes back at the same
// moment and its sync is measured for 15 s after each swap. The choice is kept when the item opens again; a link with
// one size only (19 s, 240p) shows no Quality item. Log, screenshots and sync rows in test_out/t10.5e/.
const outDir = join(app.getAppPath(), 'test_out', 't10.5e')
const LINK = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'    // Big Buck Bunny, 1080p (and more), 10.6 min
const SMALL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'   // "Me at the zoo", 19 s, 240p only
const SYNC_S = 15
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function run(win, engine) {
  mkdirSync(outDir, { recursive: true })
  const log = []
  const rows = []
  let fails = 0
  const t0 = Date.now()
  const note = (text) => { log.push(`${((Date.now() - t0) / 1000).toFixed(2)} s  ${text}`); console.log('[qualitytest]', text) }
  const check = (name, ok, detail = '') => { fails += !ok; note(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`) }
  win.webContents.on('console-message', (e) => { if (e.level === 'error') note(`page error: ${e.message}`) })
  const page = (js) => win.webContents.executeJavaScript(js)
  const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(150) } return false }
  const stats = () => page('window.naqiPlayerStats()')
  const q = () => page('window.naqiQuality()')
  const watching = () => page(`!document.querySelector('#watch').hidden`)
  const shown = () => page(`document.querySelector('#screen').dataset.picture === 'shown'`)
  const shot = async (name) => {
    await sleep(300)
    try { writeFileSync(join(outDir, name), (await win.webContents.capturePage()).toPNG()) } catch (e) { note(`no screenshot ${name}: ${e.message}`) }
  }
  const cleanAndPlay = async (link) => {
    await page(`(() => { const u = document.querySelector('#url'); u.value = ${JSON.stringify(link)}; u.dispatchEvent(new Event('input')) })()`)
    await sleep(800)
    await page(`document.querySelector('#go').click()`)
  }
  // The menu by the page's own clicks (the same handlers as the mouse; the window may not paint with the screen off)
  const pick = async (h) => {
    await page(`document.querySelector('#gear-toggle').click()`)
    await sleep(300)
    await page(`document.querySelector('[data-go="quality"]').click()`)
    await sleep(350)
    await page(`document.querySelector('[data-quality="${h ?? ''}"]').click()`)
    await sleep(500)
    const value = await page(`document.querySelector('#gear-quality-value').textContent`)
    await page(`document.querySelector('#gear-toggle').click()`)   // closes it
    return value
  }
  const pct = (xs, f) => xs[Math.min(xs.length - 1, Math.floor(f * xs.length))]

  try {
    const data = process.env.NAQIE_DATA || ''
    if (!/naqie-t10\.5e[\\/]?$/.test(data)) throw new Error('NAQIE_DATA must be a folder named naqie-t10.5e (the real history is never used)')
    check('engine ready with the models', await until(async () => engine.status.status === 'ready' && (await engine.call('/health')).models, 120000), engine.status.gpu?.name)
    if (win.isMinimized()) win.restore()
    win.show()

    // Auto: up to 1080p
    await cleanAndPlay(LINK)
    check('the player opens with the link', await until(watching, 180000))
    check('... its picture is streamed and shown', await until(async () => (await shown()) && (await q()).using === 'stream', 60000))
    let s = await q()
    check('Auto plays 1080p', s.quality === null && s.height === 1080, `${s.height} lines`)
    check('... the menu offers the link\'s sizes', JSON.stringify(s.pic.heights) === '[1080,720,480,360]', JSON.stringify(s.pic.heights))
    check('... the Quality item shows', await page(`!document.querySelector('#gear-quality').hidden`))
    check('... and says Auto (1080p)', (await page(`document.querySelector('#gear-quality-value').textContent`)) === 'Auto (1080p)')
    await sleep(3000)

    // Each size, then back to 1080p and Auto
    for (const h of [720, 480, 360, 1080, null]) {
      const name = h ? `${h}p` : 'Auto'
      const before = await q()
      const b = await stats()
      const wall = Date.now()
      const value = await pick(h)
      check(`${name}: the menu shows it`, value === (h ? `${h}p` : 'Auto (1080p)') || (h === null && value === 'Auto'), `"${value}"`)
      const want = h || 1080
      const ok = await until(async () => { const x = await q(); return x.pic.found !== before.pic.found && x.height === want && !x.held && (await shown()) }, 40000)
      const took = (Date.now() - wall) / 1000
      const a = await stats()
      const x = await q()
      check(`${name}: plays at ${want} lines`, ok && x.height === want, `${x.height} lines, after ${took.toFixed(1)} s`)
      const moved = a.at - b.at
      check(`... the sound went on (never paused)`, !a.paused && Math.abs(moved / a.rate - took) < 1, `${moved.toFixed(2)} s of sound in ${took.toFixed(2)} s`)
      const off = await page(`document.querySelector('#picture').currentTime - window.naqiPlayerStats().at`)
      check(`... the picture is at the same moment`, Math.abs(off) < 0.15, `${(off * 1000).toFixed(0)} ms`)
      const from = (await stats()).sync.length
      await sleep(SYNC_S * 1000)
      const errs = (await stats()).sync.slice(from).map(([, e]) => Math.abs(e)).sort((m, n) => m - n)
      const max = errs.at(-1) ?? 1
      rows.push({ size: name, height: x.height, swap_s: +took.toFixed(2), frames: errs.length, median_ms: +(pct(errs, 0.5) * 1000).toFixed(1), p99_ms: +(pct(errs, 0.99) * 1000).toFixed(1), max_ms: +(max * 1000).toFixed(1) })
      check(`... sync over ${SYNC_S} s within 50 ms`, errs.length > SYNC_S * 20 && max < 0.05, `${errs.length} frames, median ${(pct(errs, 0.5) * 1000).toFixed(0)} ms, max ${(max * 1000).toFixed(0)} ms`)
      await shot(`${name}.png`)
    }

    // Kept: 480p, then the item opened again from the library
    await pick(480)
    await until(async () => (await q()).height === 480, 40000)
    await page(`document.querySelector('#watch-back').click()`)
    await sleep(800)
    await page(`document.querySelector('#corner-close').click()`)
    await until(() => page(`document.querySelector('#corner').hidden`), 3000)
    await page(`document.querySelector('#lib li[data-id] [data-act="play"]').click()`)
    check('opened again, the item plays at 480p', await until(async () => (await shown()) && (await q()).height === 480, 60000), `${(await q()).height} lines`)
    check('... and the menu still says 480p', (await page(`document.querySelector('#gear-quality-value').textContent`)) === '480p')
    await pick(null)
    await until(async () => (await q()).height === 1080, 40000)

    // A link with one size: no Quality item (after the first link's cleaning: one cleaning at a time)
    check('the first link is all clean', await until(async () => !(await stats()).live, 240000))
    await page(`document.querySelector('#watch-back').click()`)
    await sleep(800)
    await page(`document.querySelector('#corner-close').click()`)
    await until(() => page(`document.querySelector('#corner').hidden`), 3000)
    await cleanAndPlay(SMALL)
    check('a 240p-only link plays', await until(async () => (await watching()) && (await shown()) && (await q()).using === 'stream', 120000), `${(await q()).height} lines`)
    check('... and shows no Quality item', await page(`document.querySelector('#gear-quality').hidden`))
  } catch (e) {
    check('test ran', false, e.stack || e.message)
  } finally {
    note(fails ? `${fails} check(s) FAILED` : 'ALL PASSED')
    writeFileSync(join(outDir, 'log.txt'), log.join('\n') + '\n')
    writeFileSync(join(outDir, 'sync.json'), JSON.stringify(rows, null, 2) + '\n')
    setTimeout(() => app.quit(), 500)
  }
}
