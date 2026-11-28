import { app, ipcMain } from 'electron'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Dev check for T13.8 (run with NAQI_SELFTEST=queue and NAQIE_DATA pointing to a folder named naqie-t13.8, outside
// OneDrive; it is emptied first; GPU + internet, about 5 min): Up next on the real page. Three items play one after
// another: a 60 s own video (A), then a cleaned 60 s video added from its library row (B), then a 19 s YouTube link
// added from Home's link box (L). L is cleaned ahead while B plays (Home stays free) and is ready before B ends.
// A ends: the card, Cancel keeps A; a click on B's row plays it. B ends in the corner: after 5 s L plays there. L
// ends with Up next empty: no card. Then a link cleaned ahead makes way for a Clean and play started by hand and is
// cleaned again after; Up next is kept in settings.json; x takes it out. The real settings.json is put back.
// Log and screenshots in test_out/t13.8/.
const outDir = join(app.getAppPath(), 'test_out', 't13.8')
const FILE_A = join(app.getAppPath(), 'samples', 'frames', 'fps30.mp4')
const FILE_B = join(app.getAppPath(), 'samples', 'frames', 'fps24.mp4')
const SOUND = join(app.getAppPath(), 'samples', 'narration_30s.mp3')
const LINK = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'   // "Me at the zoo", 19 s
const SHORT = 'https://youtu.be/jNQXAC9IVRw'                // the same video, written another way: a new link
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function run(win, engine) {
  mkdirSync(outDir, { recursive: true })
  const log = []
  let fails = 0
  const t0 = Date.now()
  const note = (text) => { log.push(`${((Date.now() - t0) / 1000).toFixed(2)} s  ${text}`); console.log('[queuetest]', text) }
  const check = (name, ok, detail = '') => { fails += !ok; note(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`) }
  const page = (js) => win.webContents.executeJavaScript(js)
  const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(150) } return false }
  const shot = async (name) => writeFileSync(join(outDir, `${name}.png`), (await win.webContents.capturePage()).toPNG())
  const stats = () => page('window.naqiPlayerStats()')
  const watching = () => page(`!document.querySelector('#watch').hidden`)
  const inCorner = () => page(`!document.querySelector('#corner').hidden`)
  const rows = () => page(`[...document.querySelectorAll('#upnext-list li:not(.is-leaving)')].map((li) => ({ title: li.querySelector('.lib-title').textContent, meta: li.querySelector('.lib-meta').textContent }))`)
  const card = () => page(`(() => { const c = document.querySelector('#next-card'); return { shown: !c.hidden, title: c.querySelector('#next-title').textContent, place: c.parentElement.id } })()`)
  const homeFree = () => page(`document.querySelector('#zone').dataset.busy !== 'true' && !document.querySelector('#url').disabled`)
  const press = async (keyCode, wait = 300) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
    if (keyCode.length === 1) win.webContents.sendInputEvent({ type: 'char', keyCode })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
    await sleep(wait)
  }
  // Forward (L, 10 s each, only inside the clean part) until `left` seconds remain
  const toEnd = async (left) => {
    await page(`document.activeElement.blur()`)
    for (let i = 0; i < 40; i++) {
      const s = await stats()
      if ((s.length || s.duration || 0) - s.at <= left + 10) break
      await press('l', 250)
    }
  }
  const typeLink = (link) => page(`(() => { const u = document.querySelector('#url'); u.value = ${JSON.stringify(link)}; u.dispatchEvent(new Event('input')) })()`)
  const settingsPath = join(app.getPath('userData'), 'settings.json')
  let realSettings = null
  try { realSettings = readFileSync(settingsPath, 'utf8') } catch { /* none yet */ }

  try {
    const data = process.env.NAQIE_DATA || ''
    if (!/naqie-t13\.8[\\/]?$/.test(data)) throw new Error('NAQIE_DATA must be a folder named naqie-t13.8 (the real history is never used)')
    if (process.env.NAQIE_SAVE_DIR) throw new Error('run without NAQIE_SAVE_DIR: this test checks what settings.json keeps')
    rmSync(data, { recursive: true, force: true })
    check('engine ready with the models', await until(async () => engine.status.status === 'ready' && (await engine.call('/health')).models, 120000), engine.status.gpu?.name)
    await page(`document.querySelector('#upnext-clear').click()`)
    ipcMain.removeHandler('choose-files')
    let pick = null
    ipcMain.handle('choose-files', () => [pick])
    const cleanAndPlay = async (file) => {
      pick = file
      await page(`document.querySelector('#choose').click()`)
      await sleep(800)
      await page(`document.querySelector('#go').click()`)
    }

    // B first, so it is a cleaned library item
    await cleanAndPlay(FILE_B)
    check('B: cleaned and plays', await until(watching, 120000) && await until(async () => !(await stats()).live, 120000))
    const idB = (await stats()).id
    await press('Escape', 600)
    await page(`document.querySelector('#corner-close').click()`)
    await sleep(800)

    // A plays; B joins Up next from its library row while A is cleaned
    await cleanAndPlay(FILE_A)
    check('A: the player opens', await until(watching, 120000) && await until(async () => (await stats()).firstPlaying !== null, 30000))
    const idA = (await stats()).id
    await page(`document.querySelector('#lib li[data-id="${idB}"] [data-act="next"]').click()`)
    await sleep(500)
    let r = await rows()
    check('B added from its library row', r.length === 1 && r[0].title === 'fps24.mp4' && r[0].meta === 'Ready', JSON.stringify(r))
    check('A: all clean', await until(async () => !(await stats()).live, 120000))

    // L joins from Home's link box: the first one (B) is ready, so nothing is cleaned ahead yet
    await typeLink(LINK)
    check('Add to Up next shows for one link', await page(`!document.querySelector('#queue-add').hidden`))
    await page(`document.querySelector('#queue-add').click()`)
    await sleep(3000)
    r = await rows()
    check('L added from Home, the link box empty again', r.length === 2 && r[1].meta === 'Cleans as soon as Naqi is free' && await page(`document.querySelector('#url').value === ''`), JSON.stringify(r))
    // The library open for the shot (the real side bar setting comes back with settings.json)
    await page(`document.body.dataset.side === 'closed' && document.querySelector('#rail-open').click()`)
    await sleep(800)
    await shot('1-up-next')

    // A ends: the card; Cancel keeps A
    await toEnd(4)
    check('A ends: the card says B', await until(async () => (await card()).shown, 15000) && (await card()).title === 'fps24.mp4', JSON.stringify(await card()))
    await sleep(500)
    await shot('2-card')
    await page(`document.querySelector('#next-cancel').click()`)
    await sleep(6500)
    const sa = await stats()
    check('Cancel: A stays, nothing plays', sa.id === idA && (sa.ended || sa.paused) && !(await card()).shown, `id ${sa.id} (A ${idA}), ended ${sa.ended}, paused ${sa.paused}, card ${(await card()).shown}`)

    // A click on B's row in Up next plays it; L is cleaned ahead at once, in the background
    await page(`document.querySelector('#upnext-list li .upnext-row').click()`)
    check('B plays from its Up next row', await until(async () => (await stats()).id === idB && (await stats()).firstPlaying !== null, 15000))
    const aheadFrom = Date.now()
    check('L is cleaned ahead while B plays', await until(async () => (await rows())[0]?.meta.startsWith('Cleaning ahead'), 30000), JSON.stringify(await rows()))
    check('... Home stays free meanwhile', await homeFree() && await page(`!document.querySelector('#go').classList.contains('is-cancel')`))
    await sleep(1500)
    await shot('3-ahead')
    check('L ready before B ends', await until(async () => (await rows())[0]?.meta === 'Ready', 120000) && !(await stats()).ended,
      `ready after ${((Date.now() - aheadFrom) / 1000).toFixed(1)} s, B at ${(await stats()).at.toFixed(1)} of ${((await stats()).length || (await stats()).duration).toFixed(1)} s`)

    // B ends in the corner: the card is there, after 5 s L plays there
    await toEnd(12)
    await press('Escape', 800)
    check('B goes on in the corner', await inCorner())
    check('B ends: the card in the corner', await until(async () => (await card()).shown, 30000) && (await card()).place === 'corner')
    const endedAt = Date.now()
    await sleep(500)
    await shot('4-corner-card')
    check('L plays by itself after 5 s, in the corner', await until(async () => (await stats()).id !== idB && (await stats()).firstPlaying !== null && !(await stats()).paused, 15000) &&
      await inCorner() && !(await watching()), `${((Date.now() - endedAt) / 1000).toFixed(1)} s after the card`)
    check('... from its ready sound (not cleaned now)', !(await stats()).live)
    r = await rows()
    check('Up next empty, its group hidden', r.length === 0 && await page(`document.querySelector('#upnext').hidden`))
    await shot('5-corner-next')

    // L ends with nothing next: no card
    const idL = (await stats()).id
    await until(async () => (await stats()).ended, 40000)
    await sleep(6000)
    check('L ends: no card, nothing else plays', !(await card()).shown && (await stats()).id === idL)
    await page(`document.querySelector('#corner-close').click()`)
    await sleep(800)

    // A link cleaned ahead makes way for a Clean and play started by hand, and is cleaned again after
    await typeLink(SHORT)
    await page(`document.querySelector('#queue-add').click()`)
    check('a new link is cleaned ahead at once (nothing plays)', await until(async () => (await rows())[0]?.meta.startsWith('Cleaning ahead'), 30000))
    await cleanAndPlay(SOUND)
    check('... a Clean and play by hand starts', await until(async () => page(`document.querySelector('#job').dataset.state === 'running'`), 10000))
    check('... the link waits (not held)', await until(async () => (await rows())[0]?.meta === 'Cleans as soon as Naqi is free', 10000), JSON.stringify(await rows()))
    check('... the sound plays', await until(watching, 60000))
    check('... the hand cleaning ends', await until(async () => page(`document.querySelector('#job').dataset.state === 'done'`), 120000))
    check('... then the link is cleaned ahead again', await until(async () => (await rows())[0]?.meta.startsWith('Cleaning ahead'), 20000) &&
      await until(async () => (await rows())[0]?.meta === 'Ready', 120000))

    // Kept in settings.json; x takes it out
    const kept = JSON.parse(JSON.parse(readFileSync(settingsPath, 'utf8')).queue || '[]')
    check('Up next kept in settings.json', kept.length === 1 && kept[0].url === SHORT && Number.isInteger(kept[0].id), JSON.stringify(kept))
    await page(`document.querySelector('#upnext-list .upnext-x').click()`)
    await sleep(800)
    check('x takes it out', (await rows()).length === 0 && await page(`document.querySelector('#upnext').hidden`))
    await shot('6-end')
  } catch (e) {
    check('test ran', false, e.stack || e.message)
  } finally {
    if (realSettings !== null) writeFileSync(settingsPath, realSettings)
    else rmSync(settingsPath, { force: true })
    note(fails ? `${fails} check(s) FAILED` : 'ALL PASSED')
    writeFileSync(join(outDir, 'log.txt'), log.join('\n') + '\n')
    setTimeout(() => app.quit(), 500)
  }
}
