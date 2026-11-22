import { app, ipcMain, nativeTheme } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Dev check for T3.1 (run with NAQI_SELFTEST=library and NAQIE_DATA pointing to a folder named naqie-t3.1, outside
// OneDrive, which locks files while it syncs; it is emptied first): the Library
// side bar on the real page. Empty state first; then a seeded history (engine/seed_library.py: ready, saved,
// gone, cleans-again items) is read and checked row by row; pick, Show in folder, Remove with Undo, Remove for real
// (the saved file stays); then a 30 s own sound is cleaned with "Clean and play" and watched in the library
// (Cleaning… with its bar, then picked when done). T3.2: ratings in a picked row and in the job card after the
// 30 s clean, saved in the history and kept in step. Screenshots in light and dark, log in test_out/t3.1/.
const outDir = join(app.getAppPath(), 'test_out', 't3.1')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function run(win, engine) {
  mkdirSync(outDir, { recursive: true })
  const log = []
  let fails = 0
  const t0 = Date.now()
  const note = (text) => { log.push(`${((Date.now() - t0) / 1000).toFixed(2)} s  ${text}`); console.log('[libtest]', text) }
  const check = (name, ok, detail = '') => { fails += !ok; note(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`) }
  const page = (js) => win.webContents.executeJavaScript(js)
  const shot = async (name) => { await sleep(500); writeFileSync(join(outDir, name), (await win.webContents.capturePage()).toPNG()) }
  const reload = () => page(`window.dispatchEvent(new Event('focus'))`)
  const rows = () => page(`[...document.querySelectorAll('#lib li[data-id]:not(.is-leaving)')].map((li) => ({
    id: +li.dataset.id, title: li.querySelector('.lib-title').textContent, meta: li.querySelector('.lib-meta').textContent,
    gone: li.querySelector('.lib-row').dataset.gone, kind: li.querySelector('.lib-row').dataset.kind,
    current: li.querySelector('.lib-row').getAttribute('aria-current') === 'true', open: li.dataset.open,
    show: !li.querySelector('[data-act=show]').hidden, removable: !li.querySelector('[data-act=remove]').hidden,
    bar: !!li.querySelector('.lib-progress'), rateShown: !li.querySelector('.rate').hidden,
    rating: li.querySelector('.rate [aria-checked=true]')?.dataset.value || '' }))`)
  const clickRow = (id, sel = '.lib-row') => page(`document.querySelector('#lib li[data-id="${id}"] ${sel}').click()`)
  const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(200) } return false }
  const theme = nativeTheme.themeSource

  try {
    const data = process.env.NAQIE_DATA || ''
    if (!/naqie-t3\.1[\\/]?$/.test(data)) throw new Error('NAQIE_DATA must be a folder named naqie-t3.1 (the real history is never used)')
    rmSync(data, { recursive: true, force: true })
    check('engine ready', await until(() => engine.status.status === 'ready', 90000), engine.status.gpu?.name)
    await reload()
    await sleep(600)
    check('empty library shows the empty state', await page(`!document.querySelector('#lib-empty').hidden && document.querySelector('#lib').hidden`))
    await shot('1-empty.png')

    // Seeded history: one item in each state
    const seeded = JSON.parse(await new Promise((resolve, reject) => execFile('py',
      ['-3.12', join(app.getAppPath(), 'engine', 'seed_library.py'), join(outDir, 'files')],
      { env: process.env, windowsHide: true }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)))))
    await reload()
    check('6 rows shown', await until(async () => (await rows()).length === 6, 5000))
    let r = await rows()
    const find = (text) => r.find((x) => x.title.includes(text))
    check('newest first', r[0].title.startsWith('How the desert'), r.map((x) => x.title.slice(0, 12)).join(' | '))
    check('count tag says 6', await page(`document.querySelector('#lib-count').textContent`) === '6')
    check('played link: video, today, YouTube, no format', find('desert').kind === 'video' && /^Today, \d\d:\d\d · YouTube$/.test(find('desert').meta), find('desert').meta)
    check('own sound played: audio, Your file', find('Evening').kind === 'audio' && find('Evening').meta.endsWith('· Your file'), find('Evening').meta)
    check('Arabic title kept', !!find('الجبال'))
    check('saved link: yesterday, YouTube', /^Yesterday, \d\d:\d\d · YouTube$/.test(find('spices').meta), find('spices').meta)
    check('moved file: gone', find('Morning').gone === 'true' && find('Morning').meta === 'File moved or deleted', find('Morning').meta)
    check('tidied away after 2 weeks: cleans again', find('Friday').meta.endsWith('· Cleans again when played') && find('Friday').gone === 'false', find('Friday').meta)

    // Pick: the light moves, the actions open; Show in folder only where there is a file of the user's
    const shown = []
    ipcMain.removeHandler('show-in-folder')
    ipcMain.handle('show-in-folder', (_e, p) => { shown.push(p) })
    nativeTheme.themeSource = 'light'
    await clickRow(find('desert').id)
    await sleep(400)
    r = await rows()
    check('click picks the row and opens its actions', find('desert').current && find('desert').open === 'true')
    check('played item: no Show in folder', !find('desert').show)
    const lightOk = await page(`(() => { const l = document.querySelector('.lib-light'); const li = document.querySelector('#lib li[data-id="${find('desert').id}"]'); return l.style.opacity === '1' && Math.abs(l.offsetHeight - li.offsetHeight) <= 1 })()`)
    check('the light covers the picked row with its actions', lightOk)
    await clickRow(find('spices').id)
    await sleep(400)
    r = await rows()
    check('picking another moves the light there', find('spices').current && !find('desert').current)
    check('saved item: Show in folder', find('spices').show)
    await clickRow(find('spices').id, '[data-act=show]')
    await sleep(200)
    check('Show in folder opens the saved file', shown[0] === seeded.saved, shown[0])
    // Rating in the picked row (T3.2): saved in the history, still shown after a reload
    const ratingOf = async (id) => (await engine.call('/library')).items.find((x) => x.id === id)?.rating
    check('picked row shows the rating, nothing chosen', find('spices').rateShown && find('spices').rating === '')
    await clickRow(find('spices').id, '.rate [data-value=good]')
    await sleep(400)
    check('Good in the row is saved in the history', await ratingOf(find('spices').id) === 'good')
    await clickRow(find('spices').id, '.rate [data-value=bad]')
    await sleep(400)
    check('changed to Bad: saved, the row stays (no report page yet)', await ratingOf(find('spices').id) === 'bad' &&
      (await rows()).find((x) => x.id === find('spices').id).open === 'true')
    await reload()
    await sleep(600)
    check('the rating is still shown after a reload', (await rows()).find((x) => x.id === find('spices').id).rating === 'bad')
    let refused = ''
    try { await engine.call(`/library/${find('spices').id}/rate`, { rating: 'great' }) } catch (e) { refused = e.message }
    check('a rating that is not Bad / Good / Perfect is refused', refused.includes('bad, good or perfect') && await ratingOf(find('spices').id) === 'bad', refused)
    await shot('2-picked-light.png')
    nativeTheme.themeSource = 'dark'
    await shot('3-picked-dark.png')
    nativeTheme.themeSource = 'light'

    // Remove, then Undo: the row comes back, nothing deleted
    const spices = find('spices').id
    await clickRow(spices, '[data-act=remove]')
    await sleep(500)
    check('Remove folds the row away', !(await rows()).some((x) => x.id === spices))
    check('an Undo toast shows', await page(`[...document.querySelectorAll('.toast button')].some((b) => b.textContent === 'Undo')`))
    await shot('4-removed-undo.png')
    await page(`[...document.querySelectorAll('.toast button')].find((b) => b.textContent === 'Undo').click()`)
    await sleep(5800)
    check('Undo brings it back and keeps it', (await rows()).some((x) => x.id === spices) &&
      (await engine.call('/library')).items.some((x) => x.id === spices))
    // Remove for real
    await clickRow(spices)
    await clickRow(spices, '[data-act=remove]')
    await sleep(5800)
    check('after the Undo time the engine has removed it', !(await engine.call('/library')).items.some((x) => x.id === spices))
    check('the saved file is still there', existsSync(seeded.saved))
    check('5 rows left', (await rows()).length === 5)

    // "Clean and play" of a 30 s own sound: it shows as Cleaning… while it runs, then is picked when done
    const sample = join(app.getAppPath(), 'samples', 'narration_30s.mp3')
    ipcMain.removeHandler('choose-files')
    ipcMain.handle('choose-files', () => [sample])
    await page(`document.querySelector('#choose').click()`)
    await sleep(800)
    await page(`document.querySelector('#go').click()`)
    const live = await until(async () => (await rows()).some((x) => x.meta.startsWith('Cleaning…')), 30000)
    r = await rows()
    const cleaning = r.find((x) => x.meta.startsWith('Cleaning…'))
    check('the item being cleaned shows at the top as Cleaning…', live && r[0] === cleaning, cleaning?.meta)
    if (cleaning) {
      check('... with its progress bar', cleaning.bar)
      await clickRow(cleaning.id)
      await sleep(300)
      check('... and cannot be removed', !(await rows())[0].removable)
      check('... nor rated yet', !(await rows())[0].rateShown)
      await shot('5-cleaning.png')
      const done = await until(async () => { const x = (await rows()).find((y) => y.id === cleaning.id); return x && !x.meta.startsWith('Cleaning') }, 120000)
      r = await rows()
      const finished = r.find((x) => x.id === cleaning.id)
      check('when done it is a normal row, picked', done && finished.current && !finished.bar && finished.meta.startsWith('Today'), finished?.meta)
      // Rating in the job card after one cleaned file (T3.2)
      check('the job card asks for a rating', await until(() => page(`!document.querySelector('#job-rate').hidden`), 3000))
      await page(`document.querySelector('#job-rate [data-value=perfect]').click()`)
      await sleep(500)
      check('Perfect in the card is saved in the history', await ratingOf(cleaning.id) === 'perfect')
      check('... the card thanks', await page(`document.querySelector('#rate-note').textContent`) === 'Thanks!')
      check('... and the library row shows it too', (await rows()).find((x) => x.id === cleaning.id).rating === 'perfect')
      await clickRow(cleaning.id, '.rate [data-value=good]')
      await sleep(400)
      check('changed in the library: the card follows', await page(`document.querySelector('#job-rate [aria-checked=true]')?.dataset.value`) === 'good' &&
        await ratingOf(cleaning.id) === 'good')
      await shot('6-done.png')
      nativeTheme.themeSource = 'dark'
      await shot('7-rated-dark.png')
      // A new job hides the card's rating until it is done
      await page(`document.querySelector('#choose').click()`)
      await sleep(800)
      await page(`document.querySelector('#go').click()`)
      await sleep(1500)
      check('a new job hides the rating', await page(`document.querySelector('#job-rate').hidden`))
      const id2 = await until(async () => (await rows()).some((x) => x.meta.startsWith('Cleaning…')), 30000)
      if (id2) await page(`document.querySelector('#go').click()`)   // cancel it
      await until(async () => !(await rows()).some((x) => x.meta.startsWith('Cleaning…')), 30000)
    }
  } catch (e) {
    check('test ran', false, e.message)
  } finally {
    nativeTheme.themeSource = theme
    note(fails ? `${fails} check(s) FAILED` : 'ALL PASSED')
    writeFileSync(join(outDir, 'log.txt'), log.join('\n') + '\n')
    setTimeout(() => app.quit(), 500)
  }
}
