import { app, ipcMain, nativeTheme } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Dev check for T13.9 (run with NAQI_SELFTEST=slips and NAQIE_DATA pointing to a folder named naqie-t13.9, outside
// OneDrive; it is emptied first; GPU, about 2 min): rating and a quick slip inside the player. A 60 s video
// (samples/frames/fps30.mp4) is cleaned and played; Good / Perfect / Bad next to the title are saved in the history
// (Bad opens the quick slip in the player, not the report page); Quick slip pauses at the playhead and fills the 6 s
// up to it; a slip saved there writes the same slip_cases.csv row and sound copy as the report page (one of each is
// saved and compared); empty, wrong and duplicate slips are refused; Escape closes the row and stays in the player;
// "Report page" opens the full page at the moment. Light, dark and a small window. Log and shots in test_out/t13.9/.
const outDir = join(app.getAppPath(), 'test_out', 't13.9')
const CLIP = join(app.getAppPath(), 'samples', 'frames', 'fps30.mp4')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function run(win, engine) {
  mkdirSync(outDir, { recursive: true })
  const log = []
  let fails = 0
  const t0 = Date.now()
  const note = (text) => { log.push(`${((Date.now() - t0) / 1000).toFixed(2)} s  ${text}`); console.log('[slipstest]', text) }
  const check = (name, ok, detail = '') => { fails += !ok; note(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`) }
  const page = (js) => win.webContents.executeJavaScript(js)
  const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(150) } return false }
  const shot = async (name) => writeFileSync(join(outDir, `${name}.png`), (await win.webContents.capturePage()).toPNG())
  const click = async (sel, wait = 400) => { await page(`document.querySelector(${JSON.stringify(sel)}).click()`); await sleep(wait) }
  const stats = () => page('window.naqiPlayerStats()')
  const shown = () => page(`(() => ['.home', '#watch', '#report'].find((s) => !document.querySelector(s).hidden))()`)
  const panelOpen = () => page(`document.querySelector('#slip-panel').dataset.open === 'true'`)
  const status = () => page(`document.querySelector('#qs-status').textContent`)
  const fill = (sel, v) => page(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); b.value = ${JSON.stringify(v)}; b.dispatchEvent(new Event('input')) })()`)
  const rating = async (id) => (await page('window.naqi.library()')).items.find((x) => x.id === id)?.rating ?? null
  const shownRating = () => page(`document.querySelector('#watch-rate [aria-checked="true"]')?.dataset.value ?? null`)
  const press = async (keyCode, wait = 400) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
    await sleep(wait)
  }
  const data = process.env.NAQIE_DATA || ''
  const csvRows = () => {
    const f = join(data, 'slip_cases.csv')
    return existsSync(f) ? readFileSync(f, 'utf-8').split(/\r?\n/).filter(Boolean) : []
  }
  const caseFiles = () => (existsSync(join(data, 'cases')) ? readdirSync(join(data, 'cases')) : [])
  const saveAndWait = async () => {
    await page(`document.querySelector('#qs-status').textContent = ''`)
    await click('#qs-save', 0)
    await until(async () => !(await page(`document.querySelector('#qs-save').disabled`)) && (await status()), 60000)
    return status()
  }

  try {
    if (!/naqie-t13\.9[\\/]?$/.test(data)) throw new Error('NAQIE_DATA must be a folder named naqie-t13.9 (the real history is never used)')
    rmSync(data, { recursive: true, force: true })
    check('engine ready with the models', await until(async () => engine.status.status === 'ready' && (await engine.call('/health')).models, 120000), engine.status.gpu?.name)
    ipcMain.removeHandler('choose-files')
    ipcMain.handle('choose-files', () => [CLIP])
    await click('#choose', 800)
    await click('#go', 0)
    check('the player opens', await until(async () => (await shown()) === '#watch', 120000))
    await until(async () => (await stats()).firstPlaying !== null && !(await stats()).live, 120000)
    const id = await page(`(async () => (await window.naqi.library()).items[0].id)()`)

    // ---- Rating next to the title
    check('Bad / Good / Perfect and Quick slip next to the title', await page(`!document.querySelector('#watch-verdict').hidden && document.querySelectorAll('#watch-rate button').length === 3`))
    check('no rating yet', (await shownRating()) === null)
    await click('#watch-rate [data-value="good"]', 600)
    check('Good saved in the history', (await rating(id)) === 'good' && (await shownRating()) === 'good')
    await click('#watch-rate [data-value="perfect"]', 600)
    check('changed to Perfect', (await rating(id)) === 'perfect' && (await shownRating()) === 'perfect')
    check('rating did not stop the sound or leave the player', (await shown()) === '#watch' && !(await stats()).paused)

    // ---- Quick slip at the playhead
    await until(async () => (await stats()).at > 21, 30000)
    await click('#slip-toggle', 600)
    const at = (await stats()).at
    const end = Math.floor(at) + 1
    const stamp = (t) => `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
    const times = await page(`[document.querySelector('#qs-from').value, document.querySelector('#qs-to').value]`)
    check('Quick slip opens under the player, paused, still the player', await panelOpen() && (await stats()).paused && (await shown()) === '#watch')
    check('the 6 s up to the playhead filled in', times[0] === stamp(end - 6) && times[1] === stamp(end), `${times.join(' to ')} at ${at.toFixed(2)} s`)
    nativeTheme.themeSource = 'light'
    await sleep(600)
    await shot('01-quick-slip-light')
    nativeTheme.themeSource = 'dark'
    await sleep(600)
    await shot('02-quick-slip-dark')
    nativeTheme.themeSource = 'system'

    await click('#qs-kind [data-value="speech"]', 200)
    await fill('#qs-note', '  a word   cut  ')
    const before = csvRows().length
    const s1 = await saveAndWait()
    check('the slip saves', /^Saved\. 1 slip saved so far/.test(s1), s1)
    const row = csvRows().at(-1)?.split(',')
    check('a slip_cases.csv row with the moment, the kind and the note', csvRows().length === before + 2 && row[0] === CLIP && row[1] === times[0] && row[2] === times[1] && row[3] === 'speech' && row[4] === 'a word cut', csvRows().at(-1))
    check('a copy of the sound in cases\\', caseFiles().length === 1, caseFiles().join(', '))
    check('the note is emptied, the times stay', (await page(`document.querySelector('#qs-note').value`)) === '' && (await page(`document.querySelector('#qs-from').value`)) === times[0])
    const dup = await saveAndWait()
    check('the same slip again is refused', /already saved/.test(dup) && csvRows().length === before + 2, dup)
    await fill('#qs-from', '0:30')
    await fill('#qs-to', '0:20')
    const wrong = await saveAndWait()
    check("'To' before 'From' is refused", /must be after/.test(wrong), wrong)
    await fill('#qs-from', '')
    await fill('#qs-to', '0:20')
    const empty = await saveAndWait()
    check('an empty time is asked for', /Write when the slip starts/.test(empty), empty)
    await fill('#qs-from', '0:58')
    await fill('#qs-to', '1:30')
    const past = await saveAndWait()
    check('past the end is refused', /only .* long/.test(past), past)

    // ---- Escape closes the row, the player stays
    await page(`document.querySelector('#qs-note').focus()`)
    await press('Escape')
    check('Escape closes the quick slip and stays in the player', !(await panelOpen()) && (await shown()) === '#watch')

    // ---- Bad: the quick slip in the player, not the report page
    await page(`document.querySelector('#player-play').click()`)
    await until(async () => (await stats()).at > 32, 20000)
    await click('#watch-rate [data-value="bad"]', 800)
    check('Bad saved', (await rating(id)) === 'bad' && (await shownRating()) === 'bad')
    check('Bad opens the quick slip in the player (paused), not the report page', await panelOpen() && (await shown()) === '#watch' && (await stats()).paused)
    await click('#qs-kind [data-value="music"]', 200)
    const s2 = await saveAndWait()
    check('a second slip saves', /^Saved\. 2 slips saved so far/.test(s2), s2)

    // ---- The report page saves the same kind of row (compared field by field)
    await click('#qs-more', 1200)
    check('Report page opens the full page with the file', (await shown()) === '#report' && (await page(`document.querySelector('#source').value`)) === CLIP)
    await fill('#from', '0:40')
    await fill('#to', '0:44')
    await page(`document.querySelector('#slip-kind [data-value="speech"]').click()`)
    await fill('#note', '  a word   cut  ')
    await click('#save-slip', 0)
    await until(async () => /Saved/.test(await page(`document.querySelector('#report-status').textContent`)), 60000)
    const rows = csvRows().slice(1).map((r) => r.split(','))
    const [quick, page2] = [rows[0], rows.at(-1)]
    check('the report page row matches the quick slip row (source, kind, note, date)', rows.length === 3 && [0, 3, 4, 5].every((i) => quick[i] === page2[i]), `${quick.join(',')} | ${page2.join(',')}`)
    check('one sound copy per source either way', caseFiles().length === 1, caseFiles().join(', '))
    await page(`document.querySelector('#report-back').click()`)
    check('Back returns to the player', await until(async () => (await shown()) === '#watch', 3000))

    // ---- A small window
    const [w, h] = win.getSize()
    const maxed = win.isMaximized()
    win.unmaximize()
    win.setSize(760, 560)
    await sleep(500)
    await click('#slip-toggle', 600)
    const fits = await page(`(() => { const r = document.querySelector('#watch-verdict').getBoundingClientRect(); return r.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth })()`)
    check('small window: the verdict and the row fit', fits)
    await shot('03-small-window')
    win.setSize(w, h)
    if (maxed) win.maximize()
  } catch (e) {
    check('test ran without errors', false, e.stack || String(e))
  }
  note(fails ? `${fails} check(s) FAILED` : 'ALL CHECKS PASSED')
  writeFileSync(join(outDir, 'log.txt'), log.join('\n') + '\n', 'utf-8')
  app.exit(fails ? 1 : 0)
}
