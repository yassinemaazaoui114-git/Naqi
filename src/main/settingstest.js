import { app, dialog, nativeTheme } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Dev check for T11.2 (run with NAQI_SELFTEST=settings and NAQIE_DATA pointing to a folder named naqie-t11.2, outside
// OneDrive; GPU, ~2 min): the Settings page. Opened by the library's gear and the strip's (real clicks), it slides in;
// each choice changes what it says and lands in settings.json / theme.json: the look (the page's colours and Windows'
// theme), Save to (the folder dialog is answered by the test) and MP3 quality (Home's Options follow), the keep rule
// (the engine deletes a 10-day-old kept sound at 1 week), GPU or CPU (the engine starts again, comes back ready on
// the CPU, then on the graphics card; refused while a file is cleaned). A page reload shows the same choices, and the
// engine started again keeps the keep rule. Escape goes back. Light, dark, small window. The real settings files are
// put back as they were. Log and shots in test_out/t11.2/.
const outDir = join(app.getAppPath(), 'test_out', 't11.2')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function run(win, engine) {
  mkdirSync(outDir, { recursive: true })
  const log = []
  let fails = 0
  const t0 = Date.now()
  const note = (text) => { log.push(`${((Date.now() - t0) / 1000).toFixed(2)} s  ${text}`); console.log('[settingstest]', text) }
  const check = (name, ok, detail = '') => { fails += !ok; note(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`) }
  const page = (js) => win.webContents.executeJavaScript(js)
  const shot = async (name) => {
    await sleep(500)
    try { writeFileSync(join(outDir, name), (await win.webContents.capturePage()).toPNG()) } catch (e) { note(`no shot ${name}: ${e.message}`) }
  }
  const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(100) } return false }
  const click = async (sel, wait = 400) => {
    const [x, y] = await page(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()`)
    win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) })
    win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    await sleep(wait)
  }
  const key = async (keyCode, wait = 300) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
    await sleep(wait)
  }
  const scrollTo = (sel) => page(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({ block: 'center' })`).then(() => sleep(250))
  const shown = () => page(`(() => { for (const [n, s] of [['home', '.home'], ['player', '#watch'], ['report', '#report'], ['settings', '#settings']]) if (!document.querySelector(s).hidden) return n })()`)
  const files = () => {
    const read = (name) => { try { return JSON.parse(readFileSync(join(app.getPath('userData'), name), 'utf8')) } catch { return {} } }
    return { ...read('settings.json'), theme: read('theme.json').mode }
  }
  const checked = (sel) => page(`document.querySelector(${JSON.stringify(sel)} + ' [aria-checked="true"]')?.dataset.value || document.querySelector(${JSON.stringify(sel)} + ' [aria-checked="true"]')?.dataset.mode`)
  const py = (code) => new Promise((resolve, reject) => execFile('py', ['-3.12', '-c', code], { env: process.env, cwd: join(app.getAppPath(), 'engine'), windowsHide: true },
    (err, out, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(out.trim()))))

  // The real settings files, put back as they were at the end
  const real = {}
  for (const name of ['settings.json', 'theme.json']) {
    const path = join(app.getPath('userData'), name)
    real[name] = existsSync(path) ? readFileSync(path) : null
  }
  const theme = nativeTheme.themeSource
  const showOpen = dialog.showOpenDialog
  const pickedFolder = join(outDir, 'saves here')

  try {
    const data = process.env.NAQIE_DATA || ''
    if (!/naqie-t11\.2[\\/]?$/.test(data)) throw new Error('NAQIE_DATA must be a folder named naqie-t11.2 (the real history is never used)')
    if (process.env.NAQIE_SAVE_DIR) throw new Error('run without NAQIE_SAVE_DIR: this test checks what settings.json keeps')
    // Start from the defaults (the real files are back at the end)
    await page(`window.naqi.setSettings({ keep_days: '14', keep_gb: '5', device: 'gpu', sidebar: 'open' })`)
    check('engine ready', await until(() => engine.status.status === 'ready', 90000), engine.status.gpu?.name)
    if (engine.status.gpu?.device !== 'cuda') { await page(`window.naqi.setDevice('gpu')`); await until(() => engine.status.status === 'ready' && engine.status.gpu, 90000) }
    // Two kept sounds: one fresh, one 10 days old (1 MB each)
    await py(`import datetime, history
for days in (0, 10):
    folder = history.new_history_folder()
    path = folder + '\\\\' + history.CACHE_NAME
    open(path, 'wb').write(b'\\0' * 10**6)
    row = history.add_history('https://example.com/' + str(days), 'kept ' + str(days), None, path)
    when = (datetime.datetime.now() - datetime.timedelta(days=days)).isoformat(timespec='seconds')
    history._history('UPDATE files SET added = ? WHERE id = ?', (when, row))`)
    await sleep(2500)   // the launch intro has gone
    await page(`document.documentElement.dataset.theme = 'light'`)

    // ---- Opening: the library's gear; the page slides in
    check('Home has no theme switch any more', await page(`!document.querySelector('.top #theme')`))
    await click('#open-settings', 80)
    const entering = await page(`document.querySelector('#settings').classList.contains('is-entering') && document.querySelector('#settings').dataset.way`)
    await sleep(500)
    check('the gear opens Settings, sliding in', (await shown()) === 'settings' && entering === 'forward', String(entering))
    check('the gear is lit while it shows', await page(`document.querySelector('#open-settings').getAttribute('aria-current') === 'page'`))
    check('defaults shown: 2 weeks, 5 GB, graphics card; no MP3 quality (chosen when saving)', (await checked('#set-days')) === '14'
      && (await checked('#set-gb')) === '5' && (await checked('#set-device')) === 'gpu' && !(await page(`!!document.querySelector('#set-kbps')`)))
    await until(() => page(`/of 5 GB used/.test(document.querySelector('#keep-text').textContent)`), 3000)
    check('the meter shows the space used', await page(`document.querySelector('#keep-text').textContent`) === '2 MB of 5 GB used',
      await page(`document.querySelector('#keep-text').textContent`))
    await shot('1-settings-light.png')

    // ---- Look: each of the three, starting with one that is not the saved one (a click on it changes nothing)
    const start = await checked('#theme')
    const order = ['dark', 'light', 'system'].filter((m) => m !== start).concat(start)
    for (const mode of order) {
      await click(`#theme [data-mode="${mode}"]`, 1200)   // the circle has ended (a click during it is not taken)
      const page_ = mode === 'system' ? undefined : mode
      await until(() => page(`document.documentElement.dataset.theme`).then((t) => t === page_), 5000)
      check(`${mode}: the page${mode === 'system' ? ' follows Windows' : ` turns ${mode}`}, Windows' theme too, kept`,
        await page(`document.documentElement.dataset.theme`) === page_ && nativeTheme.themeSource === mode && files().theme === mode,
        `${await page('document.documentElement.dataset.theme')} ${nativeTheme.themeSource} ${files().theme}`)
      if (mode === 'dark') await shot('2-settings-dark.png')
    }
    await page(`document.documentElement.dataset.theme = 'light'`)

    // ---- Saving
    mkdirSync(pickedFolder, { recursive: true })
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [pickedFolder] })
    await click('#set-folder-change', 600)
    check('Save to: the chosen folder shows, is kept, Home follows', await page(`document.querySelector('#set-folder').textContent`) === pickedFolder
      && files().folder === pickedFolder && await page(`document.querySelector('#folder').textContent`) === pickedFolder)
    dialog.showOpenDialog = showOpen

    // ---- Cleaned sounds kept
    await scrollTo('#set-days')
    await click('#set-days [data-value="7"]', 1200)
    const rule = await page('window.naqi.keepRule()')
    check('1 week: the engine uses it, the 10-day-old sound is deleted', rule.days === 7 && rule.used === 10 ** 6, JSON.stringify(rule))
    check('... the page says so', /One older sound was deleted/.test(await page(`document.querySelector('#keep-note').textContent`)))
    await click('#set-gb [data-value="10"]', 800)
    check('10 GB: kept, the engine uses it', files().keep_days === '7' && files().keep_gb === '10' && (await page('window.naqi.keepRule()')).gb === 10)
    await shot('3-keep-light.png')

    // ---- GPU or CPU
    await scrollTo('#set-device')
    const ran = []
    const seen = (s) => ran.push(s.status)
    engine.on('status', seen)
    await click('#set-device [data-value="cpu"]', 200)
    check('CPU only: the engine starts again', await until(() => ran.includes('starting'), 5000), ran.join(' '))
    await shot('4-device-switching.png')
    const cpu = await until(() => engine.status.status === 'ready' && engine.status.gpu?.device === 'cpu', 90000)
    check('... and comes back ready on the CPU, kept', cpu && engine.status.gpu.chosen === 'cpu' && files().device === 'cpu', JSON.stringify(engine.status.gpu))
    await until(() => page(`/Ready/.test(document.querySelector('#device-note').textContent)`), 3000)
    check('... the page and the engine light say so', /on the CPU/.test(await page(`document.querySelector('#device-note').textContent`))
      && await page(`document.querySelector('#engine-text').textContent`) === 'Chosen in Settings · slower')
    check('the engine started again keeps the keep rule', (await page('window.naqi.keepRule()')).days === 7)
    await shot('5-device-cpu.png')
    ran.length = 0
    await click('#set-device [data-value="gpu"]', 200)
    const gpu = await until(() => engine.status.status === 'ready' && engine.status.gpu?.device === 'cuda', 90000)
    engine.off('status', seen)
    check('Graphics card: the engine comes back on it', gpu && ran.includes('starting') && files().device === 'gpu', engine.status.gpu?.name)

    // Refused while something is cleaned (the job would be lost)
    const sample = join(app.getAppPath(), 'samples', 'narration_30s.mp3')
    const job = await page(`window.naqi.startJob({ kind: 'file', src: ${JSON.stringify(sample)}, dst: ${JSON.stringify(join(outDir, 'busy.mp3'))}, kbps: 128 })`)
    await sleep(1500)
    const refused = await page(`window.naqi.setDevice('cpu').then(() => 'switched', (e) => e.message)`)
    check('refused while a file is cleaned', /cleaning or saving/.test(refused) && engine.status.status === 'ready', refused)
    await page(`window.naqi.cancelJob(${job.id})`)
    check('... and the choice stays the graphics card', files().device === 'gpu')

    // ---- Kept after a restart of the window
    win.webContents.reload()
    await new Promise((r) => win.webContents.once('did-finish-load', r))
    await sleep(3000)
    await page(`document.documentElement.dataset.theme = 'light'`)
    await click('#open-settings', 900)
    await until(() => page(`/used/.test(document.querySelector('#keep-text').textContent)`), 3000)
    const after = [await shown(), await checked('#set-days'), await checked('#set-gb'),
      await page(`document.querySelector('#set-folder').textContent`) === pickedFolder, await checked('#set-device'), await checked('#theme')]
    check('after a reload: 1 week, 10 GB, the folder, the graphics card, the last look',
      after.join() === ['settings', '7', '10', true, 'gpu', order.at(-1)].join(), after.join())

    // ---- Back: Escape, and the strip's gear
    await key('Escape')
    check('Escape goes back to Home', (await shown()) === 'home')
    await click('#side-toggle', 700)
    await click('#rail-settings', 900)
    check('the strip\'s gear opens it too', (await shown()) === 'settings' && await page(`document.querySelector('#rail-settings').getAttribute('aria-current') === 'page'`),
      `${await shown()} folded=${await page('document.body.dataset.side')}`)
    await click('#settings-back', 700)
    check('Back returns to Home', (await shown()) === 'home')
    await click('#rail-open', 700)

    // ---- Small window, dark
    const [w, h] = win.getSize()
    win.setSize(780, 620)
    await click('#open-settings', 900)
    await page(`document.documentElement.dataset.theme = 'dark'`)
    check('small window: nothing wider than the page', await page(`document.querySelector('#settings').scrollWidth <= document.querySelector('#settings').clientWidth`))
    await shot('6-small-dark.png')
    await scrollTo('#set-device')
    await shot('7-small-dark-device.png')
    win.setSize(w, h)
    await sleep(400)
  } catch (e) {
    check('test ran', false, e.message)
  } finally {
    dialog.showOpenDialog = showOpen
    // The real settings files are put back as they were (the engine goes back to them at the next start)
    for (const [name, bytes] of Object.entries(real)) {
      const path = join(app.getPath('userData'), name)
      if (bytes) writeFileSync(path, bytes)
      else rmSync(path, { force: true })
    }
    nativeTheme.themeSource = theme
    note(fails ? `${fails} check(s) FAILED` : 'ALL PASSED')
    writeFileSync(join(outDir, 'log.txt'), log.join('\n') + '\n')
    setTimeout(() => app.quit(), 500)
  }
}
