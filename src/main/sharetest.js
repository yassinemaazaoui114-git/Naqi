import { app, clipboard, nativeTheme } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { linkIn, parseLink } from './links'

// Dev check for T11.5 (GPU + internet, ~3 min): Share to Naqi through Windows itself. Run after npm run build with
// NAQI_LINKS=dev (naqi:// is registered for this dev Electron), NAQI_SELFTEST=share and NAQIE_DATA pointing to a
// folder named naqie-t11.5 outside OneDrive. Started without a link, it only registers, quits and lets Windows open
// naqi://clean?url=<19 s video> a few seconds later (rundll32 url.dll, the same way a browser hands a link over): that
// new Naqi was closed (cold). It checks the video cleans and plays, then sends links the same way while it is open,
// while it cleans (refused, nothing replaced), hidden in the tray, and odd ones (refused with a message, nothing
// started); the checks of the link rules; the Settings page's bookmark (shots light, dark, small window; a click in
// Naqi does nothing; Copy copies it; the bookmark's address round-trips). The real settings, theme and clipboard
// are put back; naqi:// stays registered for this dev Naqi (the installed one takes it back when it starts).
// Log and shots in test_out/t11.5/.
const outDir = join(app.getAppPath(), 'test_out', 't11.5')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const LINK = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'   // "Me at the zoo", 19 s
const naqi = (url) => `naqi://clean?url=${encodeURIComponent(url)}`
// Windows opens a link with its registered app, like a browser does after "Open Naqi?"
const open = (address) => new Promise((resolve) => execFile('rundll32.exe', ['url.dll,FileProtocolHandler', address], { windowsHide: true }, () => resolve()))

export async function run(win, engine, tray) {
  mkdirSync(outDir, { recursive: true })
  const data = process.env.NAQIE_DATA || ''
  if (!/naqie-t11\.5[\\/]?$/.test(data) || process.env.NAQI_LINKS !== 'dev') {
    console.log('[sharetest] NAQIE_DATA must be a folder named naqie-t11.5 and NAQI_LINKS=dev (the real history is never used)')
    return app.quit()
  }
  if (!linkIn(process.argv)) {
    // First start: naqi:// is registered now (NAQI_LINKS=dev); Windows opens the link once this Naqi has quit. It
    // quits only once the engine is up (a stop while it starts can hang)
    const end = Date.now() + 120000
    while (engine.status.status !== 'ready' && Date.now() < end) await sleep(300)
    writeFileSync(join(outDir, 'log.txt'), 'registered naqi://, opening the link through Windows in 10 s (cold start)\n')
    spawn('cmd.exe', ['/c', `ping -n 11 127.0.0.1 >nul & rundll32.exe url.dll,FileProtocolHandler "${naqi(LINK)}"`],
      { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref()
    return app.quit()
  }

  const log = []
  let fails = 0
  const t0 = Date.now() - process.uptime() * 1000   // the moment Windows started this Naqi
  const note = (text) => {
    log.push(`${((Date.now() - t0) / 1000).toFixed(2)} s  ${text}`)
    writeFileSync(join(outDir, 'log.txt'), log.join('\n') + '\n')   // as it goes: Windows started this Naqi, no console
  }
  const check = (name, ok, detail = '') => { fails += !ok; note(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`) }
  const page = (js) => win.webContents.executeJavaScript(js)
  const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(150) } return false }
  const shot = async (name) => {
    await sleep(500)
    try { writeFileSync(join(outDir, name), (await win.webContents.capturePage()).toPNG()) } catch (e) { note(`no shot ${name}: ${e.message}`) }
  }
  const jobs = []
  engine.on('event', (event, v) => { if (event === 'job' && v.kind === 'play' && !jobs.some((j) => j.id === v.id)) jobs.push(v) })
  const watching = () => page(`!document.querySelector('#watch').hidden`)
  const playing = () => page(`window.naqiPlayerStats().at > 0.5`)
  const jobDone = (id) => until(async () => (await engine.call('/health')).busy === false && jobs.some((j) => j.id === id), 120000)
  const lastError = () => page(`(() => { const t = [...document.querySelectorAll('#toasts .toast[data-kind="error"]:not(.is-leaving)')].pop(); return t ? t.querySelector('.msg-title').textContent + ' | ' + t.querySelector('.msg-text').textContent : null })()`)
  // The link only fills the box (nothing starts by itself); the test then clicks Clean and play
  const filled = (link) => until(async () => (await page(`document.querySelector('#url').value`)) === link && !(await page(`document.querySelector('#go').disabled`)), 120000)
  const waitsForClick = async (before) => { await sleep(3000); return jobs.length === before && !(await page(`!document.querySelector('#watch').hidden`)) }
  const clickGo = () => page(`document.querySelector('#go').click(); 0`)
  const closeToasts = async () => { await page(`document.querySelectorAll('#toasts .toast-close').forEach((b) => b.click()); 0`); await sleep(500) }

  const real = {}
  for (const name of ['settings.json', 'theme.json']) {
    const path = join(app.getPath('userData'), name)
    real[name] = existsSync(path) ? readFileSync(path) : null
  }
  const theme = nativeTheme.themeSource
  const clip = await clipboard.readText()

  try {
    // 1. Closed: Windows started this Naqi with the link
    // (Windows writes it naqi://clean/?url=..., with a slash)
    check('cold: Windows started Naqi with the naqi:// link', /^naqi:\/\/clean\/?\?url=/.test(linkIn(process.argv)) && !!parseLink(linkIn(process.argv)).url, linkIn(process.argv))
    check('cold: the window shows', await until(() => win.isVisible(), 10000))
    check('cold: the link is in the box, Clean and play ready', await filled(LINK), `${((Date.now() - t0) / 1000).toFixed(1)} s after Windows started Naqi`)
    check('cold: nothing starts before the click', await waitsForClick(0))
    await shot('1-cold-filled.png')
    await clickGo()
    check('cold: the click starts Clean and play', await until(() => jobs.length > 0, 10000))
    check('cold: the player opens and the video plays', await until(async () => (await watching()) && (await playing()), 120000), `${((Date.now() - t0) / 1000).toFixed(1)} s after the start`)
    await shot('1-cold-playing.png')
    check('cold: its cleaning ends', await jobDone(jobs[0]?.id))

    // 2. Open: another link through Windows goes to this Naqi (no second Naqi), and plays
    await page(`window.__shared = 0; window.naqi.onLink(() => window.__shared++); 0`)
    const second = 'https://youtu.be/jNQXAC9IVRw'
    let sent = Date.now()
    await open(naqi(second))
    check('open: the link reaches the Naqi that is open', await until(() => page('window.__shared === 1'), 10000))
    check('open: the link is in the box', await filled(second), `${((Date.now() - sent) / 1000).toFixed(1)} s after the link`)
    check('open: nothing starts before the click (the player went to Home)', await waitsForClick(1) && (await page(`document.querySelector('#url').value`)) === second)
    await clickGo()
    check('open: the click starts a new Clean and play', await until(() => jobs.length === 2, 10000))
    // 3. While it cleans: refused, the running cleaning is not replaced
    await open(naqi('https://www.youtube.com/watch?v=M7lc1UVf-VE'))
    check('busy: a link while cleaning is refused with a message', await until(async () => /busy/.test((await lastError()) || ''), 8000), await lastError())
    check('busy: nothing replaced (one cleaning, the same link)', jobs.length === 2 && (await page(`document.querySelector('#url').value`)) === second)
    await shot('3-busy.png')
    check('open: it plays', await until(async () => (await watching()) && (await playing()), 120000), `${((Date.now() - sent) / 1000).toFixed(1)} s after the link`)
    await jobDone(jobs[1]?.id)
    await closeToasts()

    // 4. In the tray: the window comes back and the link plays
    await page(`window.naqi.setSettings({ tray: 'on' })`)
    win.close()
    await sleep(800)
    check('tray: closing hides Naqi', !win.isDestroyed() && !win.isVisible())
    const third = `${LINK}&t=4s`
    sent = Date.now()
    await open(naqi(third))
    check('tray: the link brings the window back', await until(() => win.isVisible(), 8000))
    check('tray: the link is in the box, nothing started', await filled(third) && await waitsForClick(2))
    await clickGo()
    check('tray: the click starts Clean and play', await until(() => jobs.length === 3, 10000))
    check('tray: it plays', await until(async () => (await watching()) && (await playing()), 120000), `${((Date.now() - sent) / 1000).toFixed(1)} s after the link`)
    await jobDone(jobs[2]?.id)
    await shot('4-from-tray.png')

    // 5. Odd links through Windows: each refused with a message, nothing started
    const odd = {
      'another request': `naqi://delete?url=${encodeURIComponent(LINK)}`,
      'no link': 'naqi://clean',
      'a file on this PC': naqi('file:///C:/Windows/win.ini'),
      'a script': naqi('javascript:alert(1)'),
      'this PC (127.0.0.1)': naqi('http://127.0.0.1:8000/x'),
      'this PC (localhost)': naqi('http://localhost/x'),
      'the home network': naqi('http://192.168.1.1/'),
      'ftp': naqi('ftp://example.com/a.mp4'),
      'a name and password': naqi('https://user:pass@example.com/v'),
      'not a link': naqi('hello world')
    }
    for (const [name, address] of Object.entries(odd)) {
      await closeToasts()
      const before = jobs.length
      await open(address)
      const shown = await until(async () => /could not use that link/.test((await lastError()) || ''), 6000)
      check(`refused: ${name}`, shown && jobs.length === before, await lastError())
    }
    await shot('5-refused.png')
    await closeToasts()

    // 6. The link rules
    const rules = [
      [`naqi://clean/?url=${encodeURIComponent(LINK)}`, LINK], [`NAQI://CLEAN?url=${encodeURIComponent(LINK)}`, LINK],
      [naqi('http://vimeo.com/76979871'), 'http://vimeo.com/76979871'], [naqi(`${LINK}&list=PL590L5WQmH8fJ54F369BLDSqIwcs-TCfs`), `${LINK}&list=PL590L5WQmH8fJ54F369BLDSqIwcs-TCfs`],
      [naqi('http://10.0.0.5/v'), null], [naqi('http://[::1]/v'), null], [naqi('http://intranet/v'), null], [naqi('http://172.20.1.1/v'), null],
      [naqi('https://example.com/' + 'a'.repeat(2100)), null], [`naqi://clean?url=${encodeURIComponent(LINK)}&url=x`, LINK], ['naqi:clean', null], ['', null]
    ]
    for (const [address, want] of rules) {
      const got = parseLink(address)
      check(`rule: ${address.slice(0, 80)}`, want ? got.url === want : !!got.error && !got.url, got.url || got.error)
    }

    // 7. Settings: the bookmark
    await page(`document.querySelector('#open-settings').click()`)
    await until(() => page(`!document.querySelector('#settings').hidden`), 3000)
    await sleep(700)
    const href = await page(`document.querySelector('#share-chip').getAttribute('href')`)
    check('Settings: the bookmark is the naqi:// bookmarklet', /^javascript:void\(location\.href='naqi:\/\/clean\?url='\+encodeURIComponent\(location\.href\)\)$/.test(href), href)
    // What the bookmark sends on a YouTube page, read back by Naqi's link rules
    const pageUrl = `${LINK}&t=12s`
    const sentBack = await page(`(() => { const location = { href: ${JSON.stringify(pageUrl)} }; return 'naqi://clean?url=' + encodeURIComponent(location.href) })()`)
    check("Settings: the bookmark's address round-trips", parseLink(sentBack).url === pageUrl, sentBack)
    const at = await page('location.href')
    await page(`document.querySelector('#share-chip').click(); 0`)
    await sleep(500)
    check('Settings: a click on it in Naqi does nothing but say so', (await page('location.href')) === at && /Drag it/.test(await page(`document.querySelector('#share-hint').textContent`)))
    win.focus()
    await page(`document.querySelector('#share-copy').click(); 0`)
    check('Settings: Copy copies the bookmark', await until(async () => (await clipboard.readText()) === href, 3000), await page(`document.querySelector('#share-copy span').textContent`))
    await page(`document.querySelector('#share').dataset.drag = 'near'; document.querySelector('#set-share').scrollIntoView({ block: 'start' }); 0`)
    for (const mode of ['light', 'dark']) {
      await page(`document.documentElement.dataset.theme = '${mode}'`)
      await sleep(600)
      await shot(`7-settings-${mode}.png`)
    }
    const size = win.getSize()
    win.setSize(740, 560)
    await sleep(600)
    await page(`document.querySelector('#set-share').scrollIntoView({ block: 'start' }); 0`)
    await shot('7-settings-small.png')
    win.setSize(...size)
    note('shots done')
    await page(`delete document.querySelector('#share').dataset.drag; delete document.documentElement.dataset.theme; 0`)
  } catch (e) {
    fails++
    note(`FAIL: ${e.stack || e.message}`)
  }
  for (const [name, saved] of Object.entries(real)) {
    const path = join(app.getPath('userData'), name)
    if (saved) writeFileSync(path, saved)
    else rmSync(path, { force: true })
  }
  note('settings put back')
  nativeTheme.themeSource = theme
  if ((await clipboard.readText()) !== clip) await clipboard.writeText(clip)
  note(fails ? `${fails} FAILED` : 'ALL PASS')
  tray.menu.items[2].click()
}
