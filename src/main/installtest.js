import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Check of the installed app (T7.1, run with NAQI_SELFTEST=installed, NAQI_TEST_OUT=<folder for the log>,
// NAQI_SAMPLE=<a 30 s sound> and NAQIE_DATA=<a temporary data folder>): the packed engine starts on the GPU with
// its own ffmpeg, models and yt-dlp; a 30 s sound cleans from the page; a 19 s link is saved as MP4 (yt-dlp + deno
// + ffmpeg from the installed folder) and its history row appears in the library. Like old Naqi's installed self-test.
const LINK = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'   // "Me at the zoo", 19 s

function waitFor(engine, status, ms) {
  return new Promise((resolve, reject) => {
    if (engine.status.status === status) return resolve()
    const timer = setTimeout(() => reject(new Error(`no "${status}" within ${ms} ms (${engine.status.message || engine.status.status})`)), ms)
    const on = (s) => { if (s.status === status) { clearTimeout(timer); engine.off('status', on); resolve() } }
    engine.on('status', on)
  })
}

// Start a job from the page and wait for its end
const job = (win, spec) => win.webContents.executeJavaScript(`new Promise((resolve) => {
  window.naqi.onJob((j) => { if (j.state !== 'running') resolve(j) })
  window.naqi.startJob(${JSON.stringify(spec)}).catch((e) => resolve({ state: 'error', text: e.message }))
})`)

export async function run(win, engine) {
  const outDir = process.env.NAQI_TEST_OUT || join(app.getPath('temp'), 'naqi-installed-test')
  mkdirSync(outDir, { recursive: true })
  const log = []
  const t0 = Date.now()
  const note = (text) => { log.push(`${((Date.now() - t0) / 1000).toFixed(2)} s  ${text}`); console.log('[installtest]', text) }
  let pass = true
  const check = (name, ok, detail = '') => { if (!ok) pass = false; note(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ': ' + detail : ''}`) }
  try {
    note(`app ${app.getAppPath()}, packaged ${app.isPackaged}, engine ${engine.exe}`)
    await waitFor(engine, 'ready', 180000)
    const health = await engine.call('/health')
    check('engine ready', true, `gpu=${JSON.stringify(engine.status.gpu)}, yt-dlp ${health.ytdlp}`)
    check('engine on the GPU', /cuda|rtx|nvidia/i.test(JSON.stringify(engine.status.gpu)))
    check('engine is the packed one', app.isPackaged && !!engine.exe && existsSync(engine.exe))

    const sound = await job(win, { kind: 'sound', src: process.env.NAQI_SAMPLE, wav: join(outDir, 'cleaned.wav') })
    check('30 s sound cleaned', sound.state === 'done',
      `${sound.text}${sound.numbers ? `, ${sound.numbers.speed_x.toFixed(1)}x, peak VRAM ${(sound.numbers.peak_vram_mb / 1024).toFixed(2)} GB` : ''}`)

    const saved = join(outDir, 'saved')
    const started = Date.now()
    const link = await job(win, { kind: 'link', url: LINK, out: saved, fmt: 'mp4' })
    const day = join(saved, new Date().toLocaleDateString('sv-SE'))
    const mp4 = existsSync(day) ? readdirSync(day).filter((n) => n.endsWith('.mp4')) : []
    check('19 s link saved as MP4', link.state === 'done' && mp4.length === 1,
      `${link.text}, ${((Date.now() - started) / 1000).toFixed(1)} s, ${mp4[0] || 'no file'}` +
      (mp4[0] ? `, ${(statSync(join(day, mp4[0])).size / 1e6).toFixed(2)} MB` : ''))

    const items = await engine.call('/library')
    const rows = items.items
    check('history row in the library', Array.isArray(rows) && rows.some((r) => String(r.source).includes('jNQXAC9IVRw')),
      `${Array.isArray(rows) ? rows.length : '?'} rows`)
    writeFileSync(join(outDir, 'window.png'), (await win.webContents.capturePage()).toPNG())
    note(pass ? 'PASS' : 'FAIL')
  } catch (e) {
    note(`FAIL: ${e.message}`)
  }
  writeFileSync(join(outDir, 'log.txt'), log.join('\n') + '\n')
  app.quit()
}
