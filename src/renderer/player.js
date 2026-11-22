// Player (ROADMAP T4.1, SPEC R8, R12; old SPEC R14b-d): plays a library item in the window. The sound is an <audio>
// on the engine's cleaned.wav; while it is still cleaned the engine holds back every byte that is not clean yet, so
// the <audio> just waits at the clean edge and goes on by itself. The picture is a muted <video> that follows the
// sound: an own video's file (or a copy the browser can play, first part then full), or a link's stream.
// Jumps go only inside the clean part (lit on the time bar).
import { icon } from './design/icons.js'
import * as pages from './pages.js'
import { seg } from './seg.js'

const $ = (sel, root = document) => root.querySelector(sel)

const MEDIA = 'naqi-media://engine'
const JUMP_MARGIN_S = 3      // a jump lands at least this far before the part not clean yet (old Naqi)
const NOTE_MS = 4000
const SYNC_JUMP_S = 0.25     // picture further off than this jumps; closer, its speed is nudged (±10%)...
const SYNC_FAR_S = 0.03      // ...or more firmly (±30%) while it is further off than this (the muted picture only)
const NO_PICTURE = "This video's picture can't be shown. The cleaned sound still plays."

const audio = new Audio()
audio.preload = 'auto'
const video = $('#picture')
const screen = $('#screen')
const timebar = $('#timebar')
const tip = $('#timebar-tip')
const playBtn = $('#player-play')
const volume = $('#volume')

const p = {
  id: null, item: null,
  live: false, ready: 0, length: 0,  // still cleaned: clean from the start up to `ready` seconds
  waiting: false,                    // the sound reached the clean edge and waits
  pic: null,                         // picture description from the engine
  using: null,                       // the picture now shown: 'part' | 'full' | 'stream' | null
  partS: 0,                          // length of a first-part copy
  converted: false,                  // a copy was asked for after the file did not play as it is
  note: '', noteTimer: 0,
  dragging: false
}

// Measured by the self-test: start, sync of every shown frame, waits at the clean edge
const stats = { firstPlaying: null, sync: [], waits: [], jumps: [] }
window.naqiPlayerStats = () => ({ ...stats, now: performance.now(), at: audio.currentTime, using: p.using,
  waiting: p.waiting, ready: p.ready, live: p.live, length: p.length })

const clock = (s) => {
  s = Math.max(0, Math.floor(s || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}
const cleanError = (e) => e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const length = () => p.length || (Number.isFinite(audio.duration) ? audio.duration : 0)
const cleanUpTo = () => (p.live ? p.ready : length())

// ---------- Opening and closing ----------
// Plays library item `id`; job: the running "Clean and play" job when it is this item. Throws the engine's
// words: "again" when its cleaned sound is gone and it must be cleaned first.
export async function open(id, job = null) {
  const item = await window.naqi.openPlayer(id)
  close({ keepPage: true })
  openSave(item.save, await window.naqi.getSettings())
  Object.assign(p, { id, item, live: item.live, ready: item.live ? job?.ready_s || 0 : 0,
    length: item.length || 0, waiting: false, pic: null, using: null, partS: 0, converted: false })
  Object.assign(stats, { firstPlaying: null, sync: [], waits: [], jumps: [] })
  $('#watch-title').textContent = item.title
  $('#watch-title').title = item.title
  screen.dataset.kind = item.kind
  showNote('')
  audio.src = `${MEDIA}/${id}/sound`
  audio.volume = Number(volume.value)
  showPage(true)
  // The cleaning may have ended while this item was being opened: its "done" event came before p.id was set
  if (item.live && finished.has(id)) { p.live = false; sv.info.ready = sv.info.can }
  setPicture(item.picture)
  drawSave()
  audio.play().catch(() => { /* a later play() or Pause wins; the button shows the real state */ })
  draw()
  return item
}

// Stops and unloads (the engine's held-back requests end with it). keepPage: another item opens right away.
export function close({ keepPage = false, instant = false } = {}) {
  if (p.id === null) { if (!keepPage) showPage(false, instant); return }
  p.id = null
  audio.pause()
  audio.removeAttribute('src')
  audio.load()
  dropPicture()
  if (!keepPage) showPage(false, instant)
}

export const openId = () => p.id

// Off: back to Home, only when the player is the page shown (closing it from another page leaves that page)
function showPage(on, instant = false) {
  if (!on && pages.shown() !== 'player') return
  const before = pages.shown()
  pages.show(on ? 'player' : 'home', { id: p.id }, { instant })
  if (on && before !== 'player') playBtn.focus({ preventScroll: true })
}
$('#watch-back').addEventListener('click', () => close())

// ---------- The picture ----------
function setPicture(desc) {
  p.pic = desc
  if (desc.type === 'file') return onPictureItem(desc.item)
  if (desc.type === 'stream') return onStream({ row_id: p.id, ...desc })
  soundOnly(desc.text && screen.dataset.kind === 'video' ? desc.text : '')
}

function soundOnly(text) {
  dropPicture()
  screen.dataset.kind = 'audio'
  if (text) showNote(text)
}

function dropPicture() {
  p.using = null
  video.pause()
  video.removeAttribute('src')
  video.load()
  screen.dataset.picture = 'none'
}

function showPicture(url, which) {
  const at = audio.currentTime
  p.using = which
  video.src = url
  video.addEventListener('loadedmetadata', () => {
    video.currentTime = Math.min(at + 0.05, video.duration || at)
    if (soundPlays()) video.play().catch(() => {})
  }, { once: true })
  video.addEventListener('loadeddata', () => { screen.dataset.picture = 'shown' }, { once: true })
}

// picture.py's copies (and an own file that plays as it is), from the open answer and its "picture" events
function onPictureItem(item) {
  if (p.pic?.type !== 'file' || p.pic.item.id !== item.id) return
  p.pic.item = item
  if (item.state === 'done' && item.full) {
    if (p.using !== 'full') showPicture(`${MEDIA}/pictures/${item.id}/full`, 'full')
  } else if (item.part && !p.using) {
    p.partS = item.part_s
    showPicture(`${MEDIA}/pictures/${item.id}/part`, 'part')
  } else if (item.state === 'error') {
    soundOnly(item.text || NO_PICTURE)
  } else if (item.state === 'running' && !p.using) {
    screen.dataset.picture = 'preparing'
    $('#screen-note').textContent = `Preparing the picture… ${Math.floor(item.frac * 100)}%`
  }
}
window.naqi.onPicture(onPictureItem)

// A link's stream: found by the engine while the sound was cleaned; some sites serve it only from `at` on
let streamTimer = 0
function onStream(s) {
  if (s.row_id !== p.id || p.pic?.type !== 'stream') return
  p.pic = { ...p.pic, ...s }
  clearTimeout(streamTimer)
  if (s.state === 'done') {
    const wait = Math.max(0, s.at * 1000 - Date.now())
    streamTimer = setTimeout(() => { if (p.id === s.row_id) showPicture(`${MEDIA}/stream/${s.row_id}?n=${Date.now()}`, 'stream') }, wait)
    if (!p.using) screen.dataset.picture = 'preparing'
  } else if (s.state === 'error') {
    soundOnly(s.text || NO_PICTURE)
  } else if (!p.using) {
    screen.dataset.picture = 'preparing'
    $('#screen-note').textContent = 'Finding the picture…'
  }
}
window.naqi.onStream(onStream)

// The browser could not show it: a stream is looked up once more; a file as it is gets a converted copy
video.addEventListener('error', async () => {
  if (p.id === null || !video.getAttribute('src')) return
  const id = p.id
  const asIs = p.pic?.type === 'file' && p.pic.item.how === 'as-is' && !p.converted
  if (p.pic?.type !== 'stream' && !asIs) return soundOnly(NO_PICTURE)
  dropPicture()
  try {
    p.converted = asIs
    const desc = await window.naqi.openPlayer(id, asIs ? 'convert' : 'stream')
    if (p.id === id) setPicture(desc)
  } catch { if (p.id === id) soundOnly(NO_PICTURE) }
})

// ---------- Picture follows the sound ----------
const soundPlays = () => !audio.paused && !p.waiting && audio.readyState >= 3
let settleUntil = 0
let integ = 0
function onFrame(_now, meta) {
  if (p.using && !video.paused && soundPlays()) {
    const a = audio.currentTime + (meta.expectedDisplayTime - performance.now()) / 1000
    const err = meta.mediaTime - a
    if (performance.now() > settleUntil) stats.sync.push([+a.toFixed(3), +err.toFixed(4)])
    if (Math.abs(err) > SYNC_JUMP_S) {
      video.currentTime = a + 0.03
      settleUntil = performance.now() + 2000
      integ = 0
    } else {
      // proportional + integral (the integral takes away a steady lag the proportional part leaves): T1.1 spike
      // A picture that just started (or jumped) is 50 to 80 ms behind: up to ±30% speed catches up within about
      // 0.3 s instead of a second; once close, ±10% keeps it there without visible speed changes
      integ = Math.max(-0.5, Math.min(0.5, integ + err / 30))
      const span = Math.abs(err) > SYNC_FAR_S ? 0.3 : 0.1
      video.playbackRate = Math.max(1 - span, Math.min(1 + span, 1 - err * (Math.abs(err) > SYNC_FAR_S ? 4 : 1.5) - integ))
    }
    if (p.using === 'part' && a > p.partS - 0.3) {   // past the first-part copy: wait for the full one
      video.pause()
      screen.dataset.picture = 'preparing'
      $('#screen-note').textContent = 'Preparing the rest of the picture…'
    }
  }
  video.requestVideoFrameCallback(onFrame)
}
video.requestVideoFrameCallback(onFrame)

function followSound() {
  if (!p.using || video.readyState < 1) return
  if (p.using === 'part' && audio.currentTime > p.partS - 0.3) return video.pause()
  if (screen.dataset.picture === 'preparing') screen.dataset.picture = 'shown'
  if (soundPlays()) { video.play().catch(() => {}) } else video.pause()
}

audio.addEventListener('playing', () => {
  if (stats.firstPlaying === null) stats.firstPlaying = performance.now()
  if (p.waiting) stats.waits.push({ at: audio.currentTime, s: (performance.now() - p.waitFrom) / 1000 })
  p.waiting = false
  settleUntil = performance.now() + 1000
  followSound()
  draw()
})
audio.addEventListener('waiting', () => {
  if (p.id === null) return
  p.waiting = true
  p.waitFrom = performance.now()
  video.pause()
  draw()
})
audio.addEventListener('pause', () => { video.pause(); draw() })
audio.addEventListener('ended', () => { video.pause(); draw() })
audio.addEventListener('seeked', () => {
  if (p.using && video.readyState >= 1) video.currentTime = audio.currentTime + 0.03
  settleUntil = performance.now() + 2000
  integ = 0
  followSound()
})
audio.addEventListener('error', () => {
  if (p.id === null || !audio.getAttribute('src')) return
  showNote('The cleaned sound could not be played. Try again from the library.', true)
})

// ---------- Controls ----------
function toggle() {
  if (p.id === null) return
  if (audio.ended) { audio.currentTime = 0; audio.play().catch(() => {}) } else if (audio.paused) audio.play().catch(() => {})
  else audio.pause()
}
playBtn.addEventListener('click', toggle)

// Report here (old SPEC R14d): the slip was just heard, so the sound pauses and the report opens at the playhead
// (main.js). The player stays loaded, so Back on the report comes back to this same moment.
$('#report-here').addEventListener('click', () => {
  if (p.id === null) return
  audio.pause()
  window.dispatchEvent(new CustomEvent('naqi-report-here', { detail: { id: p.id, at: audio.currentTime } }))
})

// Jumps go only inside the clean part (old SPEC R14b)
function jump(to) {
  if (p.id === null) return
  const len = length()
  let at = Math.max(0, Math.min(to, len || to))
  if (p.live && at > p.ready - JUMP_MARGIN_S) {
    at = Math.max(0, p.ready - JUMP_MARGIN_S)
    showNote('Only the lit part is clean so far.')
  }
  stats.jumps.push({ asked: to, to: at, t: performance.now() })
  audio.currentTime = at
  draw()
}

const fracAt = (e) => {
  const r = timebar.getBoundingClientRect()
  return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
}
timebar.addEventListener('pointermove', (e) => {
  const len = length()
  if (!len) return
  const f = fracAt(e)
  const blocked = p.live && f * len > p.ready
  tip.style.left = `${f * 100}%`
  tip.dataset.blocked = blocked
  tip.textContent = blocked ? `${clock(f * len)} · not clean yet` : clock(f * len)
  if (p.dragging) drawTime(Math.min(f * len, cleanUpTo()))
})
timebar.addEventListener('pointerdown', (e) => {
  if (!length()) return
  timebar.setPointerCapture(e.pointerId)
  timebar.classList.add('is-dragging')
  p.dragging = true
  drawTime(Math.min(fracAt(e) * length(), cleanUpTo()))
})
timebar.addEventListener('pointerup', (e) => {   // the jump comes on release (old Naqi)
  if (!p.dragging) return
  p.dragging = false
  timebar.classList.remove('is-dragging')
  jump(fracAt(e) * length())
})
timebar.addEventListener('keydown', (e) => {
  const step = e.key === 'ArrowRight' ? 5 : e.key === 'ArrowLeft' ? -5 : 0
  if (!step) return
  e.preventDefault()
  jump(audio.currentTime + step)
})

// Volume and mute, remembered
function showVolume() {
  volume.style.setProperty('--v', audio.muted ? 0 : volume.value)
  const muted = audio.muted || Number(volume.value) === 0
  $('#mute').innerHTML = icon(muted ? 'mute' : 'volume', 'icon-sm')
  $('#mute').setAttribute('aria-label', audio.muted ? 'Unmute (M)' : 'Mute (M)')
  $('#mute').dataset.tip = audio.muted ? 'Unmute (M)' : 'Mute (M)'
}
volume.addEventListener('input', () => {
  audio.volume = Number(volume.value)
  if (audio.muted && audio.volume) audio.muted = false
  showVolume()
})
volume.addEventListener('change', () => window.naqi.setSettings({ volume: volume.value }))
function toggleMute() { audio.muted = !audio.muted; showVolume() }
$('#mute').addEventListener('click', toggleMute)
export function setVolume(value) {
  if (value !== undefined && value !== null && value !== '') volume.value = value
  audio.volume = Number(volume.value)
  showVolume()
}

// Space: play / pause, M: mute (old Naqi), Escape: back, while the player is open and no other control takes the key
document.addEventListener('keydown', (e) => {
  if (p.id === null || $('#watch').hidden || e.ctrlKey || e.altKey || e.metaKey || e.defaultPrevented) return
  const el = document.activeElement
  const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
  if (e.key === ' ' && !typing && !(el && el.tagName === 'BUTTON')) { e.preventDefault(); toggle() }
  else if ((e.key === 'm' || e.key === 'M') && !typing) toggleMute()
  // Escape: the Save row closes first, then the player goes back to Home (at once: it came from a key)
  else if (e.key === 'Escape' && saveToggle.getAttribute('aria-expanded') === 'true') { setSaveOpen(false); saveToggle.focus() }
  else if (e.key === 'Escape') close({ instant: true })
})

// ---------- The item still being cleaned ----------
const finished = new Set()   // items whose "Clean and play" ended (done, cancelled or failed)
window.naqi.onJob((j) => {
  if (j.kind === 'play' && j.row_id && j.state !== 'running') finished.add(j.row_id)
  else if (j.kind === 'play' && j.row_id) finished.delete(j.row_id)   // cleaned again
  if (j.kind !== 'play' || j.row_id !== p.id || p.id === null) return
  if (j.total_s) p.length = j.total_s
  if (j.state === 'running') { p.ready = Math.max(p.ready, j.ready_s || 0); return draw() }
  if (j.state === 'done') { p.live = false; if (sv.info) sv.info.ready = sv.info.can; drawSave(); return draw() }
  // Cancelled or failed: its cleaned sound is gone with it (Home tells why)
  close()
})

// ---------- Save (ROADMAP T4.3, old SPEC R14e) ----------
// Optional and last: the item's cleaned sound becomes an MP3 or MP4 in the Save to day folder, nothing is cleaned
// again; ready once all of it is clean. One Save at a time (any item); it goes on when the player is left.
const saveToggle = $('#save-toggle')
const saveGo = $('#save-go')
const saveBar = $('#save-bar')
const sv = { info: null, running: null }   // info: this item's save state from the engine; running: the Save now
const saveFmt = seg($('#save-fmt'), (v) => { window.naqi.setSettings({ save_format: v }); drawSave() })
const saveSize = seg($('#save-size'), (v) => window.naqi.setSettings({ files_size: v }))
const saveKbps = seg($('#save-kbps'), (v) => window.naqi.setSettings({ mp3_quality: v }))
const baseName = (path) => path.split(/[\\/]/).pop()

function openSave(info, settings) {
  sv.info = info
  if (info.running) sv.running = info.running
  $('#save-fmt').hidden = !info.video   // MP4 only for a link or an own video; a sound is saved as MP3
  saveFmt.set(null, info.video ? settings.save_format || 'mp4' : 'mp3')
  saveSize.set(null, settings.files_size || 'Original')
  saveKbps.set(null, settings.mp3_quality || '192 kbps')
  const mine = sv.running?.row_id === p.id && sv.running?.state === 'running'
  setSaveOpen(mine)
  setSaveStatus(mine ? sv.running.text : sv.running?.state === 'running' ? 'Another file is being saved…' : '')
  drawSave()
}

function setSaveOpen(open) {
  saveToggle.setAttribute('aria-expanded', open)
  $('#save-panel').dataset.open = open
}
saveToggle.addEventListener('click', () => {
  const open = saveToggle.getAttribute('aria-expanded') !== 'true'
  setSaveOpen(open)
  if (open) saveGo.focus({ preventScroll: true })
})

function setSaveStatus(text, state = '') {
  const el = $('#save-status')
  if (el.textContent !== text) el.textContent = text
  el.dataset.state = state
  el.title = text
}

function drawSave() {
  const info = sv.info
  if (!info || p.id === null) return
  const busy = sv.running?.state === 'running'
  const mine = busy && sv.running.row_id === p.id
  const ready = info.ready && !p.live
  saveToggle.hidden = !info.can
  saveToggle.disabled = !ready && !mine
  saveToggle.dataset.tip = ready || mine ? 'Save it as an MP3 or MP4 file' : p.live ? 'Save is ready when all of it is clean' : info.why
  if (!ready && !mine) setSaveOpen(false)
  const saved = info.saved.at(-1)
  $('#save-show').hidden = !saved
  const mp4 = saveFmt.value() === 'mp4'
  $('#save-size').hidden = !mp4
  $('#save-kbps').hidden = mp4
  saveGo.textContent = mine ? 'Cancel' : 'Save'
  saveGo.classList.toggle('is-cancel', mine)
  saveGo.disabled = !mine && (busy || !ready)
  for (const s of [saveFmt, saveSize, saveKbps]) s.disable(busy)
  saveBar.hidden = !mine
  saveBar.dataset.busy = mine
  if (mine) saveBar.style.setProperty('--p', sv.running.frac)
}

saveGo.addEventListener('click', async () => {
  if (p.id === null) return
  if (sv.running?.state === 'running' && sv.running.row_id === p.id) {
    saveGo.disabled = true
    return window.naqi.cancelSave(sv.running.id).catch(() => {})
  }
  const id = p.id
  const fmt = saveFmt.value()
  try {
    const started = await window.naqi.startSave(id, { fmt, size: saveSize.value(), kbps: parseInt(saveKbps.value(), 10) })
    if (!sv.running || sv.running.id <= started.id) sv.running = started
    if (p.id === id) { setSaveStatus(started.text); drawSave() }
  } catch (e) {
    if (p.id === id) setSaveStatus(cleanError(e), 'error')
  }
})

$('#save-show').addEventListener('click', () => {
  const path = sv.info?.saved.at(-1)
  if (path) window.naqi.showInFolder(path)
})

window.naqi.onSave((s) => {
  if (sv.running && s.id < sv.running.id) return   // an older Save's late event
  sv.running = s
  if (p.id === null) return
  if (s.row_id !== p.id) {   // another item's Save: this one can be saved again once it ends
    setSaveStatus(s.state === 'running' ? 'Another file is being saved…' : '')
    return drawSave()
  }
  if (s.state === 'done' && s.path) {
    sv.info.saved = [...sv.info.saved, s.path]
    window.dispatchEvent(new CustomEvent('naqi-saved', { detail: { id: s.row_id, path: s.path } }))
    setSaveStatus(`Saved: ${baseName(s.path)}`, 'done')
  } else {
    setSaveStatus(s.text, s.state === 'error' ? 'error' : '')
  }
  drawSave()
})

// ---------- Drawing ----------
function showNote(text, error = false) {
  clearTimeout(p.noteTimer)
  p.note = text
  $('#watch-note').textContent = text
  $('#watch-note').dataset.state = error ? 'error' : ''
  $('#watch-note').hidden = !text
  if (text && !error && text !== NO_PICTURE && !text.startsWith('Sound only') && !text.includes('no picture')) {
    p.noteTimer = setTimeout(() => showNote(''), NOTE_MS)
  }
}

function metaText() {
  const it = p.item
  const parts = [it.from]
  if (p.live && p.waiting) parts.push('Waiting for the cleaning…')
  else if (p.live) parts.push(`Cleaning… ${length() ? Math.min(100, Math.floor(p.ready * 100 / length())) : 0}% clean`)
  return parts.join(' · ')
}

function drawTime(at) {
  const len = length()
  timebar.style.setProperty('--played', len ? Math.min(1, at / len) : 0)
  $('#t-now').textContent = clock(at)
  timebar.setAttribute('aria-valuenow', Math.round(at))
  timebar.setAttribute('aria-valuetext', `${clock(at)} of ${clock(len)}`)
}

function draw() {
  if (p.id === null) return
  const len = length()
  const clean = p.live ? (len ? Math.min(1, p.ready / len) : 0) : 1
  timebar.style.setProperty('--cleaned', clean)
  timebar.dataset.cleaning = p.live
  timebar.setAttribute('aria-valuemax', Math.round(len))
  if (!p.dragging) drawTime(audio.currentTime)
  $('#t-len').textContent = clock(len)
  const tag = $('#clean-tag')
  tag.hidden = !p.live
  tag.textContent = `Clean up to ${clock(p.ready)}`
  const playing = !audio.paused && !audio.ended
  if (playBtn.getAttribute('aria-pressed') !== String(playing)) {
    playBtn.setAttribute('aria-pressed', playing)
    playBtn.setAttribute('aria-label', playing ? 'Pause (Space)' : 'Play (Space)')
  }
  screen.dataset.waiting = p.live && p.waiting
  $('#watch-meta').textContent = metaText()
}

// The time moves smoothly while the player is open
function frame() {
  if (p.id !== null && !$('#watch').hidden) draw()
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
