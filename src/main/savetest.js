import { app, ipcMain, nativeTheme } from 'electron'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Dev check for T4.3 (run with NAQI_SELFTEST=save, NAQIE_DATA pointing to a folder named naqie-t4.3 outside OneDrive
// (emptied first) and NAQIE_SAVE_DIR to the folder saves go into; GPU + internet, about 4 min): "Save…" in the
// player on the real page. A. a 5 min video with "Clean and play": Save waits while it is cleaned, then MP3
// (timed), MP4 Original cancelled (no half file). B. a 19 s YouTube link: MP4 720p (its video downloaded only now,
// then deleted) and MP3, both remembered: the library row shows the format and Show in folder. C. an own MP3: only
// MP3 offered. D. the link's cleaned sound tidied away: it plays its saved MP4 and Save says why it is off.
// Screenshots in light and dark, log in test_out/t4.3/.
const outDir = join(app.getAppPath(), 'test_out', 't4.3')
const samples = join(app.getAppPath(), 'samples')
const LINK = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'   // "Me at the zoo", 19 s
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const day = () => new Date().toLocaleDateString('sv-SE')   // YYYY-MM-DD, local time like the engine

export async function run(win, engine) {
  mkdirSync(outDir, { recursive: true })
  const log = []
  let fails = 0
  const t0 = Date.now()
  const note = (text) => { log.push(`${((Date.now() - t0) / 1000).toFixed(2)} s  ${text}`); console.log('[savetest]', text) }
  const check = (name, ok, detail = '') => { fails += !ok; note(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`) }
  const page = (js) => win.webContents.executeJavaScript(js)
  const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(150) } return false }
  const shot = async (name) => { await sleep(500); writeFileSync(join(outDir, name), (await win.webContents.capturePage()).toPNG()) }
  const click = (sel) => page(`document.querySelector(${JSON.stringify(sel)}).click()`)
  const q = (sel, js) => page(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); return ${js} })()`)
  const watching = () => page(`!document.querySelector('#watch').hidden`)
  const status = () => q('#save-status', 'el.textContent')
  const ui = () => page(`(() => { const $ = (s) => document.querySelector(s); return {
    toggle: !$('#save-toggle').hidden, enabled: !$('#save-toggle').disabled, tip: $('#save-toggle').dataset.tip,
    open: $('#save-panel').dataset.open === 'true', fmt: !$('#save-fmt').hidden, size: !$('#save-size').hidden,
    kbps: !$('#save-kbps').hidden, go: $('#save-go').textContent, goOff: $('#save-go').disabled,
    show: !$('#save-show').hidden, status: $('#save-status').textContent } })()`)
  const jobs = []
  const saves = []
  engine.on('event', (event, v) => {
    if (event === 'job' && v.state !== 'running') jobs.push(v)
    if (event === 'save' && v.state !== 'running') saves.push(v)
  })
  const lastJob = () => jobs.filter((j) => j.kind === 'play').at(-1)
  const saveDir = process.env.NAQIE_SAVE_DIR || ''
  const dayFiles = () => (existsSync(join(saveDir, day())) ? readdirSync(join(saveDir, day())).sort() : [])
  const historyDirs = () => (existsSync(join(process.env.NAQIE_DATA, 'history')) ? readdirSync(join(process.env.NAQIE_DATA, 'history')) : [])
  const cleanAndPlay = async (setup) => {
    await page(`document.querySelector('#watch').hidden || document.querySelector('#watch-back').click()`)
    await setup()
    await sleep(800)
    await click('#go')
  }
  const pick = (sel, value) => click(`${sel} [data-value="${value}"]`)
  // Presses Save with the choices given; resolves with the finished save event and its time
  const save = async ({ fmt, size, kbps, cancelAt }) => {
    if ((await ui()).fmt) await pick('#save-fmt', fmt)
    if (size) await pick('#save-size', size)
    if (kbps) await pick('#save-kbps', kbps)
    const n = saves.length
    const start = Date.now()
    await click('#save-go')
    if (cancelAt !== undefined) {
      check('button turned into Cancel', await until(async () => (await ui()).go === 'Cancel', 5000))
      await until(async () => (await q('#save-bar', "+el.style.getPropertyValue('--p')")) >= cancelAt, 60000)
      await click('#save-go')
    }
    await until(async () => saves.length > n, 300000)
    await sleep(300)
    return { s: saves.at(-1), sec: (Date.now() - start) / 1000 }
  }
  const theme = nativeTheme.themeSource

  try {
    const data = process.env.NAQIE_DATA || ''
    if (!/naqie-t4\.3[\\/]?$/.test(data)) throw new Error('NAQIE_DATA must be a folder named naqie-t4.3 (the real history is never used)')
    if (!saveDir) throw new Error('NAQIE_SAVE_DIR must be set (the real Save to folder is never used)')
    rmSync(data, { recursive: true, force: true })
    rmSync(saveDir, { recursive: true, force: true })
    check('engine ready with the models', await until(async () => engine.status.status === 'ready' && (await engine.call('/health')).models, 120000), engine.status.gpu?.name)
    nativeTheme.themeSource = 'dark'

    // A. A 5 min own video: Save waits while it is cleaned
    ipcMain.removeHandler('choose-files')
    ipcMain.handle('choose-files', () => [join(samples, 'sync_test_5min.mp4')])
    await cleanAndPlay(() => click('#choose'))
    check('A. the player opens by itself', await until(watching, 120000))
    let u = await ui()
    check('A. while cleaned: Save shown but off, says why', u.toggle && !u.enabled && u.tip === 'Save is ready when all of it is clean', u.tip)
    check('A. cleaning finishes', await until(async () => lastJob()?.state === 'done', 300000))
    await sleep(500)
    u = await ui()
    check('A. all clean: Save turns on', u.toggle && u.enabled, u.tip)
    check('A. nothing saved yet: no Show in folder', !u.show)
    await click('#save-toggle')
    await sleep(400)
    u = await ui()
    check('A. panel opens: MP3 / MP4, MP4 sizes shown', u.open && u.fmt && u.size && !u.kbps)
    await shot('1-panel-dark.png')
    await pick('#save-fmt', 'mp3')
    u = await ui()
    check('A. MP3 picked: quality shown instead of size', !u.size && u.kbps)
    let { s, sec } = await save({ fmt: 'mp3', kbps: '192 kbps' })
    check('A. 5 min MP3 saved', s.state === 'done' && existsSync(s.path) && dayFiles().includes('sync_test_5min.mp3'), `${sec.toFixed(1)} s, ${(statSync(s.path).size / 2 ** 20).toFixed(1)} MB`)
    u = await ui()
    check('A. status names the file, Show in folder appears', u.status === 'Saved: sync_test_5min.mp3' && u.show, u.status)
    await shot('2-saved-dark.png')
    const before = dayFiles()
    ;({ s, sec } = await save({ fmt: 'mp4', size: 'Original', cancelAt: 0.15 }))
    check('A. Cancel during the MP4', s.state === 'cancelled' && (await status()) === 'Not saved.', `${sec.toFixed(1)} s`)
    check('A. no half file left', JSON.stringify(dayFiles()) === JSON.stringify(before), dayFiles().join(', '))
    u = await ui()
    check('A. Cancel turned back into Save', u.go === 'Save' && !u.goOff)
    const longRow = lastJob().row_id

    // B. A 19 s link: MP4 720p (downloaded only now) and MP3
    nativeTheme.themeSource = 'light'
    const dirsBefore = historyDirs()
    await cleanAndPlay(() => page(`(() => { const u = document.querySelector('#url'); u.value = ${JSON.stringify(LINK)}; u.dispatchEvent(new Event('input')) })()`))
    check('B. link plays', await until(watching, 120000))
    check('B. cleaning finishes', await until(async () => lastJob()?.state === 'done' && lastJob()?.row_id !== longRow, 120000))
    const linkRow = lastJob().row_id
    const linkDir = join(data, 'history', historyDirs().find((d) => !dirsBefore.includes(d)))
    await until(async () => (await ui()).enabled, 3000)
    if (!(await ui()).open) await click('#save-toggle')
    ;({ s, sec } = await save({ fmt: 'mp4', size: '720p' }))
    check('B. link MP4 720p saved', s.state === 'done' && /Me at the zoo\.mp4$/.test(s.path || ''), `${sec.toFixed(1)} s`)
    check('B. its downloaded video was deleted', !readdirSync(linkDir).some((f) => f.startsWith('video.')), readdirSync(linkDir).join(', '))
    const linkMp4 = s.path
    ;({ s, sec } = await save({ fmt: 'mp3', kbps: '128 kbps' }))
    check('B. link MP3 saved in under 1 s', s.state === 'done' && sec < 1.5, `${sec.toFixed(2)} s from the click`)
    await shot('3-link-light.png')
    await page(`window.dispatchEvent(new Event('focus'))`)
    await sleep(800)
    const lib = await engine.call('/library')
    const it = lib.items.find((x) => x.id === linkRow)
    check('B. library item: Show in folder = the newest saved file, format MP3', it?.show === s.path && it?.format === 'MP3', `${it?.format} ${it?.show}`)
    check('B. its library row offers Show in folder', await page(`!document.querySelector('#lib li[data-id="${linkRow}"] [data-act="show"]').hidden`))

    // C. An own MP3: only MP3
    ipcMain.removeHandler('choose-files')
    ipcMain.handle('choose-files', () => [join(samples, 'narration_30s.mp3')])
    await cleanAndPlay(() => click('#choose'))
    check('C. own MP3 plays', await until(watching, 120000))
    check('C. cleaning finishes', await until(async () => lastJob()?.state === 'done' && lastJob()?.row_id !== linkRow, 120000))
    await sleep(500)
    if (!(await ui()).open) await click('#save-toggle')
    await sleep(400)
    u = await ui()
    check('C. a sound: no MP4 offered, MP3 quality shown', !u.fmt && !u.size && u.kbps)
    ;({ s, sec } = await save({ kbps: '320 kbps' }))
    check('C. own MP3 saved', s.state === 'done' && /narration_30s\.mp3$/.test(s.path || ''), `${sec.toFixed(2)} s`)

    // D. The link's cleaned sound tidied away: it plays the saved MP4, Save is off and says why
    await click('#watch-back')
    await page(`document.querySelector('#corner').hidden || document.querySelector('#corner-close').click()`)   // the corner (T10.2c) would keep the cleaned sound open
    await sleep(500)
    unlinkSync(join(linkDir, 'cleaned.wav'))
    await page(`window.dispatchEvent(new Event('focus'))`)
    await sleep(800)
    await page(`window.dispatchEvent(new CustomEvent('naqi-play', { detail: { id: ${linkRow} } }))`)
    const jobsBefore = jobs.length
    check('D. plays without cleaning again', await until(watching, 10000) && jobs.length === jobsBefore)
    check('D. its picture shows (from the saved MP4)', await until(() => q('#screen', "el.dataset.picture === 'shown'"), 15000))
    check('D. it plays', await until(() => page(`window.naqiPlayerStats().firstPlaying !== null`), 10000))
    u = await ui()
    check('D. Save off, says why', u.toggle && !u.enabled && /Saved already/.test(u.tip || ''), u.tip)
    check('D. Show in folder still there', u.show)
    check('D. saved MP4 still there', existsSync(linkMp4))
    await shot('4-from-saved-light.png')

    // Narrow window: the panel wraps
    await click('#save-toggle')
    const [ww, wh] = win.getSize()
    win.setSize(760, 700)
    await page(`(() => { const l = document.querySelector('#watch-back'); l.click() })()`)
    await page(`window.dispatchEvent(new CustomEvent('naqi-play', { detail: { id: ${longRow} } }))`)
    await until(watching, 10000)
    await sleep(500)
    await click('#save-toggle')
    await shot('5-narrow-light.png')
    win.setSize(ww, wh)
    note(`saved files: ${dayFiles().join(', ')}`)
  } catch (e) {
    check('test ran', false, e.message)
  } finally {
    nativeTheme.themeSource = theme
    note(fails ? `${fails} check(s) FAILED` : 'ALL PASSED')
    writeFileSync(join(outDir, 'log.txt'), log.join('\n') + '\n')
    setTimeout(() => app.quit(), 500)
  }
}
