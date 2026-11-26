import { app, nativeTheme } from 'electron'
import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Dev check for T10.6 (run with NAQI_SELFTEST=search and NAQIE_DATA pointing to a folder named naqie-t10.6, outside
// OneDrive; it is emptied first): the library's search box and filters on the real page. A seeded history
// (engine/seed_library.py: 6 items, today / yesterday / 9 and 20 days old, 3 links and 3 own files) gets ratings,
// then each search and each filter is checked against the rows shown, alone and together, and clearing them shows
// all again. No GPU work, no internet. Screenshots in light, dark and a small window, log in test_out/t10.6/.
const outDir = join(app.getAppPath(), 'test_out', 't10.6')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function run(win, engine) {
  mkdirSync(outDir, { recursive: true })
  const log = []
  let fails = 0
  const t0 = Date.now()
  const note = (text) => { log.push(`${((Date.now() - t0) / 1000).toFixed(2)} s  ${text}`); console.log('[searchtest]', text) }
  const check = (name, ok, detail = '') => { fails += !ok; note(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`) }
  const page = (js) => win.webContents.executeJavaScript(js)
  const shot = async (name) => { await sleep(500); writeFileSync(join(outDir, name), (await win.webContents.capturePage()).toPNG()) }
  const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(200) } return false }
  // The titles shown (first 12 letters), in order
  const shown = () => page(`[...document.querySelectorAll('#lib li[data-id]:not([hidden]):not(.is-leaving)')].map((li) => li.querySelector('.lib-title').textContent.slice(0, 12))`)
  const count = () => page(`document.querySelector('#lib-count').textContent`)
  const type = (text) => page(`(() => { const q = document.querySelector('#lib-q'); q.value = ${JSON.stringify(text)}; q.dispatchEvent(new Event('input')) })()`)
  const chip = (group, value) => page(`document.querySelector('[data-filter="${group}"] [data-value="${value}"]').click()`)
  const pressed = () => page(`[...document.querySelectorAll('.lib-chips [aria-pressed=true]')].map((b) => b.dataset.value)`)
  const key = async (keyCode) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode }); await sleep(150) }
  const expect = async (name, titles, filtered = titles.length !== 6) => {
    await sleep(120)
    const s = await shown()
    const want = titles.map((t) => t.slice(0, 12))
    const c = await count()
    const wantCount = filtered ? `${want.length} of 6` : '6'
    check(name, JSON.stringify(s) === JSON.stringify(want) && c === wantCount, `${s.join(' | ') || 'none'}; count ${c}`)
  }
  const theme = nativeTheme.themeSource
  const ALL = ['How the desert', 'Evening lecture', 'رحلة إلى الج', 'Cooking with', 'Morning remin', 'Friday talk.']
  let side = null   // the real side bar choice (T11.1), put back at the end

  try {
    const data = process.env.NAQIE_DATA || ''
    if (!/naqie-t10\.6[\\/]?$/.test(data)) throw new Error('NAQIE_DATA must be a folder named naqie-t10.6 (the real history is never used)')
    // The library folded away hides the search box: this test needs it open
    side = (await page('window.naqi.getSettings()')).sidebar || 'open'
    if (await page(`document.body.dataset.side === 'closed'`)) await page(`document.querySelector('#rail-open').click()`)
    check('engine ready', await until(() => engine.status.status === 'ready', 90000), engine.status.gpu?.name)
    await page(`window.dispatchEvent(new Event('focus'))`)
    await sleep(600)
    check('empty library: no search box', await page(`document.querySelector('#lib-find').hidden`))

    await new Promise((resolve, reject) => execFile('py', ['-3.12', join(app.getAppPath(), 'engine', 'seed_library.py'), join(outDir, 'files')],
      { env: process.env, windowsHide: true }, (err, _out, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve())))
    const items = (await engine.call('/library')).items
    const id = (text) => items.find((x) => x.title.includes(text)).id
    await engine.call(`/library/${id('desert')}/rate`, { rating: 'good' })
    await engine.call(`/library/${id('spices')}/rate`, { rating: 'perfect' })
    await engine.call(`/library/${id('Evening')}/rate`, { rating: 'bad' })
    await page(`window.dispatchEvent(new Event('focus'))`)
    check('6 rows and the search box show', await until(async () => (await shown()).length === 6, 5000) && await page(`!document.querySelector('#lib-find').hidden`))
    await expect('all rows, newest first', ALL)
    nativeTheme.themeSource = 'light'

    // Search: typed for real into the box
    await page(`document.querySelector('#lib-q').focus()`)
    win.webContents.insertText('desert')
    await expect('typing "desert" leaves one row', ['How the desert'])
    check('the clear button shows', await page(`!document.querySelector('#lib-q-clear').hidden`))
    await shot('1-search-light.png')
    await type('DÉSERT')
    await expect('no case, no accents: "DÉSERT"', ['How the desert'])
    await type('three cooking')
    await expect('every word, in any order: "three cooking"', ['Cooking with'])
    await type('الجبال')
    await expect('Arabic: "الجبال"', ['رحلة إلى الج'])
    await type('a')
    check('one letter narrows to the names with it', (await shown()).length === 4, (await shown()).join(' | '))
    await page(`document.querySelector('#lib-q-clear').click()`)
    await expect('the clear button shows all again', ALL)
    check('... and empties the box', await page(`document.querySelector('#lib-q').value === '' && document.querySelector('#lib-q-clear').hidden`))
    await type('lecture')
    await page(`document.querySelector('#lib-q').focus()`)
    await key('Escape')
    await expect('Escape in the box clears it', ALL)
    await key('Escape')
    check('a second Escape leaves the box', await page(`document.activeElement !== document.querySelector('#lib-q')`))
    await page(`document.querySelector('#lib-q').focus()`)
    await key('Down')
    check('Down from the box goes to the first row', await page(`document.activeElement?.closest('li')?.querySelector('.lib-title')?.textContent.startsWith('How the desert')`))
    await key('Up')
    check('Up from the first row goes back to the box', await page(`document.activeElement === document.querySelector('#lib-q')`))

    // Filters
    check('filters closed at first', await page(`document.querySelector('#lib-filters').dataset.open === 'false'`))
    await page(`document.querySelector('#lib-filter-toggle').click()`)
    await sleep(400)
    check('the filter button opens them', await page(`document.querySelector('#lib-filters').dataset.open === 'true' && document.querySelector('#lib-filter-toggle').getAttribute('aria-expanded') === 'true'`))
    await chip('when', 'today')
    await expect('When: Today', ['How the desert', 'Evening lecture', 'رحلة إلى الج'])
    check('the filter button shows its dot', await page(`document.querySelector('#lib-filter-toggle').dataset.on === 'true'`))
    await chip('when', 'week')
    await expect('When: 7 days (one choice at a time)', ['How the desert', 'Evening lecture', 'رحلة إلى الج', 'Cooking with'])
    check('... only 7 days is pressed', JSON.stringify(await pressed()) === '["week"]', (await pressed()).join(','))
    await chip('when', 'month')
    await expect('When: 30 days', ALL, true)
    check('... still counted as a filter', await count() === '6 of 6')
    await chip('when', 'month')
    await expect('the chosen chip again: any time', ALL)
    await chip('rating', 'none')
    await expect('Rating: Not rated', ['رحلة إلى الج', 'Morning remin', 'Friday talk.'])
    await chip('rating', 'bad')
    await expect('Rating: Bad', ['Evening lecture'])
    await chip('rating', 'good')
    await expect('Rating: Good', ['How the desert'])
    await chip('rating', 'perfect')
    await expect('Rating: Perfect', ['Cooking with'])
    await chip('rating', 'perfect')
    await chip('from', 'link')
    await expect('From: Links', ['How the desert', 'رحلة إلى الج', 'Cooking with'])
    await chip('from', 'own')
    await expect('From: Own files', ['Evening lecture', 'Morning remin', 'Friday talk.'])
    // Together, and with the search
    await chip('from', 'link')
    await chip('when', 'today')
    await expect('Links + Today', ['How the desert', 'رحلة إلى الج'])
    await chip('rating', 'good')
    await expect('Links + Today + Good', ['How the desert'])
    await shot('2-filters-light.png')
    nativeTheme.themeSource = 'dark'
    await shot('3-filters-dark.png')
    await type('cooking')
    await expect('Links + Today + Good + "cooking": nothing', [])
    check('"Nothing matches" shows with what was asked', await page(`!document.querySelector('#lib-none').hidden && document.querySelector('#lib').hidden`) &&
      await page(`document.querySelector('#lib-none-text').textContent`) === 'No file named “cooking” in Today · Good · Links.',
      await page(`document.querySelector('#lib-none-text').textContent`))
    await shot('4-nothing-dark.png')
    await page(`document.querySelector('#lib-show-all').click()`)
    await expect('Show all clears the search and every filter', ALL)
    check('... no chip pressed, the box empty, no dot', (await pressed()).length === 0 &&
      await page(`document.querySelector('#lib-q').value === '' && document.querySelector('#lib-filter-toggle').dataset.on === 'false'`))
    await chip('from', 'own')
    await chip('rating', 'none')
    await expect('Own files + Not rated', ['Morning remin', 'Friday talk.'])
    await page(`document.querySelector('#lib-filter-clear').click()`)
    await expect('Clear filters shows all again', ALL)
    check('... and hides itself', await page(`document.querySelector('#lib-filter-clear').hidden`))

    // A picked row that a filter hides is let go (the light leaves it); the list survives a reload with the filter on
    await page(`document.querySelector('#lib li[data-id="${id('desert')}"] .lib-row').click()`)
    await sleep(300)
    await chip('from', 'own')
    await sleep(300)
    check('a picked row hidden by a filter is let go', await page(`!document.querySelector('#lib [aria-current=true]') && document.querySelector('.lib-light').style.opacity === '0'`))
    await page(`window.dispatchEvent(new Event('focus'))`)
    await sleep(800)
    await expect('the filter stays when the list reloads', ['Evening lecture', 'Morning remin', 'Friday talk.'])
    await chip('from', 'own')
    await page(`document.querySelector('#lib-filter-toggle').click()`)
    await sleep(400)
    check('the filter button closes them again', await page(`document.querySelector('#lib-filters').dataset.open === 'false'`))

    // Small window (the side bar at its narrowest): the filters still fit, nothing cut off
    const [w, h] = win.getSize()
    win.setSize(780, 620)
    await sleep(600)
    await page(`document.querySelector('#lib-filter-toggle').click()`)
    await chip('rating', 'none')
    await sleep(400)
    const fits = await page(`(() => { const side = document.querySelector('.side').getBoundingClientRect();
      return [...document.querySelectorAll('.lib-chips button, .lib-search, #lib-filter-toggle')].every((b) => { const r = b.getBoundingClientRect(); return r.left >= side.left && r.right <= side.right + 0.5 }) })()`)
    check('small window: every chip and the box fit in the side bar', fits)
    nativeTheme.themeSource = 'light'
    await shot('5-small-light.png')
    await page(`document.querySelector('#lib-filter-clear').click()`)
    win.setSize(w, h)
  } catch (e) {
    check('test ran', false, e.message)
  } finally {
    nativeTheme.themeSource = theme
    if (side) await page(`window.naqi.setSettings({ sidebar: ${JSON.stringify(side)} })`).catch(() => {})
    note(fails ? `${fails} check(s) FAILED` : 'ALL PASSED')
    writeFileSync(join(outDir, 'log.txt'), log.join('\n') + '\n')
    setTimeout(() => app.quit(), 500)
  }
}
