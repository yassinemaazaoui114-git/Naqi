import { app, ipcMain, nativeTheme } from 'electron'
import { existsSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// Dev check for T13.10 (run with NAQI_SELFTEST=original and NAQIE_DATA pointing to a folder named naqie-t13.10,
// outside OneDrive; it is emptied first; GPU + internet, about 4 min): the Clean / Original switch on the player bar.
// samples/mutes_5min.mp4 (speech over music) is cleaned and played: it opens on Clean; Original while it is still
// cleaned plays the kept sound (a sound-only copy of the own video) in step with the cleaned one, its sync measured
// over 60 s, then through a pause, a jump, 1.5x, Steady volume and the corner; Clean fades back; the switch's arrow
// keys do not move the playhead; the item opens again on Clean. Then a 19 s YouTube link: its kept sound plays as it
// is; once that sound is deleted, Original is off with a tip. Light, dark and a small window. Log, shots and
// sync.json in test_out/t13.10/.
const outDir = join(app.getAppPath(), 'test_out', 't13.10')
const CLIP = join(app.getAppPath(), 'samples', 'mutes_5min.mp4')
const LINK = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'   // "Me at the zoo", 19 s
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function run(win, engine) {
  mkdirSync(outDir, { recursive: true })
  const log = []
  let fails = 0
  const t0 = Date.now()
  const note = (text) => { log.push(`${((Date.now() - t0) / 1000).toFixed(2)} s  ${text}`); console.log('[originaltest]', text) }
  const check = (name, ok, detail = '') => { fails += !ok; note(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`) }
  const page = (js) => win.webContents.executeJavaScript(js)
  const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(100) } return false }
  const shot = async (name) => writeFileSync(join(outDir, `${name}.png`), (await win.webContents.capturePage()).toPNG())
  const click = async (sel, wait = 400) => { await page(`document.querySelector(${JSON.stringify(sel)}).click()`); await sleep(wait) }
  const stats = () => page('window.naqiPlayerStats()')
  const og = () => page('window.naqiOriginal()')
  const shown = () => page(`(() => ['.home', '#watch', '#report'].find((s) => !document.querySelector(s).hidden))()`)
  const switchOn = () => page(`document.querySelector('#sound-switch').dataset.on`)
  const press = async (keyCode, wait = 400) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
    await sleep(wait)
  }
  const syncOf = (rows) => {
    const e = rows.map((r) => Math.abs(r[1])).sort((a, b) => a - b)
    return { n: e.length, median: e[Math.floor(e.length / 2)] ?? null, max: e.at(-1) ?? null }
  }
  const ms = (s) => (s === null ? '-' : `${Math.round(s * 1000)} ms`)
  const heard = async () => { const o = await og(); return o.mix === 1 && o.clean === 0 && !o.paused }
  const results = {}
  // Back to Home, then the corner's Stop: nothing plays any more
  const stop = async () => {
    await click('#watch-back', 0)
    const c = await until(async () => (await stats()).corner, 3000)
    await sleep(500)
    await click('#corner-close', 0)
    const ok = await until(async () => (await stats()).id === null, 5000)
    if (!ok) note(`stop: corner ${c}, now ${JSON.stringify(await page(`(() => { const s = window.naqiPlayerStats(); return { id: s.id, corner: s.corner, page: ['.home', '#watch', '#report'].find((x) => !document.querySelector(x).hidden), cls: document.querySelector('#corner').className } })()`))}`)
    return ok
  }
  const data = process.env.NAQIE_DATA || ''

  try {
    if (!/naqie-t13\.10[\\/]?$/.test(data)) throw new Error('NAQIE_DATA must be a folder named naqie-t13.10 (the real history is never used)')
    rmSync(data, { recursive: true, force: true })
    check('engine ready with the models', await until(async () => engine.status.status === 'ready' && (await engine.call('/health')).models, 120000), engine.status.gpu?.name)
    ipcMain.removeHandler('choose-files')
    ipcMain.handle('choose-files', () => [CLIP])
    await click('#choose', 800)
    await click('#go', 0)
    check('the player opens', await until(async () => (await shown()) === '#watch', 120000))
    await until(async () => (await stats()).firstPlaying !== null, 120000)
    const id = (await stats()).id

    // ---- Opens on Clean
    check('the switch is on the bar, on Clean', (await switchOn()) === 'clean' && await page(`!document.querySelector('#sound-switch [data-value="original"]').disabled`))
    check('only the cleaned sound is heard', (await og()).mix === 0 && (await og()).paused)

    // ---- Original while it is still cleaned
    const live = (await stats()).live
    const t1 = Date.now()
    await click('#sound-switch [data-value="original"]', 0)
    await sleep(300)
    check('a note says the music is back', /music is back/.test(await page(`document.querySelector('#watch-note').textContent`)))
    check('Original is heard, in step, the cleaned sound silent', await until(heard, 15000), `after ${Date.now() - t1} ms, still cleaned: ${live}`)
    results.switchMs = Date.now() - t1
    const hist = join(data, 'history')
    const copies = existsSync(hist) ? readdirSync(hist).flatMap((f) => readdirSync(join(hist, f)).filter((n) => n.startsWith('original-play-'))) : []
    check('the own video got a sound-only copy for it', copies.length === 1 && copies[0].endsWith('.m4a'), copies.join(', '))
    await page('window.naqiOriginal().sync.length = 0')
    await sleep(60000)
    const rows1 = (await og()).sync
    const s1 = syncOf(rows1)
    results.plain = s1
    results.plainRows = rows1
    check('60 s of Original in step with the cleaned sound and picture', s1.n > 500 && s1.max < 0.05, `${s1.n} rows, median ${ms(s1.median)}, max ${ms(s1.max)}`)
    const ps = (await stats()).sync.slice(-300).map((r) => Math.abs(r[1])).sort((a, b) => a - b)
    if (!ps.length) note(`picture: ${JSON.stringify(await page(`(() => { const s = window.naqiPlayerStats(); return { using: s.using, n: s.sync.length, waiting: s.waiting, paused: s.paused, pic: document.querySelector('#screen').dataset.picture } })()`))}`)
    check('the picture still follows the clock', ps.length > 100 && ps[ps.length >> 1] < 0.02, `median ${ms(ps[ps.length >> 1])}, max ${ms(ps.at(-1))}`)
    await page(`document.querySelector('#screen').dispatchEvent(new PointerEvent('pointermove', { clientX: 400, clientY: 300 }))`)
    nativeTheme.themeSource = 'light'
    await sleep(600)
    await shot('01-original-light')
    nativeTheme.themeSource = 'dark'
    await sleep(600)
    await shot('02-original-dark')
    nativeTheme.themeSource = 'system'

    // ---- Pause, a jump, another speed
    await click('#player-play', 600)
    check('pause pauses the original too', (await og()).paused && (await stats()).paused)
    await click('#player-play', 0)
    check('play brings it back in step', await until(heard, 5000))
    const before = (await stats()).at
    await press('Left', 0)
    await until(async () => Math.abs((await stats()).at - (before - 5)) < 1, 3000)
    check('a jump back: the original follows', await until(async () => { const o = await og(); return o.err !== null && Math.abs(o.err) < 0.05 && !o.paused }, 5000), `err ${ms((await og()).err)}`)
    await page(`document.querySelector('#gear-speeds [data-speed="1.5"]').click()`)
    await sleep(3000)
    await page('window.naqiOriginal().sync.length = 0')
    await sleep(15000)
    const s2 = syncOf((await og()).sync)
    results.speed15 = s2
    const o15 = await og()
    check('1.5x: the original plays at 1.5x, in step', Math.abs(o15.rate - 1.5) < 0.08 && s2.n > 100 && s2.max < 0.05, `rate ${o15.rate.toFixed(3)}, median ${ms(s2.median)}, max ${ms(s2.max)}`)
    await page(`document.querySelector('#gear-speeds [data-speed="1"]').click()`)

    // ---- Steady volume on: the original waits for the chain's delay
    await page(`document.querySelector('#gear-steady').click()`)
    await sleep(1500)
    await page('window.naqiOriginal().sync.length = 0')
    await sleep(10000)
    const s3 = syncOf((await og()).sync)
    results.steady = s3
    check('Steady volume on: still in step, the cleaned sound still silent', s3.max < 0.05 && (await og()).clean === 0, `median ${ms(s3.median)}, max ${ms(s3.max)}`)
    await page(`document.querySelector('#gear-steady').click()`)

    // ---- The corner keeps it
    await click('#watch-back', 1200)
    check('in the corner the original goes on', (await stats()).corner && await heard())
    await click('#corner-open', 1200)
    check('back in the player, still Original', (await shown()) === '#watch' && (await switchOn()) === 'original')

    // ---- Keys on the switch, then back to Clean
    await page(`document.querySelector('#sound-switch [data-value="original"]').focus()`)
    const at0 = (await stats()).at
    await press('Left', 600)
    const at1 = (await stats()).at
    check("the switch's arrow key picks Clean and leaves the playhead", (await switchOn()) === 'clean' && at1 >= at0 && at1 - at0 < 2, `${at0.toFixed(2)} -> ${at1.toFixed(2)} s`)
    check('Clean fades back in at once and the original stops', await until(async () => { const o = await og(); return o.mix === 0 && o.paused && o.clean > 0 }, 1500))
    await press('Right', 600)
    check('arrow right: Original again', (await switchOn()) === 'original' && await until(heard, 5000))

    // ---- Opens again on Clean
    check('Stop in the corner closes it', await stop())
    await page(`window.dispatchEvent(new Event('focus'))`)
    await sleep(800)
    await page(`document.querySelector('#lib li[data-id="${id}"] [data-act="play"]').click()`)
    await until(async () => (await shown()) === '#watch' && (await stats()).id === id && !(await stats()).paused, 30000)
    check('the item opens again on Clean', (await switchOn()) === 'clean' && (await og()).mix === 0, `${await switchOn()}, mix ${(await og()).mix}, id ${(await stats()).id}`)

    // ---- A link: its kept sound plays as it is
    await stop()
    await page(`(() => { const u = document.querySelector('#url'); u.value = ${JSON.stringify(LINK)}; u.dispatchEvent(new Event('input')) })()`)
    await click('#go', 0)
    await until(async () => (await shown()) === '#watch' && (await stats()).id !== id && (await stats()).firstPlaying !== null, 120000)
    const lid = (await stats()).id
    await click('#sound-switch [data-value="original"]', 0)
    check('a link: Original heard', await until(heard, 15000))
    const lfolder = readdirSync(hist).map((f) => join(hist, f)).find((f) => readdirSync(f).some((n) => n.startsWith('original.')))
    const lfiles = lfolder ? readdirSync(lfolder) : []
    check("a link's kept sound plays as it is (no copy)", lfiles.some((n) => n.startsWith('original.')) && !lfiles.some((n) => n.startsWith('original-play-')), lfiles.join(', '))
    await sleep(5000)
    const s4 = syncOf((await og()).sync)
    results.link = s4
    check('a link: in step', s4.n > 20 && s4.max < 0.05, `median ${ms(s4.median)}, max ${ms(s4.max)}`)
    // Its kept sound deleted (as the 2 weeks / 5 GB rule does): Original is off with a tip
    await stop()
    for (const n of lfiles.filter((n) => n.startsWith('original.'))) rmSync(join(lfolder, n), { force: true })
    await page(`window.dispatchEvent(new Event('focus'))`)
    await sleep(800)
    await page(`document.querySelector('#lib li[data-id="${lid}"] [data-act="play"]').click()`)
    await until(async () => (await shown()) === '#watch', 30000)
    await sleep(800)
    const off = await page(`(() => { const b = document.querySelector('#sound-switch [data-value="original"]'); return [b.disabled, b.dataset.tip] })()`)
    check('no kept sound: Original is off, its tip says why', off[0] && /no longer kept/.test(off[1]), off[1])
    await click('#sound-switch [data-value="original"]', 600)
    check('... and a click does nothing', (await switchOn()) === 'clean' && (await og()).mix === 0)

    // ---- A small window
    const [w, h] = win.getSize()
    const maxed = win.isMaximized()
    win.unmaximize()
    win.setSize(760, 560)
    await sleep(600)
    const fits = await page(`(() => { const s = document.querySelector('#sound-switch').getBoundingClientRect(); const c = document.querySelector('#screen').getBoundingClientRect(); return [s.width, s.right, c.right, document.documentElement.scrollWidth, innerWidth, [...document.querySelectorAll('body *')].filter((el) => el.getBoundingClientRect().right > innerWidth + 1 && el.getClientRects().length).slice(0, 6).map((el) => el.id || el.className).join(' | ')] })()`)
    const without = await page(`(() => { const s = document.querySelector('#sound-switch'); s.style.display = 'none'; const w = document.documentElement.scrollWidth; s.style.display = ''; return w })()`)
    note(`small window: page ${fits[3]} px wide with the switch, ${without} without it, window ${fits[4]}${fits[3] > fits[4] ? ` (wider than the window: ${fits[5]})` : ''}`)
    check('small window: the switch sits on the bar and makes the page no wider', fits[0] > 0 && fits[1] <= fits[2] && fits[3] <= Math.max(fits[4], without), fits.slice(0, 5).join(', '))
    await shot('03-small-window')
    win.setSize(w, h)
    if (maxed) win.maximize()
  } catch (e) {
    check('test ran without errors', false, e.stack || String(e))
  }
  writeFileSync(join(outDir, 'sync.json'), JSON.stringify(results, null, 1), 'utf-8')
  note(fails ? `${fails} check(s) FAILED` : 'ALL CHECKS PASSED')
  writeFileSync(join(outDir, 'log.txt'), log.join('\n') + '\n', 'utf-8')
  app.exit(fails ? 1 : 0)
}
