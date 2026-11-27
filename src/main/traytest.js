import { app, nativeTheme } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Dev check for T11.4 (run with NAQI_SELFTEST=tray and NAQIE_DATA pointing to a temporary folder; GPU, ~2 min): Naqi
// in the tray. A 30 s sample is cleaned the moment the engine says ready (the models still load: cold), then the
// window is closed (hidden, the engine and its pid stay), brought back by the tray icon, closed again while a cleaning
// runs (it finishes while hidden), brought back by the menu's Open, and cleaned again (warm: no model load). The
// Settings page's switches land in settings.json and survive a reload; Start with Windows registers nothing in dev;
// with the tray off, closing is not held back. Light and dark shots. The real settings files are put back, then the
// menu's Quit ends Naqi: the log names the engine's pid, which must be gone afterwards. Log and shots in test_out/t11.4/.
const outDir = join(app.getAppPath(), 'test_out', 't11.4')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function run(win, engine, tray) {
  mkdirSync(outDir, { recursive: true })
  const log = []
  let fails = 0
  const t0 = Date.now()
  const note = (text) => { log.push(`${((Date.now() - t0) / 1000).toFixed(2)} s  ${text}`); console.log('[traytest]', text) }
  const check = (name, ok, detail = '') => { fails += !ok; note(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`) }
  const page = (js) => win.webContents.executeJavaScript(js)
  const shot = async (name) => {
    await sleep(500)
    try { writeFileSync(join(outDir, name), (await win.webContents.capturePage()).toPNG()) } catch (e) { note(`no shot ${name}: ${e.message}`) }
  }
  const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(100) } return false }
  const saved = () => { try { return JSON.parse(readFileSync(join(app.getPath('userData'), 'settings.json'), 'utf8')) } catch { return {} } }
  const sample = join(app.getAppPath(), 'samples', 'narration_30s.mp3')
  // A 30 s sample cleaned from the page: seconds from the start to done, and the engine states seen meanwhile
  const clean = async (name) => {
    const states = []
    const onState = (event, value) => { if (event === 'state') states.push(`${value.state}${value.models ? '+models' : ''}`) }
    engine.on('event', onState)
    const wav = join(outDir, `${name}.wav`)
    rmSync(wav, { force: true })
    const started = Date.now()
    const job = page(`new Promise((resolve) => {
      window.naqi.onJob((j) => { if (j.state !== 'running') resolve(j) })
      window.naqi.startJob({ kind: 'sound', src: ${JSON.stringify(sample)}, wav: ${JSON.stringify(wav)} })
        .catch((e) => resolve({ state: 'error', text: e.message }))
    })`)
    return { started, job: job.then((j) => { engine.off('event', onState); return { ...j, seconds: (Date.now() - started) / 1000, states } }) }
  }

  const real = {}
  for (const name of ['settings.json', 'theme.json']) {
    const path = join(app.getPath('userData'), name)
    real[name] = existsSync(path) ? readFileSync(path) : null
  }
  const theme = nativeTheme.themeSource
  const putBack = () => {
    for (const [name, data] of Object.entries(real)) {
      const path = join(app.getPath('userData'), name)
      if (data) writeFileSync(path, data)
      else rmSync(path, { force: true })
    }
    nativeTheme.themeSource = theme
  }

  try {
    // Start from the defaults: tray on, Start with Windows off, the balloon not shown yet
    const plain = saved()
    delete plain.tray; delete plain.login; delete plain.tray_told
    writeFileSync(join(app.getPath('userData'), 'settings.json'), JSON.stringify(plain, null, 2))

    await until(() => engine.status.status === 'ready', 60000)
    const cold = await clean('cold')
    const coldJob = await cold.job
    check('cold: the first cleaning (models still loading) finishes', coldJob.state === 'done', `${coldJob.seconds.toFixed(1)} s, states ${coldJob.states.join(' > ') || 'none'}`)
    await until(() => engine.modelsAt, 60000)
    note(`engine ready after ${((engine.readyAt - t0) / 1000).toFixed(1)} s of the test, models loaded ${((engine.modelsAt - engine.readyAt) / 1000).toFixed(1)} s after ready`)
    const pid = engine.child.pid
    note(`engine pid ${pid}`)

    // Settings page: the switches and their defaults
    await page(`document.querySelector('#open-settings').click()`)
    await until(() => page(`!document.querySelector('#settings').hidden`), 3000)
    await sleep(600)
    check('Settings: tray on by default', await page(`document.querySelector('#set-tray').checked`))
    check('Settings: Start with Windows off by default', !(await page(`document.querySelector('#set-login').checked`)))
    check('Settings: dev mode says only the installed Naqi starts with Windows', /installed Naqi/.test(await page(`document.querySelector('#set-login-text').textContent`)))
    await page(`document.querySelector('#set-close').scrollIntoView({ block: 'center' })`)
    for (const mode of ['light', 'dark']) {
      await page(`document.querySelector('#theme [data-mode="${mode}"]').click(); document.querySelector('#set-close').scrollIntoView({ block: 'center' })`)
      await sleep(700)
      await shot(`1-settings-${mode}.png`)
    }
    await page(`document.querySelector('#set-login').click()`)
    check('Start with Windows on: kept in settings.json', await until(() => saved().login === 'on', 2000))
    check('Start with Windows in dev: nothing registered with Windows', !app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin)
    await page(`location.reload()`)
    await until(() => page(`document.readyState === 'complete'`).catch(() => false), 10000)
    await sleep(2500)   // the launch intro
    await page(`document.querySelector('#open-settings').click()`)
    await sleep(800)
    check('after a reload: Start with Windows still on', await page(`document.querySelector('#set-login').checked`))
    await page(`document.querySelector('#set-login').click()`)
    check('Start with Windows off again', await until(() => saved().login === 'off', 2000))
    await page(`document.querySelector('#settings-back').click()`)

    // Close: hidden, not closed; the engine and its models stay
    win.close()
    await sleep(800)
    check('close: the window is hidden, not closed', !win.isDestroyed() && !win.isVisible())
    check('close: the engine keeps running (same pid, ready)', engine.child?.pid === pid && engine.status.status === 'ready')
    check('close: the first hide shows the balloon once (tray_told kept)', saved().tray_told === 'yes')
    const health = await engine.call('/health')
    check('hidden: the models stay loaded', health.models === true)
    tray.tray.emit('click')
    await sleep(600)
    check('a click on the tray icon brings the window back', win.isVisible())
    await shot('2-back-from-tray.png')

    // A cleaning goes on while hidden
    const during = await clean('hidden')
    await sleep(1500)
    win.close()
    await sleep(500)
    check('closed during a cleaning: hidden', !win.isDestroyed() && !win.isVisible())
    const duringJob = await during.job
    check('the cleaning finishes while hidden', duringJob.state === 'done' && !win.isVisible(), `${duringJob.seconds.toFixed(1)} s`)
    tray.menu.items[0].click()
    await sleep(600)
    check("the menu's Open brings the window back", win.isVisible())

    // Warm: the next cleaning after coming back has no model load
    const warm = await clean('warm')
    const warmJob = await warm.job
    check('warm: the cleaning after coming back finishes', warmJob.state === 'done', `${warmJob.seconds.toFixed(1)} s, states ${warmJob.states.join(' > ') || 'none (no load)'}`)
    check('warm: no engine start or model load in between', engine.child?.pid === pid && !warmJob.states.some((x) => x.startsWith('starting')))
    note(`cold ${coldJob.seconds.toFixed(1)} s vs warm ${warmJob.seconds.toFixed(1)} s for the same 30 s sample`)

    // Tray off: closing is not held back (the test holds it, so it can go on)
    await page(`document.querySelector('#open-settings').click()`)
    await sleep(800)
    await page(`document.querySelector('#set-tray').click()`)
    check('tray off: kept in settings.json', await until(() => saved().tray === 'off', 2000))
    let held = null
    const hold = (e) => { held = e.defaultPrevented; e.preventDefault() }
    win.on('close', hold)
    win.close()
    await sleep(300)
    win.off('close', hold)
    check('tray off: closing quits (not held back by the tray)', held === false)
    await page(`document.querySelector('#set-tray').click()`)
    check('tray on again', await until(() => saved().tray === 'on', 2000))
    await page(`document.querySelector('#settings-back').click()`)
  } catch (e) {
    fails++
    note(`FAIL: ${e.stack || e.message}`)
  }
  putBack()
  note(fails ? `${fails} FAILED` : 'ALL PASS')
  note(`quitting from the tray menu; engine pid ${engine.child?.pid} must be gone after`)
  writeFileSync(join(outDir, 'log.txt'), log.join('\n') + '\n')
  tray.menu.items[2].click()
}
