import { app } from 'electron'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Dev check for T0.2 and T0.5 (run with NAQI_SELFTEST=1): engine ready -> kill it -> it restarts -> ready ->
// a 30 s cleaning job started from the page -> quit.
// Screenshots and a log go to test_out/t0.2/.
const outDir = join(app.getAppPath(), 'test_out', 't0.2')

function waitFor(engine, status, ms) {
  return new Promise((resolve, reject) => {
    if (engine.status.status === status) return resolve()
    const timer = setTimeout(() => reject(new Error(`no "${status}" within ${ms} ms`)), ms)
    const on = (s) => { if (s.status === status) { clearTimeout(timer); engine.off('status', on); resolve() } }
    engine.on('status', on)
  })
}

async function shot(win, name) {
  await new Promise((r) => setTimeout(r, 300))   // let the page repaint
  writeFileSync(join(outDir, name), (await win.webContents.capturePage()).toPNG())
}

export async function run(win, engine) {
  mkdirSync(outDir, { recursive: true })
  const log = []
  const t0 = Date.now()
  const note = (text) => { log.push(`${((Date.now() - t0) / 1000).toFixed(2)} s  ${text}`); console.log('[selftest]', text) }
  try {
    await waitFor(engine, 'ready', 60000)
    note(`ready, gpu=${JSON.stringify(engine.status.gpu)}`)
    await shot(win, '1-ready.png')
    const bad = await fetch(`http://127.0.0.1:${engine.port}/health`)
    note(`request without token -> HTTP ${bad.status}`)
    const pid = engine.child.pid
    execFileSync('taskkill', ['/PID', String(pid), '/F'])
    note(`killed engine pid ${pid}`)
    await waitFor(engine, 'restarting', 5000)
    note(`message: ${engine.status.message}`)
    await shot(win, '2-stopped.png')
    await waitFor(engine, 'ready', 60000)
    note(`ready again, new pid ${engine.child.pid}`)
    await shot(win, '3-ready-again.png')
    // T0.5: a cleaning job started from the page, its events back in the page
    const sample = join(app.getAppPath(), 'samples', 'narration_30s.mp3')
    const wav = join(outDir, 'cleaned.wav')
    const job = await win.webContents.executeJavaScript(`new Promise((resolve) => {
      const seen = []
      window.naqi.onJob((j) => { seen.push(j.state); if (j.state !== 'running') resolve({ ...j, seen: seen.length }) })
      window.naqi.startJob({ kind: 'sound', src: ${JSON.stringify(sample)}, wav: ${JSON.stringify(wav)} })
        .catch((e) => resolve({ state: 'error', text: e.message }))
    })`)
    note(`job from the page: ${job.state} after ${job.seen} events, ${job.text}, ` +
      `${job.numbers ? job.numbers.speed_x.toFixed(1) + 'x' : ''}`)
    if (job.state !== 'done') throw new Error('the job did not finish')
    note('PASS')
  } catch (e) {
    note(`FAIL: ${e.message}`)
  }
  writeFileSync(join(outDir, 'log.txt'), log.join('\n') + '\n')
  app.quit()
}
