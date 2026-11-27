import { app, ipcMain } from 'electron'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Dev check for T13.1 (run with NAQI_SELFTEST=frame and NAQIE_DATA pointing to a folder named naqie-t13.1, outside
// OneDrive; it is emptied first; GPU, about 2 min): frame step on the real page, pressed as real key events. Three
// 60 s clips at 24, 30 and 60 fps (samples/frames/, made from sync_test_5min.mp4) are each cleaned and played; paused,
// `.` five times and `,` five times move the shown frame by exactly one frame each (its media time), the sound
// follows the frame, five quick presses move five frames, nothing moves while playing, and after playing again the
// picture is in sync. Log and screenshots in test_out/t13.1/.
const outDir = join(app.getAppPath(), 'test_out', 't13.1')
const CLIPS = [24, 30, 60].map((fps) => ({ fps, file: join(app.getAppPath(), 'samples', 'frames', `fps${fps}.mp4`) }))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function run(win, engine) {
  mkdirSync(outDir, { recursive: true })
  const log = []
  let fails = 0
  const t0 = Date.now()
  const note = (text) => { log.push(`${((Date.now() - t0) / 1000).toFixed(2)} s  ${text}`); console.log('[frametest]', text) }
  const check = (name, ok, detail = '') => { fails += !ok; note(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`) }
  const page = (js) => win.webContents.executeJavaScript(js)
  const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(150) } return false }
  const stats = () => page('window.naqiPlayerStats()')
  const frame = () => page('window.naqiFrame()')
  const watching = () => page(`!document.querySelector('#watch').hidden`)
  const press = async (keyCode, wait = 300) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
    if (keyCode.length === 1) win.webContents.sendInputEvent({ type: 'char', keyCode })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
    await sleep(wait)
  }
  // The frame number on screen, from its media time
  const index = (t, fps) => Math.round(t * fps)

  try {
    const data = process.env.NAQIE_DATA || ''
    if (!/naqie-t13\.1[\\/]?$/.test(data)) throw new Error('NAQIE_DATA must be a folder named naqie-t13.1 (the real history is never used)')
    rmSync(data, { recursive: true, force: true })
    check('engine ready with the models', await until(async () => engine.status.status === 'ready' && (await engine.call('/health')).models, 120000), engine.status.gpu?.name)
    ipcMain.removeHandler('choose-files')
    let pick = null
    ipcMain.handle('choose-files', () => [pick])

    for (const { fps, file } of CLIPS) {
      note(`--- ${fps} fps`)
      pick = file
      await page(`document.querySelector('#choose').click()`)
      await sleep(800)
      await page(`document.querySelector('#go').click()`)
      check(`${fps}: the player opens`, await until(watching, 120000))
      await until(async () => (await stats()).firstPlaying !== null && !(await stats()).live, 120000)
      await until(async () => (await stats()).at > 20, 30000)   // played a while: the frame length is measured
      const f0 = await frame()
      check(`${fps}: frame length measured while playing`, Math.abs(f0.d - 1 / fps) < 0.001, `${(f0.d * 1000).toFixed(2)} ms from ${f0.measured} gaps`)

      // While playing, the keys do nothing
      await page(`document.activeElement.blur()`)
      const jumps = (await stats()).frames.length
      await press('.')
      check(`${fps}: . does nothing while playing`, (await stats()).frames.length === jumps && !(await stats()).paused)

      await press('k', 600)
      const start = index((await frame()).shown, fps)
      const moves = []
      const times = []
      let soundOk = true
      for (const [k, dir] of [['.', 1], ['.', 1], ['.', 1], ['.', 1], ['.', 1], [',', -1], [',', -1], [',', -1], [',', -1], [',', -1]]) {
        const before = index((await frame()).shown, fps)
        const t = Date.now()
        await press(k, 0)
        await until(async () => index((await frame()).shown, fps) !== before, 3000)
        times.push(Date.now() - t)
        await sleep(300)
        const f = await frame()
        const s = await stats()
        moves.push(index(f.shown, fps) - before)
        if (Math.abs(s.at - f.shown) > 0.5 / fps) soundOk = false
        if (dir !== moves.at(-1)) note(`  ${k} moved ${moves.at(-1)} frames (shown ${f.shown.toFixed(4)} s, sound ${s.at.toFixed(4)} s)`)
      }
      check(`${fps}: . / , move one frame each while paused`, moves.join() === '1,1,1,1,1,-1,-1,-1,-1,-1', moves.join(' '))
      check(`${fps}: ... the sound follows the frame`, soundOk)
      note(`${fps}: time from the press to the new frame (ms): ${times.join(' ')}`)
      check(`${fps}: ... back where it began`, index((await frame()).shown, fps) === start)
      writeFileSync(join(outDir, `paused-${fps}.png`), (await win.webContents.capturePage()).toPNG())

      // Five quick presses: five frames
      const q0 = index((await frame()).shown, fps)
      for (let i = 0; i < 5; i++) await press('.', 20)
      await sleep(800)
      const q1 = index((await frame()).shown, fps)
      check(`${fps}: five quick presses move five frames`, q1 - q0 === 5, `${q1 - q0}`)
      check(`${fps}: still paused`, (await stats()).paused)

      // Playing again: in sync
      const n = (await stats()).sync.length
      await press('k', 10000)
      const sync = (await stats()).sync.slice(n)
      const worst = Math.max(...sync.map(([, e]) => Math.abs(e)))
      check(`${fps}: in sync after playing again (10 s)`, sync.length > 50 && worst <= 0.05, `${sync.length} frames, max ${(worst * 1000).toFixed(0)} ms`)

      await press('Escape', 600)
      check(`${fps}: back to Home`, !(await watching()))
      await page(`document.querySelector('#corner-close')?.click()`)   // the corner player, if it kept playing
      await sleep(500)
    }
  } catch (e) {
    check('test ran', false, e.stack || e.message)
  } finally {
    note(fails ? `${fails} check(s) FAILED` : 'ALL PASSED')
    writeFileSync(join(outDir, 'log.txt'), log.join('\n') + '\n')
    setTimeout(() => app.quit(), 500)
  }
}
