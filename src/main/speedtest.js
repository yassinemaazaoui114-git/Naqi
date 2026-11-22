import { app } from 'electron'
import { execFile } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Dev check for T6.3 (run with NAQI_SELFTEST=speed): startup time, idle RAM, and with NAQI_LONG=<file> the GPU,
// VRAM and RAM while that long file is cleaned (a "sound" job, the one Clean and play runs).
// NAQI_LAUNCHED_AT (epoch ms, set by the command that starts the app) also counts the time before Electron starts.
// The result goes to test_out/t6.3/<NAQI_SPEED_NAME or "start">.json and a log next to it.
const outDir = join(app.getAppPath(), 'test_out', 't6.3')
const IDLE_MS = 60000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function runCmd(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000, windowsHide: true }, (err, stdout) => resolve(err ? '' : stdout.trim()))
  })
}

// Working set and private memory (MB) of the engine and every process it started (ffmpeg during a job)
async function engineMemory(pid) {
  const ps = `$all = Get-CimInstance Win32_Process; $ids = @(${pid}); $i = 0; while ($i -lt $ids.Count) { ` +
    `$ids += @($all | Where-Object ParentProcessId -eq $ids[$i] | ForEach-Object ProcessId); $i++ }; ` +
    `$p = Get-Process -Id $ids -ErrorAction SilentlyContinue; ` +
    `'{0} {1}' -f ($p | Measure-Object WorkingSet64 -Sum).Sum, ($p | Measure-Object PrivateMemorySize64 -Sum).Sum`
  const [ws, priv] = (await runCmd('powershell', ['-NoProfile', '-Command', ps])).split(' ').map(Number)
  return { ws_mb: Math.round(ws / 2 ** 20), private_mb: Math.round(priv / 2 ** 20) }
}

// Every Electron process (main, page, GPU, helpers), MB
function electronMemory() {
  const procs = app.getAppMetrics()
  const sum = (key) => Math.round(procs.reduce((a, p) => a + (p.memory[key] || 0), 0) / 1024)
  return { ws_mb: sum('workingSetSize'), private_mb: sum('privateBytes'), processes: procs.length }
}

async function gpuNow() {
  const out = await runCmd('nvidia-smi', ['--query-gpu=memory.used,utilization.gpu', '--format=csv,noheader,nounits'])
  const [mem, util] = out.split(',').map((v) => Number(v.trim()))
  return { vram_mb: mem, util }
}

export async function run(win, engine) {
  mkdirSync(outDir, { recursive: true })
  const name = process.env.NAQI_SPEED_NAME || 'start'
  const log = []
  const t0 = Date.now()
  const note = (text) => { log.push(`${((Date.now() - t0) / 1000).toFixed(2)} s  ${text}`); console.log('[speedtest]', text) }
  const page = (js) => win.webContents.executeJavaScript(js)
  const result = { name }
  try {
    // 1. Startup: from the launch (or the main process's own start) to the first paint, the engine and its models
    const mainStart = Date.now() - process.uptime() * 1000
    const launched = Number(process.env.NAQI_LAUNCHED_AT) || mainStart
    const [origin, paint] = await page(`[performance.timeOrigin,
      (performance.getEntriesByName('first-contentful-paint')[0] || {}).startTime || 0]`)
    const t = Date.now()
    while (!engine.modelsAt && Date.now() - t < 180000) await sleep(100)
    const s = (at) => at ? Number(((at - launched) / 1000).toFixed(2)) : null
    result.startup = { main_process_s: s(mainStart), page_painted_s: s(origin + paint), engine_ready_s: s(engine.readyAt),
      models_loaded_s: s(engine.modelsAt), counted_from: process.env.NAQI_LAUNCHED_AT ? 'launch command' : 'main process' }
    note(`startup ${JSON.stringify(result.startup)}`)

    // 2. Idle RAM: a minute after everything is loaded, nothing running
    await sleep(IDLE_MS)
    const el = electronMemory()
    const en = await engineMemory(engine.child.pid)
    result.idle = { electron: el, engine: en, total_ws_mb: el.ws_mb + en.ws_mb, total_private_mb: el.private_mb + en.private_mb,
      gpu: await gpuNow() }
    note(`idle ${JSON.stringify(result.idle)}`)

    // 3. A long file cleaned like Clean and play, sampled every second
    const long = process.env.NAQI_LONG
    if (long) {
      const tmp = join(app.getPath('temp'), 'naqie-t6.3')
      rmSync(tmp, { recursive: true, force: true })
      const wav = join(tmp, 'cleaned.wav')
      await page(`window.__gap = 0; (() => { let last = performance.now(); const f = (t) => { window.__gap = Math.max(window.__gap, t - last); last = t; requestAnimationFrame(f) }; requestAnimationFrame(f) })()`)
      const base = await gpuNow()
      const samples = []
      let done = false
      let plays = null
      const started = Date.now()
      engine.on('event', (event, v) => { if (event === 'job' && v.plays && plays === null) plays = (Date.now() - started) / 1000 })
      const job = page(`new Promise((resolve) => {
        window.naqi.onJob((j) => { if (j.state !== 'running') resolve(j) })
        window.naqi.startJob({ kind: 'sound', src: ${JSON.stringify(long)}, wav: ${JSON.stringify(wav)} })
          .catch((e) => resolve({ state: 'error', text: e.message }))
      })`).finally(() => { done = true })
      while (!done) {
        const [g, m] = await Promise.all([gpuNow(), samples.length % 5 ? null : engineMemory(engine.child.pid)])
        samples.push({ s: Math.round((Date.now() - started) / 1000), ...g, ...(m ? { engine_ws_mb: m.ws_mb } : {}) })
        await sleep(1000)
      }
      const end = await job
      const gap = await page('window.__gap')
      const busy = samples.filter((x) => x.util > 0)
      const n = end.numbers || {}
      result.long = { file: long, state: end.state, text: end.text, sound_s: n.duration_s, seconds: n.seconds,
        speed_x: n.speed_x, device: n.device, peak_vram_torch_mb: n.peak_vram_mb, plays_after_s: plays,
        vram_before_mb: base.vram_mb, vram_peak_mb: Math.max(...samples.map((x) => x.vram_mb)),
        gpu_util_avg: Math.round(busy.reduce((a, x) => a + x.util, 0) / (busy.length || 1)),
        engine_ws_peak_mb: Math.max(...samples.filter((x) => x.engine_ws_mb).map((x) => x.engine_ws_mb)),
        longest_frame_gap_ms: Math.round(gap), samples }
      note(`long ${JSON.stringify({ ...result.long, samples: samples.length })}`)
      rmSync(tmp, { recursive: true, force: true })
    }
    note('DONE')
  } catch (e) {
    result.error = e.message
    note(`FAIL: ${e.message}`)
  }
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify(result, null, 2))
  writeFileSync(join(outDir, `${name}.log`), log.join('\n') + '\n')
  app.quit()
}
