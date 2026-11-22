import { app, ipcMain, nativeTheme } from 'electron'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Dev check for T2.2 (run with NAQI_SELFTEST=home): drives the real Home page like a person would.
// Own files come in through "Files…" (the file dialog is answered by the test), a link through the link box; the
// main button starts each job, the job card is watched until it ends, and the saved files are looked for in the day
// folder. Meanwhile the page's frames and the main <-> page round trip are timed, to show the window never freezes.
// Saves into test_out/t2.2/saved (NAQIE_SAVE_DIR); screenshots and a log go to test_out/t2.2/.
const outDir = join(app.getAppPath(), 'test_out', 't2.2')
const samples = join(app.getAppPath(), 'samples')
const LINK = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'   // "Me at the zoo", 19 s

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function run(win, engine) {
  mkdirSync(outDir, { recursive: true })
  const saveDir = process.env.NAQIE_SAVE_DIR
  rmSync(saveDir, { recursive: true, force: true })
  const day = join(saveDir, new Date().toLocaleDateString('sv-SE'))   // YYYY-MM-DD, local date like the engine
  const log = []
  let fails = 0
  const t0 = Date.now()
  const note = (text) => { log.push(`${((Date.now() - t0) / 1000).toFixed(2)} s  ${text}`); console.log('[hometest]', text) }
  const check = (name, ok, detail = '') => { fails += !ok; note(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`) }
  const page = (js) => win.webContents.executeJavaScript(js)
  // A screenshot holds the page's frames for a moment itself, so the frame gap is read before and reset after it
  let gapMax = 0
  let gapAt = 0   // when the longest gap ended, to tell which step it was
  const readGap = async () => {
    const [gap, at] = await page('[window.__gap, window.__gapAt]')
    if (gap > gapMax) { gapMax = gap; gapAt = at }
  }
  const shot = async (name) => {
    await sleep(400)
    await readGap()
    writeFileSync(join(outDir, name), (await win.webContents.capturePage()).toPNG())
    await sleep(100)
    await page('window.__gap = 0')
  }
  const click = (sel) => page(`document.querySelector(${JSON.stringify(sel)}).click()`)
  const jobState = () => page(`document.querySelector('#job').hidden ? 'hidden' : document.querySelector('#job').dataset.state`)

  // Every job event the engine sends (the cleaned sound's path, ready seconds)
  let lastJob = null
  engine.on('event', (event, value) => { if (event === 'job') lastJob = value })

  // Freeze watch: the longest gap between two painted frames in the page, and the slowest main -> page answer
  await page(`window.__gap = 0; (() => { let last = performance.now(); const f = (t) => { if (t - last > window.__gap) { window.__gap = t - last; window.__gapAt = Date.now() } last = t; requestAnimationFrame(f) }; requestAnimationFrame(f) })()`)
  let slowest = 0
  let watching = true
  const ping = (async () => {
    while (watching) {
      const a = Date.now()
      await page('1')
      slowest = Math.max(slowest, Date.now() - a)
      await sleep(200)
    }
  })()

  async function waitJob(ms) {
    const end = Date.now() + ms
    let seen = 0
    while (Date.now() < end) {
      const s = await jobState()
      if (s === 'running') seen++
      if (s !== 'running' && s !== 'hidden' && seen) return s
      await sleep(250)
    }
    return 'timeout'
  }

  try {
    const until = Date.now() + 90000
    while (engine.status.status !== 'ready' && Date.now() < until) await sleep(250)
    check('engine ready', engine.status.status === 'ready', engine.status.gpu?.name)
    await sleep(800)
    await shot('1-home-empty.png')
    check('button waits for a link or files', await page(`document.querySelector('#go').disabled`))

    // 1. Own files through "Files…": a 30 s H.264 video and a 30 s MP3 -> 1 MP4 + 1 MP3
    const video = join(samples, 'codecs', 'h264.mp4')
    const sound = join(samples, 'narration_30s.mp3')
    ipcMain.removeHandler('choose-files')
    ipcMain.handle('choose-files', () => [video, sound])
    await click('#choose')
    await sleep(1500)   // the real kind check (ffprobe) answers
    const tags = await page(`[...document.querySelectorAll('.file .tag')].map((t) => t.textContent)`)
    check('file list shows AUDIO / VIDEO', tags.join('|') === 'VIDEO · MP4|AUDIO · MP3', tags.join(', '))
    const label = await page(`document.querySelector('#go').textContent.replace(/\\s+/g, ' ').trim()`)
    check('button names what it makes', label === 'Clean 2 files → 1 MP3 + 1 MP4', label)
    await click('#opt-toggle')
    await shot('2-files-options.png')
    let a = Date.now()
    await click('#go')
    await sleep(1500)
    await shot('3-files-running.png')
    const filesEnd = await waitJob(180000)
    const filesTime = (Date.now() - a) / 1000
    await shot('4-files-done.png')
    check('files job done', filesEnd === 'done', `${filesTime.toFixed(1)} s, card says: ${await page(`document.querySelector('#job-text').textContent`)}`)
    const made = existsSync(day) ? readdirSync(day) : []
    check('MP4 saved in the day folder', made.includes('h264.mp4'), made.join(', '))
    check('MP3 saved in the day folder', made.includes('narration_30s.mp3'))
    check('saved files leave the list', await page(`document.querySelectorAll('.file:not(.is-leaving)').length`) === 0)

    // 2. One link: "Clean and play" cleans and keeps its sound (cleaned.wav + history row), nothing is saved
    const savedBefore = existsSync(day) ? readdirSync(day).length : 0
    await page(`(() => { const u = document.querySelector('#url'); u.value = ${JSON.stringify(LINK)}; u.dispatchEvent(new Event('input')) })()`)
    await sleep(300)
    const playLabel = await page(`document.querySelector('#go').textContent.trim()`)
    check('one link: button is Clean and play, no Options', playLabel === 'Clean and play' && await page(`document.querySelector('#opt-box').hidden`), playLabel)
    await shot('5-link.png')
    a = Date.now()
    await click('#go')
    const linkEnd = await waitJob(240000)
    const linkJob = lastJob
    check('link cleaned and kept', linkEnd === 'done' && linkJob?.outcome === 'played', `${((Date.now() - a) / 1000).toFixed(1)} s, card says: ${await page(`document.querySelector('#job-text').textContent`)}`)
    check('cleaned sound kept in the history', !!linkJob?.wav && existsSync(linkJob.wav) && statSync(linkJob.wav).size > 1e6, linkJob?.wav)
    check('first part ready reported', linkJob?.ready_s > 0 && linkJob?.plays === true, `ready ${linkJob?.ready_s} s`)
    check('nothing saved for one link', (existsSync(day) ? readdirSync(day).length : 0) === savedBefore)
    check('no Show in folder for a kept item', await page(`document.querySelector('#show').hidden`))
    check('link box cleared', await page(`document.querySelector('#url').value`) === '')
    await shot('6-link-done.png')

    // 3. Errors in plain words: a link with no video
    await page(`(() => { const u = document.querySelector('#url'); u.value = 'https://example.com/'; u.dispatchEvent(new Event('input')) })()`)
    await click('#go')
    const badEnd = await waitJob(60000)
    const badText = await page(`document.querySelector('#job-text').textContent`)
    check('a bad link ends as a message', badEnd === 'error', badText)
    await shot('7-link-error.png')
    await page(`(() => { const u = document.querySelector('#url'); u.value = 'youtube.com/abc'; u.dispatchEvent(new Event('input')) })()`)
    await click('#go')
    await sleep(300)
    check('not a link: error under the field', !(await page(`document.querySelector('#url-help').hidden`)))
    await page(`(() => { const u = document.querySelector('#url'); u.value = ''; u.dispatchEvent(new Event('input')) })()`)

    // 4. Cancel: a 5 min file, stopped after 4 s; no half-made file is left
    const long = join(samples, 'narration_over_music.mp3')
    ipcMain.removeHandler('choose-files')
    ipcMain.handle('choose-files', () => [long])
    await click('#choose')
    await sleep(800)
    await click('#go')
    await sleep(4000)
    a = Date.now()
    await click('#go')   // the button is Cancel now
    const cancelEnd = await waitJob(20000)
    check('cancel stops the job', cancelEnd === 'cancelled', `${((Date.now() - a) / 1000).toFixed(1)} s`)
    check('nothing left behind', !readdirSync(day).some((n) => n.startsWith('narration_over_music')) &&
      !!lastJob?.wav && !existsSync(join(lastJob.wav, '..')))
    check('the cancelled file stays in the list', await page(`document.querySelectorAll('.file:not(.is-leaving)').length`) === 1)
    await shot('8-cancelled.png')

    // 5. The same page in the other theme
    const before = nativeTheme.themeSource
    nativeTheme.themeSource = nativeTheme.shouldUseDarkColors ? 'light' : 'dark'
    await sleep(600)
    await shot('9-other-theme.png')
    nativeTheme.themeSource = before

    watching = false
    await ping
    await readGap()
    check('window never froze', gapMax < 500 && slowest < 500,
      `longest frame gap ${gapMax.toFixed(0)} ms at ${((gapAt - t0) / 1000).toFixed(1)} s, slowest answer ${slowest} ms`)
  } catch (e) {
    check('test ran', false, e.stack)
  }
  watching = false
  note(fails ? `${fails} FAILED` : 'ALL PASS')
  writeFileSync(join(outDir, 'log.txt'), log.join('\n') + '\n')
  app.quit()
}
