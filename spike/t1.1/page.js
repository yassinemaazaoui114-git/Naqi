// T1.1 player spike page (not product code). Plays the growing cleaned WAV with the method named by ?mode= and
// measures: start delay, sound/picture sync, waits, seeks, and records what was played for the sample check.
// Option A = "webaudio" (finished parts fetched and scheduled back to back with the Web Audio API)
// Option B = "element" (an <audio> element on the local server, which holds back bytes that are not clean yet)
// Option C = "mpv" (libmpv drawn into the window, like old Naqi)
const q = new URLSearchParams(location.search)
const mode = q.get('mode')
const SR = 44100
const url = (p) => `http://127.0.0.1:${q.get('port')}${p}${p.includes('?') ? '&' : '?'}t=${q.get('t')}`
const api = (p, body) => fetch(url(p), body === undefined ? {} : { method: 'POST', body }).then((r) => r.json())
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const video = document.getElementById('video')
const info = document.getElementById('info')
const t0 = performance.now()
const since = () => (performance.now() - t0) / 1000
const res = { mode, events: [], sync: [], stalls: [], seeks: [] }
const note = (text) => { res.events.push(`${since().toFixed(2)} ${text}`); console.log(text) }
let st = { ready_s: 0, plays: false, done: false }
let totalFrames = 0

async function poll() {
  for (;;) {
    st = await api('/status')
    await sleep(200)
  }
}

// ---------- recorder: what the page sends to the speakers, as int16, for the sample-exact check ----------
const ctx = new AudioContext({ sampleRate: SR, latencyHint: 'playback' })
let rec = null
const recParts = []
async function makeRecorder() {
  const code = `class Rec extends AudioWorkletProcessor {
    process(inputs, outputs) {
      const i = inputs[0], o = outputs[0]
      const l = i.length ? i[0] : new Float32Array(128), r = i.length > 1 ? i[1] : l
      o[0].set(l); o[1].set(r)
      this.port.postMessage([l.slice(), r.slice()])
      return true
    }
  }
  registerProcessor('rec', Rec)`
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })))
  rec = new AudioWorkletNode(ctx, 'rec', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] })
  rec.port.onmessage = (e) => {
    const [l, r] = e.data
    const out = new Int16Array(l.length * 2)
    for (let k = 0; k < l.length; k++) {
      out[2 * k] = Math.max(-32768, Math.min(32767, Math.round(l[k] * 32768)))
      out[2 * k + 1] = Math.max(-32768, Math.min(32767, Math.round(r[k] * 32768)))
    }
    recParts.push(out)
  }
  rec.connect(ctx.destination)
}

// ---------- option B: <audio> element ----------
function elementPlayer(hold) {
  const audio = new Audio()
  audio.crossOrigin = 'anonymous'
  audio.preload = 'auto'
  audio.src = url(`/wav?hold=${hold ? 1 : 0}`)
  ctx.createMediaElementSource(audio).connect(rec)
  let waitFrom = null
  audio.addEventListener('waiting', () => { waitFrom = since(); note(`audio waiting at ${audio.currentTime.toFixed(2)} (ready ${st.ready_s.toFixed(1)})`); video.pause() })
  audio.addEventListener('playing', () => {
    if (waitFrom !== null) res.stalls.push({ at: audio.currentTime, wait_s: since() - waitFrom })
    waitFrom = null
    note(`audio playing at ${audio.currentTime.toFixed(2)}`)
    video.play()
  })
  audio.addEventListener('error', () => note('audio error ' + (audio.error && audio.error.message)))
  return {
    audio,
    playing: () => !audio.paused && waitFrom === null && audio.readyState >= 3,
    async start(from) {
      audio.currentTime = from
      await audio.play()
    },
    pos: (perf) => audio.currentTime + (perf - performance.now()) / 1000,
    async seek(to) {
      const a = performance.now()
      audio.currentTime = to
      await new Promise((r) => audio.addEventListener('seeked', r, { once: true }))
      if (audio.readyState < 3) await new Promise((r) => audio.addEventListener('playing', r, { once: true }))
      return (performance.now() - a) / 1000
    },
    buffered: () => (audio.buffered.length ? audio.buffered.end(audio.buffered.length - 1) : 0),
    stop() { audio.pause() }
  }
}

// ---------- option A: Web Audio, finished parts scheduled back to back ----------
function webAudioPlayer() {
  const SLICE = 10 * SR   // frames per fetch
  const AHEAD = 30 * SR   // keep this much scheduled ahead of the playhead
  let base = 0            // file frame that plays at context time `origin`
  let origin = 0
  let next = 0            // next file frame to fetch
  let sources = []
  let gen = 0             // bumps on every seek, so old fetches are thrown away
  let waiting = false
  let waitFrom = 0
  const now = () => base + Math.round((ctx.currentTime - origin) * SR)   // frame being rendered now
  async function slice(a, b, g) {
    const r = await fetch(url('/wav?hold=1'), { headers: { Range: `bytes=${44 + a * 4}-${44 + b * 4 - 1}` } })
    const pcm = new Int16Array(await r.arrayBuffer())
    if (g !== gen) return
    const n = pcm.length / 2
    const buf = ctx.createBuffer(2, n, SR)
    const l = buf.getChannelData(0), rr = buf.getChannelData(1)
    for (let k = 0; k < n; k++) { l[k] = pcm[2 * k] / 32768; rr[k] = pcm[2 * k + 1] / 32768 }
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(rec)
    src.start(origin + (a - base) / SR)
    sources.push(src)
    src.onended = () => { sources = sources.filter((s) => s !== src) }
  }
  async function pump(g) {
    while (g === gen) {
      const ready = st.done ? totalFrames : Math.floor(st.ready_s * SR)
      // Out of clean sound: stop the clock until more is clean (R14c: playback waits and goes on by itself)
      if (!waiting && next >= ready && next < totalFrames && next - now() < 0.3 * SR) {
        waiting = true; waitFrom = since()
        await ctx.suspend(); video.pause()
        note(`webaudio waiting at ${(now() / SR).toFixed(2)} (ready ${st.ready_s.toFixed(1)})`)
      }
      if (waiting && (ready > next || st.done)) {
        waiting = false
        res.stalls.push({ at: now() / SR, wait_s: since() - waitFrom })
        await ctx.resume(); video.play()
        note(`webaudio playing at ${(now() / SR).toFixed(2)}`)
      }
      if (next < Math.min(ready, totalFrames) && next - now() < AHEAD) {
        const b = Math.min(next + SLICE, ready, totalFrames)
        const a = next
        next = b
        await slice(a, b, g)
      } else {
        await sleep(100)
      }
    }
  }
  return {
    playing: () => !waiting && ctx.state === 'running',
    async start(from) {
      gen++
      sources.forEach((s) => { s.onended = null; s.stop() })
      sources = []
      base = next = Math.round(from * SR)
      origin = ctx.currentTime + 0.1
      const g = gen
      const first = Math.min(next + SLICE, totalFrames)
      const a = next
      next = first
      await slice(a, first, g)
      pump(g)
      video.play()
      await sleep(Math.max(0, (origin - ctx.currentTime) * 1000))
    },
    // Where the sound heard at performance time `perf` is in the file (uses the real output timestamp).
    pos(perf) {
      const ts = ctx.getOutputTimestamp()
      const ct = ctx.state === 'running' ? ts.contextTime + (perf - ts.performanceTime) / 1000 : ctx.currentTime
      return base / SR + (ct - origin)
    },
    async seek(to) {
      const a = performance.now()
      await this.start(to)
      return (performance.now() - a) / 1000
    },
    stop() { gen++; sources.forEach((s) => s.stop()) }
  }
}

// ---------- picture follows the sound (both options) ----------
let player = null
let settleUntil = 0
let integ = 0
function onFrame(nowMs, meta) {
  if (player && player.playing() && !video.paused) {
    const a = player.pos(meta.expectedDisplayTime)
    const err = meta.mediaTime - a
    if (performance.now() > settleUntil && a > 0.5) res.sync.push([+a.toFixed(3), +err.toFixed(4)])
    if (Math.abs(err) > 0.25) {
      video.currentTime = a + 0.03
      settleUntil = performance.now() + 2000
      integ = 0
    } else {
      // proportional + integral: the integral part takes away a steady lag the proportional part leaves
      integ = Math.max(-0.5, Math.min(0.5, integ + err / 30))
      video.playbackRate = Math.max(0.9, Math.min(1.1, 1 - err * 1.5 - integ))
    }
  }
  video.requestVideoFrameCallback(onFrame)
}

function show() {
  const p = player && player.pos ? player.pos(performance.now()) : 0
  const last = res.sync.slice(-30).map((s) => Math.abs(s[1]))
  info.textContent = `mode ${mode}   t ${since().toFixed(1)} s\nready ${st.ready_s.toFixed(1)} s  plays ${st.plays}  done ${st.done}\n` +
    `sound at ${p.toFixed(2)} s   picture at ${video.currentTime.toFixed(2)} s   sync (last 30 frames) max ${last.length ? Math.max(...last).toFixed(3) : '-'} s`
}
setInterval(show, 250)

// Seeks are only allowed inside the clean part (R14b)
const allowed = (to) => Math.min(to, st.done ? totalFrames / SR : st.ready_s - 1)

async function until(test) { while (!test()) await sleep(100) }

function summary() {
  const errs = res.sync.map((s) => Math.abs(s[1])).sort((a, b) => a - b)
  const pct = (p) => (errs.length ? errs[Math.min(errs.length - 1, Math.floor(p * errs.length))] : null)
  res.sync_summary = { frames: errs.length, median: pct(0.5), p95: pct(0.95), p99: pct(0.99), max: errs[errs.length - 1],
    mean_signed: res.sync.reduce((s, x) => s + x[1], 0) / (res.sync.length || 1) }
}

async function finish() {
  summary()
  res.output_latency_s = ctx.outputLatency
  res.base_latency_s = ctx.baseLatency
  if (recParts.length) {
    const n = recParts.reduce((s, p) => s + p.length, 0)
    const all = new Int16Array(n)
    let o = 0
    for (const p of recParts) { all.set(p, o); o += p.length }
    note(`uploading ${(all.byteLength / 1e6).toFixed(1)} MB of played sound`)
    res.compare = await api(`/upload?name=${mode}`, all.buffer)
  }
  res.sync = res.sync.filter((_, i) => i % 10 === 0)   // keep the file small
  await api(`/result?name=${mode}`, JSON.stringify(res))
  note('saved')
  document.title = 'quit'
}

async function main() {
  requestIdleCallback(() => video.requestVideoFrameCallback(onFrame))
  video.src = url('/video')
  video.preload = 'auto'
  await makeRecorder()
  const started = await api('/start', '')
  totalFrames = (started.size - 44) / 4
  note(`cleaning started (${(totalFrames / SR).toFixed(1)} s of sound)`)
  poll()

  if (mode === 'plain' || mode === 'plain-hold') {
    // How far ahead the browser reads the file when nothing is clean yet: anything it reads past the clean part
    // is silence it would play later (that is why the server must hold those bytes back)
    player = elementPlayer(mode === 'plain-hold')
    player.audio.play().catch((e) => note('play: ' + e.message))
    res.buffer = []
    for (let k = 0; k < 16; k++) {
      await sleep(1000)
      res.buffer.push({ t: +since().toFixed(1), ready_s: st.ready_s, buffered_to_s: +player.buffered().toFixed(1), at: +player.audio.currentTime.toFixed(2) })
    }
    player.stop()
    res.sync = []
    recParts.length = 0
    return finish()
  }

  if (mode === 'mpv') {
    await until(() => st.plays)
    note('first chunk ready')
    const r = await api(`/mpv?wid=${q.get('hwnd')}&cmd=play`, '')
    res.start_delay_s = since()
    note(`mpv playing (load ${r.load_s} s)`)
    res.mpv = []
    for (let k = 0; k < 8; k++) {
      await sleep(1000)
      res.mpv.push(await api(`/mpv?wid=0&cmd=pos`, ''))
      if (k === 4) document.title = 'shot:mpv'
    }
    await api('/mpv?wid=0&cmd=stop', '')
    await sleep(1500)
    return finish()
  }

  player = mode.endsWith('webaudio') ? webAudioPlayer() : elementPlayer(true)
  await until(() => st.plays)
  note(`first chunk ready, plays (ready ${st.ready_s.toFixed(1)} s)`)
  await player.start(0)
  res.start_delay_s = since()
  note(`sound playing, start delay ${res.start_delay_s.toFixed(2)} s`)
  settleUntil = performance.now() + 2000

  if (mode.startsWith('early')) {
    // Jump close to the end of the clean part while the next chunk is still being cleaned: playback must wait at
    // the edge and go on by itself
    const to = allowed(st.ready_s - 8)
    res.seeks.push({ asked: to, took_s: await player.seek(to) })
    settleUntil = performance.now() + 2000
    res.clamp = { asked: 250, ready_s: st.ready_s, allowed: allowed(250) }
    await until(() => player.pos(performance.now()) > 160)
    player.stop()
    return finish()
  }

  res.clamp = { asked: 250, ready_s: st.ready_s, allowed: allowed(250) }
  setTimeout(() => document.title = 'shot:' + mode, 20000)
  await until(() => player.pos(performance.now()) > totalFrames / SR - 0.5)
  note('played to the end')
  summary()
  res.sync_straight = res.sync_summary
  for (const to of [100, 250]) {
    const took = await player.seek(to)
    settleUntil = performance.now() + 2000
    res.seeks.push({ to, took_s: took })
    note(`seek to ${to}: ${took.toFixed(3)} s`)
    await sleep(8000)
  }
  player.stop()
  await finish()
}

main().catch((e) => { note('ERROR ' + e.stack); finish() })
