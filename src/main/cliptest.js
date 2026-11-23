import { app, clipboard } from 'electron'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Dev check for T10.4 (run with NAQI_SELFTEST=clip, NAQIE_DATA pointing to a folder named naqie-t10.4 outside
// OneDrive, emptied first, and NAQIE_SAVE_DIR so the real settings are never written; GPU + internet, about 1 min):
// a copied video link is offered once when Naqi comes to the front, other text and other links stay quiet, a link
// pasted by hand is not offered, nothing is offered while a cleaning runs, and the offer's button starts Clean and
// play (also from the player, which then goes to the corner). The user's clipboard is put back at the end.
// Log and screenshots in test_out/t10.4/.
const outDir = join(app.getAppPath(), 'test_out', 't10.4')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const LINK = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'   // "Me at the zoo", 19 s
const SHORT = 'https://youtu.be/jNQXAC9IVRw'                // the same video, written another way: a new link

export async function run(win, engine) {
  mkdirSync(outDir, { recursive: true })
  const log = []
  let fails = 0
  const t0 = Date.now()
  const note = (text) => { log.push(`${((Date.now() - t0) / 1000).toFixed(2)} s  ${text}`); console.log('[cliptest]', text) }
  const check = (name, ok, detail = '') => { fails += !ok; note(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`) }
  const page = (js) => win.webContents.executeJavaScript(js)
  const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(150) } return false }
  const shot = async (name) => { await sleep(450); writeFileSync(join(outDir, name), (await win.webContents.capturePage()).toPNG()) }
  const setTheme = (t) => page(`(() => { const d = document.documentElement.dataset; if (${JSON.stringify(t)}) d.theme = ${JSON.stringify(t)}; else delete d.theme })()`)
  const offer = () => page(`(() => { const t = [...document.querySelectorAll('#toasts .toast-offer:not(.is-leaving)')].pop(); return t ? t.querySelector('.msg-text').textContent : null })()`)
  const closeOffers = async () => { await page(`document.querySelectorAll('#toasts .toast-offer .toast-close').forEach((b) => b.click()); 0`); await sleep(500) }
  // Naqi comes to the front: the window's focus event (a real one is tried once too)
  const front = () => page(`window.dispatchEvent(new Event('focus')); 0`)
  // Copies text, brings Naqi to the front, says whether (and with what) an offer showed
  const copyAndFront = async (text) => {
    await clipboard.writeText(text)
    await front()
    await until(async () => (await offer()) !== null, 1500)
    return offer()
  }
  const saved = await clipboard.readText()

  try {
    const data = process.env.NAQIE_DATA || ''
    if (!/naqie-t10\.4[\\/]?$/.test(data)) throw new Error('NAQIE_DATA must be a folder named naqie-t10.4 (the real history is never used)')
    if (!process.env.NAQIE_SAVE_DIR) throw new Error('NAQIE_SAVE_DIR must be set (the real settings are never written)')
    rmSync(data, { recursive: true, force: true })

    // 1. Naqi opens with a video link on the clipboard: offered once the engine is ready
    await clipboard.writeText(LINK)
    win.focus()
    check('engine ready with the models', await until(async () => engine.status.status === 'ready' && (await engine.call('/health')).models, 120000), engine.status.gpu?.name)
    const focused = await page('document.hasFocus()')
    if (focused) check('opening with a link copied: offered', await until(async () => (await offer()) === LINK, 4000), await offer())
    else note('INFO the window had no focus at the start (another window in front), the opening offer is checked through the focus event')
    if (!(await offer())) check('... or as soon as Naqi is in front', (await copyAndFront(LINK)) === LINK)
    check('... the toast names the link and has Clean and play', await page(`(() => { const t = document.querySelector('#toasts .toast-offer'); return !!t && t.querySelector('.msg-title').textContent === 'Clean the link you copied?' && t.querySelector('.toast-action').textContent.trim() === 'Clean and play' })()`))
    const theme = await page('document.documentElement.dataset.theme || null')
    await setTheme('light')
    await shot('offer-light.png')
    await setTheme('dark')
    await shot('offer-dark.png')
    await setTheme(theme)
    check('... it stays more than 4 s (an offer is read first)', await (async () => { await sleep(4600); return (await offer()) === LINK })())
    await closeOffers()
    check('the same link is asked once only', (await copyAndFront(LINK)) === null)

    // 2. Other text is ignored
    for (const text of ['hello world', 'https://www.google.com/search?q=naqi', 'https://www.youtube.com/', 'https://www.youtube.com/@NASA',
      'https://www.youtube.com/playlist?list=PL590L5WQmH8fJ54F369BLDSqIwcs-TCfs', `look at ${LINK}`, 'C:\\Videos\\clip.mp4', '']) {
      check(`ignored: ${JSON.stringify(text)}`, (await copyAndFront(text)) === null)
    }
    check('a video on another site is offered', (await copyAndFront('https://vimeo.com/76979871')) === 'https://vimeo.com/76979871')
    await closeOffers()

    // 3. A link pasted by hand (Paste) is not offered after
    await clipboard.writeText('https://www.youtube.com/watch?v=aqz-KE-bpKQ')
    await page(`document.querySelector('#paste').click(); 0`)
    await sleep(300)
    check('pasted by hand: in the link box, not offered', (await page(`document.querySelector('#url').value`)) === 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' && (await copyAndFront('https://www.youtube.com/watch?v=aqz-KE-bpKQ')) === null)
    await page(`document.querySelector('#url-clear').click(); 0`)

    // 4. The offer's button: Clean and play starts, the player opens with the link
    await page(`window.__jobs = []; window.naqi.onJob((j) => window.__jobs.push(j)); 0`)
    const linkInList = `${LINK}&list=PL590L5WQmH8fJ54F369BLDSqIwcs-TCfs`   // a video in a playlist: just that video
    check('a video in a playlist is offered', (await copyAndFront(linkInList)) === linkInList)
    const clicked = Date.now()
    await page(`document.querySelector('#toasts .toast-offer .toast-action').click(); 0`)
    check('one click starts Clean and play with the link', await until(async () => (await page(`window.__jobs.some((j) => j.kind === 'play')`)) &&
      (await page(`document.querySelector('#url').value`)) === linkInList && (await page(`document.querySelector('#job-title').textContent`)).startsWith('Cleaning'), 5000),
      await page(`document.querySelector('#job-title').textContent`))
    check('... just the video, not the playlist', await page(`!document.querySelector('#whole').checked`))
    check('... the offer closed', await until(async () => (await offer()) === null, 1500))
    check('while it is cleaned, a new link is not offered', (await copyAndFront('https://www.youtube.com/watch?v=M7lc1UVf-VE')) === null)
    check('the player opens with it', await until(() => page(`!document.querySelector('#watch').hidden`), 60000), `${((Date.now() - clicked) / 1000).toFixed(1)} s after the click`)
    check('... the cleaning ends', await until(() => page(`window.__jobs.some((j) => j.kind === 'play' && j.state === 'done')`), 60000))
    check('after the cleaning, the link that waited is offered', (await copyAndFront('https://www.youtube.com/watch?v=M7lc1UVf-VE')) === 'https://www.youtube.com/watch?v=M7lc1UVf-VE')
    await closeOffers()

    // 5. From the player: the offer goes to Home, the playing item to the corner, and the new one starts
    check('offered on the player page too', (await copyAndFront(SHORT)) === SHORT)
    await shot('offer-player.png')
    await page(`window.__jobs = []; document.querySelector('#toasts .toast-offer .toast-action').click(); 0`)
    check('... its click shows Home with the job card, the item in the corner', await until(async () => (await page(`!document.querySelector('.home').hidden && !document.querySelector('#job').hidden`)) &&
      (await page(`!document.querySelector('#corner').hidden`)), 4000))
    check('... and the new Clean and play runs', await until(() => page(`window.__jobs.some((j) => j.kind === 'play')`), 5000))
    await page(`document.querySelector('#go').click(); 0`)
    check('... cancel still works', await until(() => page(`window.__jobs.some((j) => j.state === 'cancelled') || window.__jobs.some((j) => j.state === 'done')`), 30000))
    await shot('after-cancel.png')

    // 6. A real focus change (blur, then focus): only noted, Windows may keep another window in front
    await clipboard.writeText('https://www.youtube.com/watch?v=ScMzIvxBSi4')
    win.blur()
    await sleep(400)
    win.focus()
    const real = await until(async () => (await offer()) === 'https://www.youtube.com/watch?v=ScMzIvxBSi4', 3000)
    note(`INFO a real blur and focus ${real ? 'showed the offer' : 'did not reach the page (window focus kept elsewhere)'}`)
  } catch (e) {
    fails++
    note(`FAIL: ${e.stack || e.message}`)
  }
  await clipboard.writeText(saved)
  note(fails ? `${fails} check(s) failed` : 'ALL PASS')
  writeFileSync(join(outDir, 'log.txt'), log.join('\n') + '\n')
  app.quit()
}
