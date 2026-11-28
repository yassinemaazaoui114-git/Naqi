import { app, ipcMain } from 'electron'
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Dev check for T13.4 (GPU, about 4 min): resume where you stopped, on the real page. Run on the built files, because
// it restarts Naqi once: `npm run build`, then NAQI_SELFTEST=resume with NAQIE_DATA pointing to a folder named
// naqie-t13.4 (outside OneDrive; emptied first) and `electron .`.
// Part 1: a 5 min video and a 5 min sound are cleaned and played, left at 2:00 and 1:00; Continue watching lists both
// (the video with its picture, the sound with its sign, the last one first); a click opens each at that moment;
// the video taken to 95% leaves the group and opens from the start; then the sound plays on and Naqi quits while it
// plays (its place is kept on the way out). Part 2 (Naqi started again by the test): the sound is still listed and
// opens where Naqi quit. Silent, like every self-test. Log and screenshots in test_out/t13.4/.
const outDir = join(app.getAppPath(), 'test_out', 't13.4')
const VIDEO = join(app.getAppPath(), 'samples', 'mutes_5min.mp4')
const SOUND = join(app.getAppPath(), 'samples', 'narration_over_music.mp3')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function run(win, engine) {
  mkdirSync(outDir, { recursive: true })
  const second = process.env.NAQI_RESUME_PART === '2'
  const state = join(outDir, 'state.json')
  let fails = 0
  const t0 = Date.now()
  const note = (text) => {
    appendFileSync(join(outDir, 'log.txt'), `${second ? 'part 2' : 'part 1'} ${((Date.now() - t0) / 1000).toFixed(2)} s  ${text}\n`)
    console.log('[resumetest]', text)
  }
  const check = (name, ok, detail = '') => { fails += !ok; note(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`) }
  const page = (js) => win.webContents.executeJavaScript(js)
  const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(150) } return false }
  const stats = () => page('window.naqiPlayerStats()')
  const watching = () => page(`!document.querySelector('#watch').hidden`)
  // The library slid out for the picture when it is folded (as a hover does; the remembered choice is not touched)
  const shot = async (name) => {
    await page(`document.body.toggleAttribute('data-peek', document.body.dataset.side === 'closed')`)
    await sleep(700)
    writeFileSync(join(outDir, `${name}.png`), (await win.webContents.capturePage()).toPNG())
    await page(`document.body.removeAttribute('data-peek')`)
    await sleep(400)
  }
  const press = async (keyCode, wait = 250) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
    if (keyCode.length === 1) win.webContents.sendInputEvent({ type: 'char', keyCode })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
    await sleep(wait)
  }
  // Continue watching as shown: [{ id, title, meta, img }]
  const group = () => page(`document.querySelector('#cont').hidden ? [] : [...document.querySelectorAll('#cont-list li')].map((li) => ({
    id: Number(li.dataset.id), title: li.querySelector('.lib-title').textContent, meta: li.querySelector('.lib-meta').textContent,
    img: !!li.querySelector('img')?.naturalWidth, glyph: !!li.querySelector('.cont-glyph') }))`)
  const openFromGroup = async (id) => {
    await page(`document.querySelector('#cont-list li[data-id="${id}"] button').click()`)
    await until(watching, 15000)
    await until(async () => (await stats()).firstPlaying !== null, 30000)
    await sleep(400)
    return stats()
  }
  // Leaves the player and stops the item (the corner's close): its place is kept
  const leave = async () => {
    await press('Escape', 600)
    await page(`document.querySelector('#corner-close')?.click()`)
    await sleep(1200)
  }
  const cleanAndPlay = async (file) => {
    await page(`document.querySelector('#choose').click()`)
    await sleep(800)
    await page(`document.querySelector('#go').click()`)
    await until(watching, 120000)
    await until(async () => { const s = await stats(); return s.firstPlaying !== null && !s.live }, 180000)
    return (await stats()).id
  }
  // Jumps to `to` seconds with the player's own keys (L = +10 s), then plays 2 s and pauses
  const goTo = async (to) => {
    await page(`document.activeElement.blur()`)
    for (let i = 0; i < 40 && (await stats()).at < to - 10; i++) await press('l', 120)
    await sleep(2000)
    await press('k', 500)
    return (await stats()).at
  }

  try {
    const data = process.env.NAQIE_DATA || ''
    if (!/naqie-t13\.4[\\/]?$/.test(data)) throw new Error('NAQIE_DATA must be a folder named naqie-t13.4 (the real history is never used)')
    check('engine ready with the models', await until(async () => engine.status.status === 'ready' && (await engine.call('/health')).models, 120000), engine.status.gpu?.name)
    await page(`window.dispatchEvent(new Event('focus'))`)   // the library loads its items
    await sleep(1500)

    if (!second) {
      rmSync(state, { force: true })
      writeFileSync(join(outDir, 'log.txt'), '')
      check('the folder starts empty: no group', (await group()).length === 0)
      ipcMain.removeHandler('choose-files')
      let pick = null
      ipcMain.handle('choose-files', () => [pick])

      note('--- a 5 min video, left at about 2:00')
      pick = VIDEO
      const vid = await cleanAndPlay(VIDEO)
      const vAt = await goTo(120)
      await leave()
      let g = await group()
      check('the video is in Continue watching', g.length === 1 && g[0].id === vid, JSON.stringify(g))
      check('... with the picture where it stopped', g[0]?.img, g[0]?.meta)
      await shot('group-video')
      let s = await openFromGroup(vid)
      check('a click opens it at the same moment', Math.abs(s.at - vAt) < 1, `left at ${vAt.toFixed(2)} s, opens at ${s.at.toFixed(2)} s`)
      await press('k', 400)
      await shot('player-resumed')
      await leave()

      note('--- a 5 min sound, left at about 1:00')
      pick = SOUND
      const snd = await cleanAndPlay(SOUND)
      const sAt = await goTo(60)
      await leave()
      g = await group()
      check('both are listed, the last one watched first', g.map((x) => x.id).join() === `${snd},${vid}`, JSON.stringify(g.map((x) => [x.id, x.meta])))
      check('... the sound shows its sign (no picture)', g[0]?.glyph && !g[0]?.img)
      await shot('group-two')
      s = await openFromGroup(snd)
      check('the sound opens at the same moment', Math.abs(s.at - sAt) < 1, `left at ${sAt.toFixed(2)} s, opens at ${s.at.toFixed(2)} s`)
      await press('k', 400)
      await leave()

      note('--- the video taken to 95%: finished')
      s = await openFromGroup(vid)
      await goTo(285)
      await leave()
      g = await group()
      check('a finished video leaves the group', !g.some((x) => x.id === vid), JSON.stringify(g.map((x) => x.id)))
      await page(`document.querySelector('#lib li[data-id="${vid}"] [data-act="play"]').click()`)
      await until(async () => (await stats()).firstPlaying !== null && (await stats()).id === vid, 30000)
      check('... and opens from the start', (await stats()).at < 3, `${(await stats()).at.toFixed(2)} s`)
      await leave()

      note('--- the sound playing on, then Naqi quits')
      s = await openFromGroup(snd)
      await page(`document.activeElement.blur()`)
      await press('l', 3000)   // +10 s, then 3 s of playing; under the 5 s between kept places
      const quitAt = (await stats()).at
      check('it plays when Naqi quits', !(await stats()).paused)
      writeFileSync(state, JSON.stringify({ snd, vid, quitAt }))
      note(`quitting at ${quitAt.toFixed(2)} s; Naqi starts again`)
      process.env.NAQI_RESUME_PART = '2'
      app.relaunch()
      return app.quit()
    }

    const { snd, vid, quitAt } = JSON.parse(readFileSync(state, 'utf8'))
    const g = await group()
    check('after the restart the sound is still listed (the video is not)', g.length === 1 && g[0].id === snd, JSON.stringify(g.map((x) => [x.id, x.meta])))
    const s = await openFromGroup(snd)
    check('... and opens where Naqi quit', s.at >= quitAt - 0.3 && s.at - quitAt < 1.5, `quit at ${quitAt.toFixed(2)} s, opens at ${s.at.toFixed(2)} s`)
    await shot('after-restart')
    await press('k', 400)
    await leave()
    check('the video is not listed', !(await group()).some((x) => x.id === vid))
  } catch (e) {
    check('test ran', false, e.stack || e.message)
  }
  note(fails ? `${fails} check(s) FAILED` : 'ALL PASSED (this part)')
  setTimeout(() => app.quit(), 500)
}
