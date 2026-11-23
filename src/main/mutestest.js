import { app, ipcMain } from 'electron'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Dev check for T10.2b (run with NAQI_SELFTEST=mutes and NAQIE_DATA pointing to a folder named naqie-t10.2b,
// outside OneDrive; it is emptied first; GPU, about 2 min): the muted parts on the player's time bar. A 5 min video
// with speech over music (samples/mutes_5min.mp4 = the picture of sync_test_5min.mp4 + narration_over_music.mp3,
// whose cleaning mutes 31 parts) is cleaned and played: while it is cleaned the parts show only inside the clean part
// and grow with it; once clean all of them show; hovering one brackets it and the tip gives its times; the bar still
// jumps; light, dark and small window screenshots. Log and screenshots in test_out/t10.2b/.
const outDir = join(app.getAppPath(), 'test_out', 't10.2b')
const SAMPLE = join(app.getAppPath(), 'samples', 'mutes_5min.mp4')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function run(win, engine) {
  mkdirSync(outDir, { recursive: true })
  const log = []
  let fails = 0
  const t0 = Date.now()
  const note = (text) => { log.push(`${((Date.now() - t0) / 1000).toFixed(2)} s  ${text}`); console.log('[mutestest]', text) }
  const check = (name, ok, detail = '') => { fails += !ok; note(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`) }
  const page = (js) => win.webContents.executeJavaScript(js)
  const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(150) } return false }
  const stats = () => page('window.naqiPlayerStats()')
  const watching = () => page(`!document.querySelector('#watch').hidden`)
  const shot = async (name) => { await sleep(400); writeFileSync(join(outDir, name), (await win.webContents.capturePage()).toPNG()) }
  const mask = () => page(`document.querySelector('#timebar-lines').style.getPropertyValue('--muted-mask')`)
  const move = async (x, y) => { win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) }); await sleep(200) }
  const bar = () => page(`(() => { const r = document.querySelector('#timebar').getBoundingClientRect(); return { x: r.left, y: r.top + r.height / 2, w: r.width } })()`)
  const setTheme = (t) => page(`(() => { const d = document.documentElement.dataset; if (${JSON.stringify(t)}) d.theme = ${JSON.stringify(t)}; else delete d.theme })()`)

  try {
    const data = process.env.NAQIE_DATA || ''
    if (!/naqie-t10\.2b[\\/]?$/.test(data)) throw new Error('NAQIE_DATA must be a folder named naqie-t10.2b (the real history is never used)')
    rmSync(data, { recursive: true, force: true })
    check('engine ready with the models', await until(async () => engine.status.status === 'ready' && (await engine.call('/health')).models, 120000), engine.status.gpu?.name)
    ipcMain.removeHandler('choose-files')
    ipcMain.handle('choose-files', () => [SAMPLE])
    await page(`document.querySelector('#choose').click()`)
    await sleep(800)
    await page(`document.querySelector('#go').click()`)
    check('the player opens with the 5 min video', await until(watching, 120000))
    await page(`window.__done = null; window.naqi.onJob((j) => { if (j.kind === 'play' && j.state === 'done') window.__done = j }); 0`)
    await until(async () => (await stats()).firstPlaying !== null, 60000)
    const theme = await page('document.documentElement.dataset.theme || null')

    // While it is cleaned: parts only inside the clean part, more of them as it grows
    check('muted parts show while it is still cleaned', await until(async () => (await stats()).mutes.parts.length > 0, 20000))
    let s = await stats()
    const first = s.mutes.parts.length
    check('... only inside the clean part', s.live && s.mutes.parts.every(([a, b]) => a < b && b <= s.ready + 0.01) && s.mutes.upto <= s.ready + 0.01,
      `${first} parts, read up to ${s.mutes.upto} s, clean up to ${s.ready.toFixed(1)} of ${s.length.toFixed(0)} s`)
    check('... drawn on the time bar', (await mask()).startsWith('url('))
    await setTheme('dark')
    await shot('cleaning-dark.png')
    await setTheme('light')
    await shot('cleaning-light.png')
    await setTheme(theme)
    check('... and grow with the clean part', await until(async () => { const x = await stats(); return x.live && x.mutes.parts.length > first }, 120000) || !(await stats()).live,
      `${(await stats()).mutes.parts.length} parts, clean up to ${(await stats()).ready.toFixed(0)} s`)
    check('cleaning done', await until(async () => !(await stats()).live, 180000))
    check('all muted parts show once it is clean', await until(async () => (await stats()).mutes.parts.length >= 25, 10000))
    s = await stats()
    const parts = s.mutes.parts
    const total = parts.reduce((t, [a, b]) => t + b - a, 0)
    // The cleaning itself counts the seconds it muted; the marks miss only the 30 ms fades at each part's edges
    const done = await page('window.__done')
    const engineS = (done?.numbers?.muted_fraction || 0) * s.length
    check('... as much as the cleaning says it muted', engineS > 0 && Math.abs(total - engineS) <= 0.1 * parts.length + 1 && s.mutes.upto > s.length - 1,
      `${parts.length} parts, ${total.toFixed(1)} s marked, the cleaning muted ${engineS.toFixed(1)} s of ${s.length.toFixed(0)} s, read up to ${s.mutes.upto} s`)

    // Hover: the longest part is bracketed and the tip gives its times
    const [a, b] = parts.reduce((m, p) => (p[1] - p[0] > m[1] - m[0] ? p : m))
    let r = await bar()
    await move(r.x + r.w * 0.5, r.y - 60)
    await move(r.x + r.w * ((a + b) / 2) / s.length, r.y)
    const tip = await page(`document.querySelector('#timebar-tip').textContent`)
    const on = await page(`document.querySelector('#timebar-span').dataset.on`)
    check('hovering a muted part brackets it and shows its times', on === 'true' && tip.startsWith('Muted ') && tip.includes('–'), `"${tip}" for ${a}–${b} s`)
    await setTheme('dark')
    await shot('hover-dark.png')
    await setTheme('light')
    await shot('hover-light.png')
    await setTheme(theme)
    // Next to a part (in a kept stretch) the tip is the plain time
    const gap = parts.findIndex((p, i) => i && p[0] - parts[i - 1][1] > 10)
    if (gap > 0) {
      await move(r.x + r.w * ((parts[gap - 1][1] + parts[gap][0]) / 2) / s.length, r.y)
      const plain = await page(`document.querySelector('#timebar-tip').textContent`)
      check('... between parts the tip is the plain time', /^\d+:\d\d$/.test(plain) && (await page(`document.querySelector('#timebar-span').dataset.on`)) === 'false', `"${plain}"`)
    }

    // The bar still works: a click on a muted part jumps there
    const x = r.x + r.w * ((a + b) / 2) / s.length
    win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(r.y), button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(r.y), button: 'left', clickCount: 1 })
    await sleep(500)
    s = await stats()
    check('a click on a part jumps there', Math.abs(s.jumps.at(-1).to - (a + b) / 2) < 2, `to ${s.jumps.at(-1).to.toFixed(1)} s`)

    // A small window: the pinches are redrawn for the narrower bar
    const before = await mask()
    const size = win.getSize()
    win.setSize(720, 480)
    await sleep(700)
    r = await bar()
    await move(r.x + r.w * ((a + b) / 2) / s.length, r.y)
    await shot('small.png')
    check('small window: redrawn for the narrower bar', (await mask()) !== before && (await mask()).startsWith('url('))
    win.setSize(...size)
    await sleep(400)

    await page(`document.querySelector('#watch-back').click()`)
    await sleep(600)
    check('leaving the player clears them', !(await mask()))
  } catch (e) {
    check('test ran', false, e.stack || e.message)
  } finally {
    note(fails ? `${fails} check(s) FAILED` : 'ALL PASSED')
    writeFileSync(join(outDir, 'log.txt'), log.join('\n') + '\n')
    setTimeout(() => app.quit(), 500)
  }
}
