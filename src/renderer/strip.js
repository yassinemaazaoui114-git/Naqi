// The report page's sound strip (ROADMAP T5.2, SPEC R19): the picked file's cleaned sound (its cache or saved file,
// served by the engine as for the player), so the slip can be found by ear. Its shape comes from the engine's peaks
// (muted parts are flat gaps) and is drawn as a mask, so the colours follow the theme by themselves. "From here" /
// "To here" give the playhead's time to report.js; the moment from the two times is lit on the bar and plays again
// with one click (it stops at To). Arrow keys step 1 s. A file Naqi has no cleaned sound of says so.
const $ = (sel, root = document) => root.querySelector(sel)

const MEDIA = 'naqi-media://engine'
const STEP_S = 1
const BAR_PX = 4   // one bar (and its gap) per 4 px of the strip

const audio = new Audio()
audio.preload = 'auto'
const strip = $('#strip')
const bar = $('#strip-bar')
const shape = $('#strip-shape')
const tip = $('#strip-tip')
const playBtn = $('#strip-play')
const tools = ['#strip-play', '#from-here', '#to-here'].map((sel) => $(sel))
const momentBtn = $('#play-moment')

const s = {
  want: null,              // the library item asked for (also while it loads or has no sound)
  id: null, length: 0, peaks: [], bars: 0,
  ask: 0,                  // the newest load(); an older answer is dropped
  moment: null,            // [from, to] seconds, when both times make sense
  stopAt: null,            // "Play the moment" stops here
  dragging: false
}
let fill = () => {}

const cleanError = (e) => e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const length = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : s.length)

// 83.46 -> '1:23.5' (to 0.1 s: slips are counted from 0.5 s), 83 -> '1:23'; report.js reads both
export function stamp(t) {
  const tenths = Math.round(Math.max(0, t) * 10)
  const sec = Math.floor(tenths / 10)
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const ss = String(sec % 60).padStart(2, '0') + (tenths % 10 ? `.${tenths % 10}` : '')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}
const clock = (t) => stamp(Math.floor(t))

// report.js: fn('from' | 'to', text) when a time is taken from the playhead
export const onFill = (fn) => { fill = fn }

// ---------- Loading a file ----------
// id: the picked library item; null with `why` when there is none (nothing picked, or a file Naqi did not clean)
export async function load(id, why = '') {
  if (id !== null && id === s.want && strip.dataset.state !== 'none') return   // picked again: it keeps playing
  const ask = ++s.ask
  stop()
  Object.assign(s, { want: id, id: null, length: 0, peaks: [], bars: 0 })
  if (id === null) return show('idle', why)
  show('loading', 'Reading the cleaned sound…')
  try {
    const w = await window.naqi.slipWave(id)
    if (ask !== s.ask) return
    Object.assign(s, { id, length: w.length, peaks: w.peaks })
    audio.src = `${MEDIA}/${id}/sound`
    drawShape()
    show('ready', '')
  } catch (e) {
    if (ask === s.ask) show('none', cleanError(e))
  }
}

function stop() {
  s.stopAt = null
  audio.pause()
  audio.removeAttribute('src')
  audio.load()
}

function show(state, note) {
  strip.dataset.state = state
  $('#strip-note').textContent = note
  const ready = state === 'ready'
  for (const b of tools) b.disabled = !ready
  bar.tabIndex = ready ? 0 : -1
  drawMoment()
  draw()
}

// An item that was still being cleaned: its strip comes once it is clean
window.naqi.onJob((j) => {
  if (j.kind === 'play' && j.row_id === s.want && j.state === 'done' && strip.dataset.state === 'none') load(s.want)
})
// Leaving the page stops the sound
window.addEventListener('naqi-page', (e) => { if (e.detail.page !== 'report') audio.pause() })

// ---------- The shape: one bar per slice, the loudest sample in it; silence stays a flat line ----------
function drawShape() {
  const n = Math.max(40, Math.floor(bar.clientWidth / BAR_PX))
  if (!s.peaks.length || n === s.bars) return
  s.bars = n
  const per = s.peaks.length / n
  let d = ''
  for (let i = 0; i < n; i++) {
    let v = 0
    for (let k = Math.floor(i * per); k < Math.max(Math.floor(i * per) + 1, Math.floor((i + 1) * per)); k++) v = Math.max(v, s.peaks[k] || 0)
    const h = Math.max(6, Math.min(100, Math.pow(v, 0.6) * 100))   // a gentle curve, so quiet talking still shows
    d += `M${i + 0.18} ${((100 - h) / 2).toFixed(1)}h0.64v${h.toFixed(1)}h-0.64z`
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} 100" preserveAspectRatio="none"><path d="${d}"/></svg>`
  shape.style.maskImage = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}
new ResizeObserver(() => requestAnimationFrame(drawShape)).observe(bar)

// ---------- The moment: report.js gives the two times as they are typed or filled ----------
export function moment(a, b) {
  s.moment = Number.isFinite(a) && Number.isFinite(b) && b > a ? [a, b] : null
  drawMoment()
}

function drawMoment() {
  const len = length()
  const on = Boolean(s.moment && len && strip.dataset.state === 'ready')
  const [a, b] = on ? s.moment.map((t) => Math.min(1, Math.max(0, t / len))) : [0, 0]
  bar.style.setProperty('--a', a)
  bar.style.setProperty('--b', b)
  strip.dataset.moment = on && b > a
  momentBtn.disabled = !(on && b > a)
}

function playMoment() {
  if (!s.moment) return
  audio.currentTime = s.moment[0]
  s.stopAt = s.moment[1]
  audio.play().catch(() => {})
}
momentBtn.addEventListener('click', playMoment)

// ---------- Playing, jumping, taking the time ----------
function toggle() {
  if (s.id === null) return
  if (audio.paused || audio.ended) {
    if (audio.ended) audio.currentTime = 0
    audio.play().catch(() => {})
  } else audio.pause()
}
playBtn.addEventListener('click', toggle)
audio.addEventListener('pause', () => { s.stopAt = null; draw() })
audio.addEventListener('play', draw)
audio.addEventListener('loadedmetadata', () => { drawMoment(); draw() })
audio.addEventListener('error', () => {
  if (s.id === null || !audio.getAttribute('src')) return
  show('none', 'The cleaned sound could not be played. Type the times below.')
})

function jump(to) {
  if (s.id === null) return
  s.stopAt = null
  audio.currentTime = Math.max(0, Math.min(to, length()))
  draw()
}

$('#from-here').addEventListener('click', () => fill('from', stamp(audio.currentTime)))
$('#to-here').addEventListener('click', () => fill('to', stamp(audio.currentTime)))

const timeAt = (e) => {
  const r = bar.getBoundingClientRect()
  return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * length()
}
bar.addEventListener('pointermove', (e) => {
  if (s.id === null) return
  const t = timeAt(e)
  tip.style.left = `${(t / length()) * 100}%`
  tip.textContent = stamp(t)
  if (s.dragging) drawTime(t)
})
bar.addEventListener('pointerdown', (e) => {
  if (s.id === null || e.button !== 0) return
  bar.setPointerCapture(e.pointerId)
  bar.classList.add('is-dragging')
  s.dragging = true
  drawTime(timeAt(e))
})
bar.addEventListener('pointerup', (e) => {
  if (!s.dragging) return
  s.dragging = false
  bar.classList.remove('is-dragging')
  jump(timeAt(e))
})

// Space plays / pauses and the arrows step 1 s, on the strip, or anywhere on the page where nothing else takes them
function key(e) {
  if (s.id === null || e.ctrlKey || e.altKey || e.metaKey) return false
  if (e.key === ' ') toggle()
  else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') jump(audio.currentTime + (e.key === 'ArrowRight' ? STEP_S : -STEP_S))
  else if (e.key === 'Home') jump(0)
  else if (e.key === 'End') jump(length())
  else return false
  e.preventDefault()
  return true
}
bar.addEventListener('keydown', (e) => { if (key(e)) e.stopPropagation() })
document.addEventListener('keydown', (e) => {
  if ($('#report').hidden || e.key === 'Home' || e.key === 'End') return
  const el = document.activeElement
  if (el && el !== document.body && !strip.contains(el)) return   // a field, a button, the choices: theirs
  if (el && el.tagName === 'BUTTON' && e.key === ' ') return      // a strip button: Space presses it
  key(e)
})

// ---------- Drawing ----------
function drawTime(at) {
  const len = length()
  bar.style.setProperty('--played', len ? Math.min(1, at / len) : 0)
  $('#strip-now').textContent = s.id === null ? '0:00' : stamp(at)
  bar.setAttribute('aria-valuenow', at.toFixed(1))
  bar.setAttribute('aria-valuetext', `${stamp(at)} of ${clock(len)}`)
}

function draw() {
  const len = s.id === null ? 0 : length()
  bar.setAttribute('aria-valuemax', len.toFixed(1))
  $('#strip-len').textContent = clock(len)
  if (!s.dragging) drawTime(s.id === null ? 0 : audio.currentTime)
  const playing = !audio.paused && !audio.ended
  if (playBtn.getAttribute('aria-pressed') !== String(playing)) {
    playBtn.setAttribute('aria-pressed', playing)
    playBtn.setAttribute('aria-label', playing ? 'Pause (Space)' : 'Play the cleaned sound (Space)')
  }
}

// The playhead moves smoothly; "Play the moment" stops at To
function frame() {
  if (s.id !== null && !audio.paused) {
    if (s.stopAt !== null && audio.currentTime >= s.stopAt) {
      const at = s.stopAt
      audio.pause()
      audio.currentTime = at
    }
    draw()
  }
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)

// Measured by the self-test
window.naqiStrip = () => ({ state: strip.dataset.state, id: s.id, at: audio.currentTime, paused: audio.paused,
  length: length(), peaks: s.peaks, bars: s.bars, moment: s.moment, lit: strip.dataset.moment === 'true',
  a: Number(bar.style.getPropertyValue('--a')), b: Number(bar.style.getPropertyValue('--b')),
  note: $('#strip-note').textContent, ready: audio.readyState })
