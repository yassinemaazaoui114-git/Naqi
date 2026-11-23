import { app, clipboard } from 'electron'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { details } from './details'

// Dev check for T10.3 (run with NAQI_SELFTEST=details and NAQIE_DATA pointing to a folder named naqie-t10.3, outside
// OneDrive; it is emptied first; internet, about 1 min): "Copy details" on engine errors. A link with no video ends
// as an error on the job card, a library item that is not there as an error toast, and the engine is made to stop
// for good; each shows the button, and its click puts the error, the time and the versions on the clipboard. Text
// with the user folder, the user name, an e-mail address and the engine's token comes out with them blanked.
// Log, copied texts and screenshots in test_out/t10.3/.
const outDir = join(app.getAppPath(), 'test_out', 't10.3')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function run(win, engine) {
  mkdirSync(outDir, { recursive: true })
  const log = []
  const copies = []
  let fails = 0
  const t0 = Date.now()
  const note = (text) => { log.push(`${((Date.now() - t0) / 1000).toFixed(2)} s  ${text}`); console.log('[detailstest]', text) }
  const check = (name, ok, detail = '') => { fails += !ok; note(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`) }
  const page = (js) => win.webContents.executeJavaScript(js)
  const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(150) } return false }
  const shot = async (name) => { await sleep(400); writeFileSync(join(outDir, name), (await win.webContents.capturePage()).toPNG()) }
  const setTheme = (t) => page(`(() => { const d = document.documentElement.dataset; if (${JSON.stringify(t)}) d.theme = ${JSON.stringify(t)}; else delete d.theme })()`)
  const home = homedir()
  const user = userInfo().username
  // Nothing private: no user folder or name, no e-mail address, no token
  const clean = (text) => !text.toLowerCase().includes(home.toLowerCase()) && !new RegExp(`\\b${user}\\b`, 'i').test(text) &&
    !/[\w.+-]+@[\w-]+\.[\w.-]+/.test(text) && !text.includes(engine.token)
  const versions = (text) => [`Naqi ${app.getVersion()}`, `Electron ${process.versions.electron}`, 'Python 3.', 'PyTorch ', 'yt-dlp 20', 'Windows ', 'Graphics card: ']
    .filter((v) => !text.includes(v))
  // Clicks the Copy details button found by sel, returns what landed on the clipboard and the button's label then
  const copy = async (name, sel) => {
    await clipboard.writeText('')
    await page(`document.querySelector(${JSON.stringify(sel)}).click()`)
    await until(async () => (await clipboard.readText()) !== '', 3000)
    const text = await clipboard.readText()
    const label = await page(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); return b.textContent.trim() || b.dataset.tip })()`)
    copies.push(`----- ${name} -----\n${text}`)
    return { text, label }
  }
  const has = (sel) => page(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); return !!b && !!b.offsetParent })()`)

  try {
    const data = process.env.NAQIE_DATA || ''
    if (!/naqie-t10\.3[\\/]?$/.test(data)) throw new Error('NAQIE_DATA must be a folder named naqie-t10.3 (the real history is never used)')
    rmSync(data, { recursive: true, force: true })
    check('engine ready with the models', await until(async () => engine.status.status === 'ready' && (await engine.call('/health')).models, 120000), engine.status.gpu?.name)
    const theme = await page('document.documentElement.dataset.theme || null')

    // 1. The job card: a link with no video
    check('no Copy details while nothing failed', !(await has('#job-details .copy-details')) && !(await has('#engine-details .copy-details')))
    await page(`window.__end = null; window.naqi.onJob((j) => { if (j.state !== 'running') window.__end = j.state }); 0`)
    await page(`(() => { const u = document.querySelector('#url'); u.value = 'https://example.com/'; u.dispatchEvent(new Event('input')) })()`)
    await page(`document.querySelector('#go').click()`)
    await until(() => page('window.__end'), 90000)
    const jobText = await page(`document.querySelector('#job-text').textContent`)
    check('a bad link ends as an error on the job card', (await page('window.__end')) === 'error', jobText)
    check('... with Copy details', await has('#job-details .copy-details'))
    let c = await copy('job card', '#job-details .copy-details')
    check('... the click copies the error, the time and the versions', c.text.includes(jobText) && /Time: \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC/.test(c.text) &&
      c.text.includes('Where: Home, Clean and play') && !versions(c.text).length, versions(c.text).join(', ') || 'all there')
    check('... and the button says Copied', c.label === 'Copied', c.label)
    check('... nothing private in it', clean(c.text))
    await setTheme('light')
    await shot('job-light.png')
    await setTheme('dark')
    await shot('job-dark.png')
    await setTheme(theme)
    check('... back to Copy details after a moment', await until(async () => (await page(`document.querySelector('#job-details .copy-details').textContent.trim()`)) === 'Copy details', 4000))

    // 2. An error toast from the engine: a library item that is not there
    await page(`window.dispatchEvent(new CustomEvent('naqi-play', { detail: { id: 987654 } })); 0`)
    check('an engine error toast shows Copy details', await until(() => has('#toasts .toast[data-kind="error"] .copy-details'), 5000),
      await page(`document.querySelector('#toasts .toast[data-kind="error"] .msg-text')?.textContent || ''`))
    c = await copy('toast', '#toasts .toast[data-kind="error"] .copy-details')
    check('... its click copies it with the versions', c.text.includes('Could not play it') && c.text.includes('Where: Player, opening an item') && !versions(c.text).length && clean(c.text))
    await setTheme('light')
    await shot('toast-light.png')
    await setTheme('dark')
    await shot('toast-dark.png')
    await setTheme(theme)

    // 3. Private data is blanked: the user folder (both slash kinds), the user name, an e-mail address, the token
    const secret = `Could not read ${home}\\Videos\\clip.mp4 (${home.replace(/\\/g, '/')}/x.wav), user ${user}, mail someone@example.org, token ${engine.token}`
    const scrubbed = await details(engine, Promise.resolve({}), { where: 'Test', title: 'Error', text: secret })
    check('private data is blanked out of the error', clean(scrubbed) && scrubbed.includes('%USERPROFILE%\\Videos\\clip.mp4') && scrubbed.includes('<user>') &&
      scrubbed.includes('<e-mail>') && scrubbed.includes('<key>'), scrubbed.split('\n').find((l) => l.startsWith('Error:')))

    // 4. The engine light: the engine stopped for good (it stopped 3 times in a minute)
    engine.restarts = [Date.now(), Date.now(), Date.now()]
    execFileSync('taskkill', ['/PID', String(engine.child.pid), '/F'])
    check('the engine stopped for good', await until(async () => engine.status.status === 'stopped', 10000), engine.status.message)
    check('... the engine light shows Copy details', await until(() => has('#engine-details .copy-details'), 3000))
    c = await copy('engine light', '#engine-details .copy-details')
    check('... its click copies the engine message with the versions', c.text.includes('Where: Engine') && c.text.includes('Engine: stopped') &&
      c.text.includes('exit code') && !versions(c.text).length && clean(c.text), versions(c.text).join(', ') || 'versions there')
    await setTheme('light')
    await shot('engine-light.png')
    await setTheme('dark')
    await shot('engine-dark.png')
    await setTheme(theme)
    engine.restart()
    check('Start again: the engine is back and the button goes', await until(async () => engine.status.status === 'ready', 60000) &&
      await until(async () => !(await has('#engine-details .copy-details')), 3000))
  } catch (e) {
    fails++
    note(`FAIL: ${e.stack || e.message}`)
  }
  note(fails ? `${fails} check(s) failed` : 'ALL PASS')
  writeFileSync(join(outDir, 'log.txt'), log.join('\n') + '\n')
  writeFileSync(join(outDir, 'copied.txt'), copies.join('\n'))
  app.quit()
}
