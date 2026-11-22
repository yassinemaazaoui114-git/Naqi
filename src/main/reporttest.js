import { app, ipcMain, nativeTheme } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

// Dev check for T5.1 (run with NAQI_SELFTEST=report and NAQIE_DATA pointing to a folder named naqie-t5.1, outside
// OneDrive; it is emptied first): "Report a slip" on the real page. A seeded history (engine/seed_report.py) gives a
// played link with its kept sound, one whose kept sound is gone, and an own file saved as MP3. The page is opened
// from the side bar; slips are saved from Recent files, from a picked cleaned file (found in the history), from a
// picked own video (sound only, FLAC) and checked in slip_cases.csv and the cases folder like old Naqi: header, row,
// the copy (the link's kept sound byte for byte), "Slip reported" on the row; wrong times, a moment past the end and
// a duplicate are refused with old Naqi's words. Then a Bad rating in the library opens the page with that file
// filled in. T5.2: the sound strip plays the picked file's cleaned sound (its shape with the muted gap flat), real
// clicks and arrow keys move the playhead, From here / To here fill the times, the moment is lit and plays again up
// to To; files with no cleaned sound in Naqi say so. No internet needed (nothing is downloaded). Screenshots in light
// and dark, log in test_out/t5.1/.
const outDir = join(app.getAppPath(), 'test_out', 't5.1')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha = (path) => createHash('sha1').update(readFileSync(path)).digest('hex')

export async function run(win, engine) {
  mkdirSync(outDir, { recursive: true })
  const log = []
  let fails = 0
  const t0 = Date.now()
  const note = (text) => { log.push(`${((Date.now() - t0) / 1000).toFixed(2)} s  ${text}`); console.log('[reporttest]', text) }
  const check = (name, ok, detail = '') => { fails += !ok; note(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`) }
  const page = (js) => win.webContents.executeJavaScript(js)
  const shot = async (name) => { await sleep(500); writeFileSync(join(outDir, name), (await win.webContents.capturePage()).toPNG()) }
  const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(150) } return false }
  const value = (sel) => page(`document.querySelector(${JSON.stringify(sel)}).value`)
  const text = (sel) => page(`document.querySelector(${JSON.stringify(sel)}).textContent`)
  const type = (sel, v) => page(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('input')) })()`)
  const click = (sel) => page(`document.querySelector(${JSON.stringify(sel)}).click()`)
  const status = () => text('#report-status')
  const recent = () => page(`[...document.querySelectorAll('#recent li[data-id]')].map((li) => ({ id: +li.dataset.id,
    title: li.querySelector('.lib-title').textContent, meta: li.querySelector('.lib-meta').textContent,
    current: li.querySelector('.lib-row').getAttribute('aria-current') === 'true' }))`)
  // Fills the form and presses Save; resolves with the status once saving is over
  const save = async ({ from, to, kind = 'music', note: n = '' }) => {
    await type('#from', from)
    await type('#to', to)
    await type('#note', n)
    await click(`#slip-kind [data-value="${kind}"]`)
    await click('#save-slip')
    await until(async () => !(await page(`document.querySelector('#save-slip').disabled`)), 60000)
    return status()
  }
  const theme = nativeTheme.themeSource
  const st = () => page('window.naqiStrip()')
  const press = async (keyCode, n = 1) => {
    for (let i = 0; i < n; i++) {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
      await sleep(120)
    }
  }
  // A real mouse click at a fraction of the strip's width
  const clickBar = async (f) => {
    const r = await page(`(() => { const b = document.querySelector('#strip-bar').getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height } })()`)
    const x = Math.round(r.x + r.w * f)
    const y = Math.round(r.y + r.h / 2)
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y })
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    await sleep(250)
  }
  const near = (a, b, d) => Math.abs(a - b) <= d
  const stamp = (t) => { const x = Math.round(t * 10); return `0:${String(Math.floor(x / 10)).padStart(2, '0')}${x % 10 ? `.${x % 10}` : ''}` }

  try {
    const data = process.env.NAQIE_DATA || ''
    if (!/naqie-t5\.1[\\/]?$/.test(data)) throw new Error('NAQIE_DATA must be a folder named naqie-t5.1 (the real history is never used)')
    const csv = join(data, 'slip_cases.csv')
    const casesDir = join(data, 'cases')
    check('engine ready', await until(() => engine.status.status === 'ready', 90000), engine.status.gpu?.name)
    const seeded = JSON.parse(await new Promise((resolve, reject) => execFile('py',
      ['-3.12', join(app.getAppPath(), 'engine', 'seed_report.py'), join(outDir, 'files')],
      { env: process.env, windowsHide: true }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)))))
    await page(`window.dispatchEvent(new Event('focus'))`)
    await sleep(600)
    nativeTheme.themeSource = 'light'

    // Opened from the side bar
    await click('#open-report')
    check('side bar button opens the page', await until(() => page(`!document.querySelector('#report').hidden && document.querySelector('.home').hidden`), 3000))
    await until(async () => (await recent()).length === 3, 3000)
    let rows = await recent()
    check('Recent files: 3 rows, newest first', rows.length === 3 && rows[0].title.startsWith('How the desert') && rows[2].title === 'Friday talk.mp3',
      rows.map((x) => x.title).join(' | '))
    check('no slips yet: no count shown', (await status()) === '', await status())
    check('source hint for own files', (await text('#source-help')) === 'For your own files, pick the original (not the cleaned copy).')
    await shot('1-open-light.png')

    // Empty form: old Naqi's words
    await click('#save-slip')
    await sleep(200)
    check('nothing picked: asks for the file', (await status()) === 'Paste the link or pick the file first.')

    // 1. From Recent files: the played link, its kept sound is used
    await page(`document.querySelector('#recent li[data-id="${seeded.link_row}"] .lib-row').click()`)
    await until(async () => (await value('#source')) !== '', 3000)
    check('row picked: source is its link', (await value('#source')) === 'https://www.youtube.com/watch?v=jNQXAC9IVRw')
    check('... hint: kept sound is used', (await text('#source-help')) === 'From your recent files: How the desert keeps its water, its original sound, kept when it was cleaned, is used.',
      await text('#source-help'))
    check('... row marked', (await recent()).find((x) => x.id === seeded.link_row).current)
    check('... focus goes to From', await page(`document.activeElement.id`) === 'from')
    await type('#from', '0:05')
    check('From only: no length shown', (await text('#moment-len')) === '')
    await type('#to', '0:08.5')
    check('the moment shows its length', (await text('#moment-len')) === '3.5 s', await text('#moment-len'))
    await type('#to', '')
    await click('#save-slip')
    await sleep(200)
    check('no end time: asks for it', (await status()) === 'Write when the slip ends, e.g. 1:26.')
    let s = await save({ from: 'abc', to: '0:08' })
    check('wrong time: explains how to write it', s === 'Write the times like 1:23 (minutes:seconds) or 83.5 (seconds).', s)
    s = await save({ from: '0:08', to: '0:05' })
    check("To before From: refused", s === "'To' must be after 'From'.", s)
    await shot('2-filled-light.png')
    const t1 = Date.now()
    s = await save({ from: '0:05', to: '0:08', kind: 'music', note: '  drums   under the talking ' })
    note(`saved in ${Date.now() - t1} ms`)
    check('saved: thanks with the count', s === 'Saved. 1 slip saved so far. Thank you!', s)
    check('... the form empties, the file stays', (await value('#from')) === '' && (await value('#note')) === '' &&
      (await value('#source')) === 'https://www.youtube.com/watch?v=jNQXAC9IVRw')
    const today = new Date().toLocaleDateString('sv-SE')
    let lines = existsSync(csv) ? readFileSync(csv, 'utf8').trim().split(/\r?\n/) : []
    check('CSV header as old Naqi', lines[0] === 'source,start,end,expect,note,added', lines[0])
    check('CSV row as old Naqi', lines[1] === `https://www.youtube.com/watch?v=jNQXAC9IVRw,0:05,0:08,music,drums under the talking,${today}`, lines[1])
    check('CSV written without BOM', readFileSync(csv)[0] !== 0xef)
    const key = createHash('sha1').update('https://www.youtube.com/watch?v=jNQXAC9IVRw').digest('hex').slice(0, 12)
    const copies = existsSync(join(casesDir, key)) ? readdirSync(join(casesDir, key)) : []
    check('sound copy in cases/<key>: the kept sound, byte for byte', copies.length === 1 && sha(join(casesDir, key, copies[0])) === sha(seeded.kept), copies.join(', '))
    await until(async () => (await recent()).find((x) => x.id === seeded.link_row)?.meta.endsWith('Slip reported'), 3000)
    rows = await recent()
    check('row now says Slip reported', rows.find((x) => x.id === seeded.link_row).meta.endsWith('· Slip reported'), rows.find((x) => x.id === seeded.link_row).meta)
    check('... and stays picked', rows.find((x) => x.id === seeded.link_row).current)
    s = await save({ from: '0:05', to: '0:08', kind: 'music' })
    check('same slip again: refused', s === 'This slip is already saved.', s)
    s = await save({ from: '0:20', to: '1:10', kind: 'music' })
    check('past the end: refused with the length', s === 'The sound is only 0:30.0 long.', s)
    await type('#from', '')
    await type('#to', '')

    // T5.2: the sound strip on the picked link (its cleaned sound has 10 s to 14 s muted)
    check('strip: ready for the picked file', await until(async () => (await st()).state === 'ready', 5000), (await st()).note)
    let w = await st()
    check('strip: length of the cleaned sound', near(w.length, 30, 0.5), `${w.length} s, ${w.peaks.length} peaks, ${w.bars} bars`)
    const peakAt = (t0, t1) => Math.max(...w.peaks.filter((_, i) => i * w.length / w.peaks.length >= t0 && (i + 1) * w.length / w.peaks.length <= t1))
    check('strip: the muted part is flat, the talking is not', peakAt(10.3, 13.7) < 0.01 && peakAt(0, 9.7) > 0.1,
      `muted max ${peakAt(10.3, 13.7)}, talking max ${peakAt(0, 9.7)}`)
    check('strip: no moment lit yet', !w.lit)
    await click('#strip-play')
    check('strip: plays', await until(async () => { const x = await st(); return !x.paused && x.at > 1 }, 5000), `at ${(await st()).at.toFixed(2)} s`)
    await shot('7-strip-playing-light.png')
    await click('#strip-play')
    await until(async () => (await st()).paused, 2000)
    await clickBar(0.2)
    w = await st()
    check('strip: a click jumps there', near(w.at, 6, 0.3), `${w.at.toFixed(2)} s`)
    await click('#from-here')
    check('From here: the playhead time', (await value('#from')) === stamp(w.at), `${await value('#from')} at ${w.at.toFixed(2)} s`)
    await page(`document.querySelector('#strip-bar').focus()`)
    await press('Right', 3)
    const w2 = await st()
    check('arrow keys: 3 x Right = +3 s', near(w2.at - w.at, 3, 0.05), `${w.at.toFixed(2)} -> ${w2.at.toFixed(2)} s`)
    await press('Left')
    check('arrow keys: Left = -1 s', near((await st()).at - w2.at, -1, 0.05))
    await press('Right')
    await click('#to-here')
    w = await st()
    check('To here: the moment is filled and lit', (await text('#moment-len')) === '3 s' && w.lit && near(w.a, 0.2, 0.02) && near(w.b, 0.3, 0.02),
      `${await value('#from')} to ${await value('#to')}, ${await text('#moment-len')}, lit ${w.a.toFixed(3)} to ${w.b.toFixed(3)}`)
    await page(`document.querySelector('#strip-bar').focus()`)
    await press('Space')
    check('Space on the strip plays', await until(async () => !(await st()).paused, 2000))
    await press('Space')
    await until(async () => (await st()).paused, 2000)
    await clickBar(0.9)
    await click('#play-moment')
    const started = await until(async () => { const x = await st(); return !x.paused && x.at < 9.5 }, 2000)
    const fromAt = (await st()).at
    const stopped = await until(async () => (await st()).paused, 6000)
    w = await st()
    check('Play the moment: from From, stops at To', started && near(fromAt, w.moment[0], 0.5) && stopped && near(w.at, w.moment[1], 0.15),
      `played ${fromAt.toFixed(2)} -> stopped at ${w.at.toFixed(2)} (moment ${w.moment.map((t) => t.toFixed(2)).join(' to ')})`)
    await type('#from', '0:20')
    await type('#to', '25')
    w = await st()
    check('typed times light the moment too', w.lit && near(w.a, 0.667, 0.02) && near(w.b, 0.833, 0.02))
    await sleep(400)
    await shot('8-strip-moment-light.png')
    nativeTheme.themeSource = 'dark'
    await shot('9-strip-moment-dark.png')
    nativeTheme.themeSource = 'light'
    await type('#to', '0:10')
    check('To before From: nothing lit', !(await st()).lit)
    await type('#from', '')
    await type('#to', '')

    // 2. The link whose kept sound is gone: it would be downloaded again (only the hint is checked, no internet)
    await page(`document.querySelector('#recent li[data-id="${seeded.old_row}"] .lib-row').click()`)
    await until(async () => (await value('#source')).includes('oldlecture1'), 3000)
    check('kept sound gone: hint says it is downloaded again', (await text('#source-help')).endsWith('its kept sound was already deleted, so it will be downloaded again.'))
    check('strip: cleaned sound tidied away, says so', await until(async () => (await st()).state === 'none', 3000) &&
      (await st()).note.startsWith('Its cleaned sound was tidied away'), (await st()).note)
    check('... its buttons are off', await page(`['#strip-play', '#from-here', '#to-here', '#play-moment'].every((s) => document.querySelector(s).disabled)`))
    await shot('10-strip-none-light.png')

    // 3. Pick… a cleaned file: found in the history (the own original is used)
    let picked = []
    ipcMain.removeHandler('choose-file')
    ipcMain.handle('choose-file', () => picked)
    picked = [seeded.cleaned]
    await click('#pick-file')
    await until(async () => (await value('#source')) === seeded.own, 3000)
    check('picked cleaned file: traced back to its own original', (await value('#source')) === seeded.own, await value('#source'))
    check('... hint: your own file', (await text('#source-help')) === 'From your recent files: Friday talk.mp3, your own file.', await text('#source-help'))
    check('... its row marked', (await recent()).find((x) => x.id === seeded.own_row).current)
    check('strip: plays the saved MP3 of an own file', await until(async () => (await st()).state === 'ready', 5000) && near((await st()).length, 30, 0.5),
      `${(await st()).state}, ${(await st()).length} s`)
    s = await save({ from: '12', to: '14.5', kind: 'speech', note: '' })
    check('talking cut saved', s === 'Saved. 2 slips saved so far. Thank you!', s)
    lines = readFileSync(csv, 'utf8').trim().split(/\r?\n/)
    check('CSV row for the own file', lines[2] === `${seeded.own},12,14.5,speech,,${today}`, lines[2])
    const ownKey = createHash('sha1').update(seeded.own).digest('hex').slice(0, 12)
    check('own sound copied as it is', existsSync(join(casesDir, ownKey, 'Friday talk.mp3')) && sha(join(casesDir, ownKey, 'Friday talk.mp3')) === sha(seeded.own))

    // 4. Pick… a video made from a link (link in its tags), not in the history: the link is used
    picked = [seeded.tagged]
    await click('#pick-file')
    await until(async () => (await value('#source')).includes('tagged12345'), 3000)
    check('tagged video: its link is used', (await value('#source')) === 'https://www.youtube.com/watch?v=tagged12345', await value('#source'))
    check('... hint names the site', (await text('#source-help')) === 'Made from a link.mp4 was made from this YouTube link; its original sound will be downloaded.', await text('#source-help'))
    check('... no row marked', !(await recent()).some((x) => x.current))
    check('strip: not in the library, says so', (await st()).state === 'idle' && (await st()).note.startsWith('Naqi has no cleaned sound of this one'), (await st()).note)

    // 5. Pick… an own video, not in the history: its sound only, as FLAC
    picked = [seeded.own_video]
    await click('#pick-file')
    await until(async () => (await value('#source')) === seeded.own_video, 3000)
    check('own video: hint for own files', (await text('#source-help')) === 'For your own files, pick the original (not the cleaned copy).')
    s = await save({ from: '0:01', to: '0:03', kind: 'effects', note: 'door knock' })
    check('other sound cut saved', s === 'Saved. 3 slips saved so far. Thank you!', s)
    const vidKey = createHash('sha1').update(seeded.own_video).digest('hex').slice(0, 12)
    check('own video: sound only, FLAC', existsSync(join(casesDir, vidKey, 'Holiday clip.flac')))

    // 6. Typing over a picked source forgets the row
    await page(`document.querySelector('#recent li[data-id="${seeded.own_row}"] .lib-row').click()`)
    await until(async () => (await recent()).find((x) => x.id === seeded.own_row).current, 3000)
    await type('#source', 'https://www.youtube.com/watch?v=typed')
    check('typing a link un-picks the row', !(await recent()).some((x) => x.current) &&
      (await text('#source-help')) === 'For your own files, pick the original (not the cleaned copy).')
    nativeTheme.themeSource = 'dark'
    await shot('3-saved-dark.png')
    await page(`document.querySelector('#report').scrollTop = 9999`)
    await shot('3b-form-dark.png')

    // 7. Back (a playing strip stops), then Bad in the library opens the page with that file filled in
    await page(`document.querySelector('#recent li[data-id="${seeded.link_row}"] .lib-row').click()`)
    await until(async () => (await st()).state === 'ready', 5000)
    await click('#strip-play')
    await until(async () => !(await st()).paused, 3000)
    await click('#report-back')
    check('leaving the page stops the strip', (await st()).paused)
    check('Back returns to Home', await until(() => page(`!document.querySelector('.home').hidden && document.querySelector('#report').hidden`), 2000))
    await type('#source', '')
    await page(`document.querySelector('#lib li[data-id="${seeded.own_row}"] .lib-row').click()`)
    await sleep(400)
    await page(`document.querySelector('#lib li[data-id="${seeded.own_row}"] .rate [data-value="bad"]').click()`)
    check('Bad in the library opens the report', await until(() => page(`!document.querySelector('#report').hidden`), 3000))
    check('... with that file filled in', await until(async () => (await value('#source')) === seeded.own, 3000), await value('#source'))
    check('... its row marked in Recent files', (await recent()).find((x) => x.id === seeded.own_row)?.current)
    check('... and its rating saved', (await page(`window.naqi.library()`)).items.find((x) => x.id === seeded.own_row).rating === 'bad')
    check('... focus on From, ready for the time', await page(`document.activeElement.id`) === 'from')
    check('... count shown', (await status()) === '3 slips saved so far.', await status())
    await shot('4-from-bad-dark.png')
    // Bad in the report's own list picks that row
    await page(`document.querySelector('#recent li[data-id="${seeded.link_row}"] .rate [data-value="bad"]').click()`)
    check('Bad in Recent files picks that row', await until(async () => (await value('#source')).includes('jNQXAC9IVRw'), 3000))
    nativeTheme.themeSource = 'light'
    await shot('5-from-bad-light.png')

    // 8. T4.2: Report here in the player fills the 6 s up to the playhead; Back returns to the paused player
    const pl = () => page('window.naqiPlayerStats()')
    const shown = (sel) => page(`!document.querySelector(${JSON.stringify(sel)}).hidden`)
    await type('#source', '')
    await page(`window.dispatchEvent(new CustomEvent('naqi-play', { detail: { id: ${seeded.link_row} } }))`)
    check('player opens the played link', await until(async () => (await shown('#watch')) && (await pl()).at > 0.5, 10000), `at ${(await pl()).at}`)
    await page(`document.querySelector('#timebar').focus()`)
    await press('Right', 4)
    await sleep(400)
    const at = (await pl()).at
    await click('#report-here')
    check('Report here opens the report', await until(() => shown('#report'), 3000) && !(await shown('#watch')))
    check('... with the file filled in', await until(async () => (await value('#source')).includes('jNQXAC9IVRw'), 3000), await value('#source'))
    const end = Math.floor(at) + 1
    check('... and the 6 s up to the playhead', (await value('#from')) === stamp(end - 6) && (await value('#to')) === stamp(end),
      `playhead ${at.toFixed(2)} s: ${await value('#from')} to ${await value('#to')}`)
    check('... the moment lit on the strip', await until(async () => { const x = await st(); return x.state === 'ready' && x.lit }, 5000) &&
      (await text('#moment-len')) === '6 s', await text('#moment-len'))
    const held = (await pl()).at
    await sleep(1000)
    check('... the player is paused there', near((await pl()).at, held, 0.01) && near(held, at, 0.5), `${held.toFixed(2)} -> ${(await pl()).at.toFixed(2)} s`)
    check('... Back says where it goes', (await page(`document.querySelector('#report-back').getAttribute('aria-label')`)) === 'Back to the player')
    await shot('11-report-here-light.png')
    await click('#play-moment')
    await until(async () => !(await st()).paused, 2000)
    await click('#report-back')
    check('Back returns to the player', await until(() => shown('#watch'), 2000) && !(await shown('#report')))
    check('... strip stopped, player still paused at the moment', (await st()).paused && near((await pl()).at, held, 0.01), `${(await pl()).at.toFixed(2)} s`)
    await page(`document.querySelector('#timebar').focus()`)
    await press('Left', 5)
    await sleep(400)
    await click('#report-here')
    await until(() => shown('#report'), 3000)
    check('Report here near the start: from 0:00', (await value('#from')) === '0:00' && (await value('#to')) === stamp(Math.floor((await pl()).at) + 1),
      `${await value('#from')} to ${await value('#to')}`)
    await click('#report-back')
    await until(() => shown('#watch'), 2000)
    await click('#watch-back')
    await click('#open-report')
    await until(() => shown('#report'), 2000)
    await click('#report-back')
    check('from the side bar, Back goes Home again', await until(() => shown('.home'), 2000) &&
      (await page(`document.querySelector('#report-back').getAttribute('aria-label')`)) === 'Back to Home')
    // Narrow window
    const [ww, wh] = win.getSize()
    win.setSize(760, 700)
    await shot('6-narrow-light.png')
    win.setSize(ww, wh)
  } catch (e) {
    check('test ran', false, e.message)
  } finally {
    nativeTheme.themeSource = theme
    note(fails ? `${fails} check(s) FAILED` : 'ALL PASSED')
    writeFileSync(join(outDir, 'log.txt'), log.join('\n') + '\n')
    setTimeout(() => app.quit(), 500)
  }
}
