// Player (ROADMAP T4.1, SPEC R8, R12; old SPEC R14b-d): plays a library item in the window. The sound is an <audio>
// on the engine's cleaned.wav; while it is still cleaned the engine holds back every byte that is not clean yet, so
// the <audio> just waits at the clean edge and goes on by itself. The picture is a muted <video> that follows the
// sound: an own video's file (or a copy the browser can play, first part then full), or a link's stream.
// Jumps go only inside the clean part (lit on the time bar).
import { icon } from './design/icons.js'
import { detailsButton } from './details.js'
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
const peek = $('#screen-peek')
const tip = $('#timebar-tip')
const lines = $('#timebar-lines')
const span = $('#timebar-span')
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
  dragging: false,
  mutes: { parts: [], upto: 0 },     // where Naqi muted the sound (T10.2b), seconds; read up to `upto`
  muteAsk: 0, muteBusy: false, muteAgain: false
}

// Measured by the self-test: start, sync of every shown frame, waits at the clean edge
const stats = { firstPlaying: null, sync: [], waits: [], jumps: [] }
window.naqiPlayerStats = () => ({ ...stats, now: performance.now(), at: audio.currentTime, using: p.using,
  waiting: p.waiting, ready: p.ready, live: p.live, length: p.length, mutes: p.mutes, id: p.id,
  corner: !document.querySelector('#corner').hidden, paused: audio.paused, rate: audio.playbackRate, pitch: audio.preservesPitch })

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
  // Already playing in the corner: back to it at the same moment
  if (id === p.id && inCorner()) { showPage(true); return p.item }
  const item = await window.naqi.openPlayer(id)
  close({ keepPage: true })
  openSave(item.save, await window.naqi.getSettings())
  Object.assign(p, { id, item, live: item.live, ready: item.live ? job?.ready_s || 0 : 0,
    length: item.length || 0, waiting: false, pic: null, using: null, partS: 0, converted: false })
  Object.assign(stats, { firstPlaying: null, sync: [], waits: [], jumps: [] })
  $('#watch-title').textContent = item.title
  $('#watch-title').title = item.title
  screen.dataset.kind = item.kind
  screen.removeAttribute('data-bar-instant')
  screen.dataset.bar = 'shown'
  wokeAt = performance.now()
  showNote('')
  audio.src = `${MEDIA}/${id}/sound`
  audio.volume = Number(volume.value)
  showPage(true)
  // The cleaning may have ended while this item was being opened: its "done" event came before p.id was set
  if (item.live && finished.has(id)) { p.live = false; sv.info.ready = sv.info.can }
  setPicture(item.picture)
  p.mutes = { parts: [], upto: 0 }
  drawMutes()
  loadMutes()
  drawSave()
  audio.play().catch(() => { /* a later play() or Pause wins; the button shows the real state */ })
  draw()
  return item
}

// Stops and unloads (the engine's held-back requests end with it). keepPage: another item opens right away.
export function close({ keepPage = false, instant = false } = {}) {
  if (p.id === null) { if (!keepPage) showPage(false, instant); return }
  p.id = null
  setCorner(false)
  p.mutes = { parts: [], upto: 0 }
  drawMutes()
  setKeys(false, { instant: true })
  setGear(false, { instant: true })
  audio.pause()
  audio.removeAttribute('src')
  audio.load()
  dropPicture()
  if (!keepPage) showPage(false, instant)
}

export const openId = () => p.id
export const inCorner = () => !corner.hidden
// The report page's moment is about what was just heard (Bad rating): the item waits, paused, in the corner
export function pause() { audio.pause() }

// Off: back to Home, only when the player is the page shown (closing it from another page leaves that page)
function showPage(on, instant = false) {
  if (!on && pages.shown() !== 'player') return
  const before = pages.shown()
  pages.show(on ? 'player' : 'home', { id: p.id }, { instant })
  if (on && before !== 'player') playBtn.focus({ preventScroll: true })
}
// Back (and Escape), or the miniplayer button (I), leaves the item playing in the corner
$('#watch-back').addEventListener('click', () => showPage(false))
$('#mini-toggle').addEventListener('click', () => showPage(false))

// ---------- Keep playing in a corner (ROADMAP T10.2c) ----------
// Whenever another page shows while an item is open, the corner holds it: the same <audio> goes on, the <video> moves
// into the corner (moved in one step, so the browser does not pause it) and the same sync keeps it with the sound.
// A click on the picture (or a sound's title) returns to the full player at the same moment; Stop closes it.
const corner = $('#corner')
const cornerPic = $('#corner-pic')
const cornerPlay = $('#corner-play')
function setCorner(on, instant = false) {
  if (on === inCorner()) return
  corner.getAnimations().forEach((a) => a.cancel())
  corner.classList.remove('is-entering', 'is-leaving')
  if (on) {
    cornerPic.append(video)
    $('#corner-title').textContent = p.item.title
    corner.title = p.item.title
    corner.hidden = false
    if (!instant) { void corner.offsetWidth; corner.classList.add('is-entering') }
  } else {
    screen.prepend(video)
    corner.hidden = true
  }
  settleUntil = performance.now() + 1000   // the move itself may cost a frame: not counted as sync
  drawCorner()
}
window.addEventListener('naqi-page', (e) => {
  if (e.detail.page !== 'player') setKeys(false, { instant: true })
  setGear(false, { instant: true })   // it belongs to where it was opened (the screen or the corner)
  setCorner(e.detail.page !== 'player' && p.id !== null, e.detail.instant)
})
$('#corner-open').addEventListener('click', () => showPage(true))
$('#corner-title').addEventListener('click', () => { if (screen.dataset.kind === 'audio') showPage(true) })
cornerPlay.addEventListener('click', toggle)
$('#corner-close').addEventListener('click', () => {
  // A short fade, then gone (the sound stops at once)
  audio.pause()
  corner.classList.remove('is-entering')
  corner.classList.add('is-leaving')
})
corner.addEventListener('animationend', (e) => { if (e.target === corner && corner.classList.contains('is-leaving')) close() })
// Only one sound at a time: the report page's strip pauses this one, and this one pauses the strip (strip.js)
window.addEventListener('naqi-strip-play', () => audio.pause())
audio.addEventListener('play', () => window.dispatchEvent(new CustomEvent('naqi-player-play')))

function drawCorner() {
  if (!inCorner()) return
  for (const k of ['kind', 'picture', 'waiting']) if (corner.dataset[k] !== screen.dataset[k]) corner.dataset[k] = screen.dataset[k] ?? ''
  const len = length()
  const peek = corner.querySelector('.corner-peek')
  peek.style.setProperty('--played', len ? Math.min(1, audio.currentTime / len) : 0)
  peek.style.setProperty('--cleaned', p.live ? (len ? Math.min(1, p.ready / len) : 0) : 1)
  const playing = !audio.paused && !audio.ended
  if (cornerPlay.getAttribute('aria-pressed') !== String(playing)) {
    cornerPlay.setAttribute('aria-pressed', playing)
    setTip(cornerPlay, playing ? 'Pause' : 'Play')
  }
}

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
    // At another speed (T10.5) the sound moves `rate` seconds a second, and the picture's own speed is that rate
    // nudged the same way
    const rate = audio.playbackRate
    const a = audio.currentTime + rate * (meta.expectedDisplayTime - performance.now()) / 1000
    const err = meta.mediaTime - a
    if (performance.now() > settleUntil) stats.sync.push([+a.toFixed(3), +err.toFixed(4)])
    if (Math.abs(err) > SYNC_JUMP_S) {
      video.currentTime = a + 0.03 * rate
      settleUntil = performance.now() + 2000
      integ = 0
    } else {
      // proportional + integral (the integral takes away a steady lag the proportional part leaves): T1.1 spike
      // A picture that just started (or jumped) is 50 to 80 ms behind: up to ±30% speed catches up within about
      // 0.3 s instead of a second; once close, ±10% keeps it there without visible speed changes
      integ = Math.max(-0.5, Math.min(0.5, integ + err / 30))
      const span = Math.abs(err) > SYNC_FAR_S ? 0.3 : 0.1
      video.playbackRate = rate * Math.max(1 - span, Math.min(1 + span, 1 - err * (Math.abs(err) > SYNC_FAR_S ? 4 : 1.5) - integ))
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
  setGear(false, { instant: true })
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
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

const TIP_ROOM = 12   // px the time tip may stick out past the time bar's ends (the bar's side padding is 16)
const fracAt = (e) => {
  const r = timebar.getBoundingClientRect()
  return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
}
timebar.addEventListener('pointermove', (e) => {
  const len = length()
  if (!len) return
  const f = fracAt(e)
  const blocked = p.live && f * len > p.ready
  const part = p.dragging ? null : mutedAt(f * timebar.clientWidth)
  showSpan(part)
  tip.dataset.blocked = blocked
  tip.textContent = blocked ? `${clock(f * len)} · not clean yet` : part ? `Muted ${clock(part[0])} – ${clock(part[1])}` : clock(f * len)
  // Centred on the pointer, but never past the screen's edge (the bar sits inside it)
  const w = timebar.clientWidth
  const half = tip.offsetWidth / 2
  tip.style.left = `${Math.min(w + TIP_ROOM - half, Math.max(half - TIP_ROOM, f * w))}px`
  if (p.dragging) drawTime(Math.min(f * len, cleanUpTo()))
})
timebar.addEventListener('pointerleave', () => showSpan(null))
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
// Up / Down keys: 5% a press (like YouTube); turning it up unmutes; remembered once the presses stop
const VOLUME_STEP = 0.05
let volumeSaveTimer = 0
let volumeShowTimer = 0
const volumeGroup = $('#volume-group')
function stepVolume(d) {
  volume.value = Math.min(1, Math.max(0, Number(volume.value) + d)).toFixed(2)
  audio.volume = Number(volume.value)
  if (audio.muted && d > 0) audio.muted = false
  showVolume()
  volumeGroup.classList.add('is-open')
  clearTimeout(volumeShowTimer)
  volumeShowTimer = setTimeout(() => volumeGroup.classList.remove('is-open'), 1200)
  clearTimeout(volumeSaveTimer)
  volumeSaveTimer = setTimeout(() => window.naqi.setSettings({ volume: volume.value }), 500)
}
$('#mute').addEventListener('click', toggleMute)
export function setVolume(value) {
  if (value !== undefined && value !== null && value !== '') volume.value = value
  audio.volume = Number(volume.value)
  showVolume()
}

// Fullscreen (F, its button or a double click on the picture): the screen alone. The browser leaves it on Escape by
// itself; that Escape must not also close the player.
const fullBtn = $('#full-toggle')
let leftFullAt = 0
document.addEventListener('fullscreenchange', () => {
  const on = !!document.fullscreenElement
  // Escape there is the browser's: it leaves fullscreen and closes the settings menu with it (like YouTube)
  if (!on) { leftFullAt = performance.now(); setGear(false, { instant: true }) }
  fullBtn.setAttribute('aria-pressed', on)
  setTip(fullBtn, on ? 'Leave fullscreen (F)' : 'Fullscreen (F)')
})
function toggleFull() {
  if (document.fullscreenElement) return document.exitFullscreen().catch((err) => console.warn('[naqi] fullscreen:', err.message))
  setKeys(false, { instant: true })
  screen.requestFullscreen().catch((err) => console.warn('[naqi] fullscreen:', err.message))
}
fullBtn.addEventListener('click', toggleFull)
// Not on the bar or the settings menu; a click that only closed the menu does nothing more (like YouTube)
const onPicture = (e) => !bar.contains(e.target) && !gearMenu.contains(e.target) && performance.now() - gearClosedAt > 400
screen.addEventListener('dblclick', (e) => { if (onPicture(e)) toggleFull() })
// One click on the picture pauses or plays (like YouTube: a double click's two clicks cancel out)
screen.addEventListener('click', (e) => { if (onPicture(e)) toggle() })
const setTip = (btn, text) => { btn.setAttribute('aria-label', text); btn.dataset.tip = text }

// Theater mode (T, its button): the player wide, the library hidden; only while the player shows, remembered
const theaterBtn = $('#theater-toggle')
let theater = false
export function setTheater(on, { save = false } = {}) {
  theater = on
  theaterBtn.setAttribute('aria-pressed', on)
  setTip(theaterBtn, on ? 'Default view (T)' : 'Theater mode (T)')
  document.body.toggleAttribute('data-theater', on && pages.shown() === 'player')
  if (save) window.naqi.setSettings({ theater: on ? '1' : '0' })
}
theaterBtn.addEventListener('click', () => setTheater(!theater, { save: true }))
window.addEventListener('naqi-page', (e) => document.body.toggleAttribute('data-theater', theater && e.detail.page === 'player'))

// The keys card: the keys button or ? opens it; a click outside, the button again, ? or Escape closes it
const keysCard = $('#keys-card')
const keysToggle = $('#keys-toggle')
const keysOpen = () => keysCard.matches(':popover-open')
function setKeys(open, { instant = false } = {}) {
  if (open === keysOpen()) return
  keysCard.toggleAttribute('data-instant', instant)
  if (open) { setGear(false, { instant: true }); keysCard.showPopover() } else keysCard.hidePopover()
  keysToggle.setAttribute('aria-expanded', open)
}
keysToggle.addEventListener('click', () => setKeys(!keysOpen()))
document.addEventListener('pointerdown', (e) => {
  if (keysOpen() && !keysCard.contains(e.target) && !keysToggle.contains(e.target)) setKeys(false)
})
// A key pressed while the card is open lights up on it, so the list answers what the hand just did
function lightKey(k) {
  if (!keysOpen()) return
  for (const cap of keysCard.querySelectorAll(`kbd[data-k~="${CSS.escape(k)}"]`)) {
    cap.classList.add('is-lit')
    clearTimeout(cap.litTimer)
    cap.litTimer = setTimeout(() => cap.classList.remove('is-lit'), 180)
  }
}

// ---------- Settings (ROADMAP T10.5) ----------
// The gear opens a small menu like YouTube's: a list of settings, each opening its own list in the same card (Back
// returns). It lives in the screen (so it stays in fullscreen) and moves into the corner with the picture. Keys: the
// arrows move in it, Right / Enter open, Left goes back, Escape closes; a click outside closes it.
const gearMenu = $('#gear-menu')
const gearButtons = [$('#gear-toggle'), $('#corner-gear')]
const gearDot = $('.gear-dot')
let gearClosedAt = 0   // a click outside closed it: that click does nothing else
const gearOpen = () => gearMenu.dataset.open === 'true'
const gearPanel = (name = gearMenu.dataset.panel) => gearMenu.querySelector(`.gear-panel[data-name="${name}"]`)
// The card takes the shown list's full height (borders included; a small screen caps it and the list scrolls),
// animated only between two lists
function sizeGear(animate) {
  gearMenu.toggleAttribute('data-sizing', !animate)
  gearMenu.style.setProperty('--h', `${gearPanel().scrollHeight + 2}px`)
}
function setGear(open, { instant = false } = {}) {
  if (open === gearOpen()) return
  const opener = inCorner() ? $('#corner-gear') : $('#gear-toggle')
  gearMenu.toggleAttribute('data-instant', instant)
  if (open) {
    setKeys(false, { instant: true })
    ;(inCorner() ? corner : screen).append(gearMenu)
    gearMenu.dataset.panel = 'main'
    $('#gear-report-value').textContent = clock(audio.currentTime || 0)
    gearMenu.inert = false
    sizeGear(false)
    void gearMenu.offsetWidth
    gearMenu.dataset.open = 'true'
    gearPanel().querySelector('.gear-item').focus({ preventScroll: true })
  } else {
    const hadFocus = gearMenu.contains(document.activeElement)
    gearMenu.dataset.open = 'false'
    gearMenu.inert = true
    if (hadFocus && opener.offsetWidth) opener.focus({ preventScroll: true })
  }
  for (const b of gearButtons) b.setAttribute('aria-expanded', open && b === opener)
}
function showGearPanel(name) {
  const from = gearMenu.dataset.panel
  gearMenu.dataset.panel = name
  sizeGear(true)
  if (name === 'speed') placeDot(true)
  const target = name === 'main' ? gearPanel().querySelector(`[data-go="${from}"]`)
    : gearPanel().querySelector('[aria-checked="true"]') || gearPanel().querySelector('.gear-item')
  target.focus({ preventScroll: true })
  // A small screen caps the card and the list scrolls: the chosen one is brought into sight once the card has its height
  setTimeout(() => {
    const pnl = gearPanel()
    const below = target.getBoundingClientRect().bottom - pnl.getBoundingClientRect().bottom + 6
    if (below > 0) pnl.scrollTop += below
  }, 240)
}
for (const b of gearButtons) b.addEventListener('click', () => setGear(!gearOpen()))
gearMenu.addEventListener('click', (e) => {
  const item = e.target.closest('.gear-item')
  if (!item) return
  if (item.dataset.go) return showGearPanel(item.dataset.go)
  if (item.dataset.speed) {
    setSpeed(Number(item.dataset.speed))
    // The dot slides to the new speed, then the list goes back to the settings, which show the new value
    setTimeout(() => { if (gearOpen() && gearMenu.dataset.panel === 'speed') showGearPanel('main') }, 260)
  }
})
gearMenu.addEventListener('keydown', (e) => {
  const items = [...gearPanel().querySelectorAll('.gear-item')].filter((b) => b.getClientRects().length && !b.disabled)
  const i = items.indexOf(document.activeElement)
  const k = e.key
  if (k === 'ArrowDown' || k === 'ArrowUp') items[(i + (k === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus()
  else if (k === 'Home' || k === 'End') items.at(k === 'Home' ? 0 : -1).focus()
  else if (k === 'ArrowRight' && items[i]?.dataset.go && gearMenu.dataset.panel === 'main') showGearPanel(items[i].dataset.go)
  else if ((k === 'ArrowLeft' || k === 'Backspace') && gearMenu.dataset.panel !== 'main') showGearPanel('main')
  else if (k === 'Escape') setGear(false, { instant: true })
  else if (k === 'Tab') return setGear(false)
  else return
  e.preventDefault()
  e.stopPropagation()
})
document.addEventListener('pointerdown', (e) => {
  if (gearOpen() && !gearMenu.contains(e.target) && !gearButtons.some((b) => b.contains(e.target))) {
    gearClosedAt = performance.now()
    setGear(false)
  }
})

// Speed 0.5x to 2x: the voice keeps its natural pitch (the browser stretches the sound), the picture follows the
// sound at the same rate (onFrame). Kept while Naqi is open, for the next item too (like YouTube), not after a restart.
audio.preservesPitch = true
let speed = 1
function placeDot(instant = false) {
  const on = $('#gear-speeds [aria-checked="true"]')
  gearDot.toggleAttribute('data-instant', instant)
  gearDot.style.setProperty('--y', `${on.offsetTop}px`)
}
function setSpeed(r) {
  speed = r
  audio.defaultPlaybackRate = r
  audio.playbackRate = r
  video.defaultPlaybackRate = r
  video.playbackRate = r
  settleUntil = performance.now() + 1000
  integ = 0
  for (const b of $('#gear-speeds').querySelectorAll('[data-speed]')) b.setAttribute('aria-checked', Number(b.dataset.speed) === r)
  placeDot()
  const value = $('#gear-speed-value')
  value.textContent = r === 1 ? 'Normal' : `${r}x`
  value.classList.remove('is-swapping')
  void value.offsetWidth
  value.classList.add('is-swapping')
}
setSpeed(1)
window.naqiSpeed = () => speed

// Keys while the player is open and no other control takes the key (ROADMAP T10.1): Space / K play / pause,
// M mute (old Naqi), Up / Down volume, Left / Right 5 s, Shift + arrows and J / L 10 s (like YouTube), F fullscreen,
// T theater mode, I miniplayer (the corner), ? the keys card,
// Escape back.
// Jumps go through jump(), so they stay inside the clean part like the time bar. A text box keeps its keys.
const STEP_S = 5
const BIG_STEP_S = 10
document.addEventListener('keydown', (e) => {
  if (p.id === null || $('#watch').hidden || e.ctrlKey || e.altKey || e.metaKey || e.defaultPrevented) return
  const el = document.activeElement
  if (el && (el.tagName === 'TEXTAREA' || el.isContentEditable)) return
  const isInput = el && el.tagName === 'INPUT'
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
  wake(true)
  if (key === 'Escape') {
    // Fullscreen ends first (the browser does it), then the keys card and the Save row close, then the player goes
    // back to Home (at once: it came from a key)
    if (document.fullscreenElement) return toggleFull()
    if (performance.now() - leftFullAt < 500) return
    if (keysOpen()) { lightKey('esc'); return setKeys(false, { instant: true }) }
    if (saveToggle.getAttribute('aria-expanded') === 'true') { setSaveOpen(false); $('#gear-toggle').focus() }
    else showPage(false, true)
    return
  }
  if (isInput && el.type !== 'range') return   // typing in a box
  if (key === '?') {
    if (document.fullscreenElement) return
    lightKey('?')
    return setKeys(!keysOpen(), { instant: true })
  }
  // The volume slider and the Save choices use their own arrows
  const ownArrows = isInput || (el && el.closest('.seg'))
  if ((key === 'ArrowUp' || key === 'ArrowDown') && !ownArrows) {
    e.preventDefault()
    lightKey(key === 'ArrowUp' ? 'up' : 'down')
    return stepVolume(key === 'ArrowUp' ? VOLUME_STEP : -VOLUME_STEP)
  }
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    if (ownArrows) return
    e.preventDefault()
    const step = (e.shiftKey ? BIG_STEP_S : STEP_S) * (key === 'ArrowRight' ? 1 : -1)
    lightKey(`${e.shiftKey ? 'shift-' : ''}${key === 'ArrowRight' ? 'right' : 'left'}`)
    return jump(audio.currentTime + step)
  }
  if (e.shiftKey) return
  if (key === ' ' && !(el && el.tagName === 'BUTTON')) { e.preventDefault(); lightKey('space'); return toggle() }
  if (key.length !== 1 || !'kjlmfti'.includes(key)) return
  if ((key === 't' || key === 'i') && document.fullscreenElement) return   // their buttons are out of sight there too
  lightKey(key)
  if (key === 'k') toggle()
  else if (key === 'j') jump(audio.currentTime - BIG_STEP_S)
  else if (key === 'l') jump(audio.currentTime + BIG_STEP_S)
  else if (key === 'm') toggleMute()
  else if (key === 'f') toggleFull()
  else if (key === 't') setTheater(!theater, { save: true })
  else if (key === 'i') { e.preventDefault(); showPage(false, true) }   // its letter must not land in Home's link box
})

// ---------- The item still being cleaned ----------
const finished = new Set()   // items whose "Clean and play" ended (done, cancelled or failed)
window.naqi.onJob((j) => {
  if (j.kind === 'play' && j.row_id && j.state !== 'running') finished.add(j.row_id)
  else if (j.kind === 'play' && j.row_id) finished.delete(j.row_id)   // cleaned again
  if (j.kind !== 'play' || j.row_id !== p.id || p.id === null) return
  if (j.total_s) p.length = j.total_s
  if (j.state === 'running') {
    if ((j.ready_s || 0) > p.ready) loadMutes()   // a new part is clean: its muted parts show
    p.ready = Math.max(p.ready, j.ready_s || 0)
    return draw()
  }
  if (j.state === 'done') { p.live = false; loadMutes(); if (sv.info) sv.info.ready = sv.info.can; drawSave(); return draw() }
  // Cancelled or failed: its cleaned sound is gone with it (Home tells why)
  close()
})

// ---------- Where the music was removed (ROADMAP T10.2b) ----------
// The engine reads where the cleaned sound was muted (exact silence, the same sound the report page's strip shows);
// they pinch the time bar to a hairline, like the strip's flat gaps. While the item is cleaned, each newly clean part
// adds its own. Hovering one brackets it and the tip gives its times.
const MUTE_HIT_PX = 3        // a short part is found this far from its pinch
const MUTE_MIN_PX = 2        // and is drawn at least this wide
async function loadMutes() {
  if (p.id === null) return
  if (p.muteBusy) { p.muteAgain = true; return }
  const id = p.id
  p.muteBusy = true
  try {
    const m = await window.naqi.mutedParts(id)
    if (p.id === id) { p.mutes = m; drawMutes() }
  } catch (e) {
    console.warn('[naqi] muted parts:', cleanError(e))
  } finally {
    p.muteBusy = false
    if (p.muteAgain) { p.muteAgain = false; loadMutes() }
  }
}

// The parts in px of the time bar, short ones widened around their middle
function mutePx() {
  const len = length()
  const w = lines.clientWidth
  if (!len || !w) return []
  return p.mutes.parts.map(([a, b]) => {
    const x0 = (a / len) * w
    const x1 = (b / len) * w
    const grow = Math.max(0, MUTE_MIN_PX - (x1 - x0)) / 2
    return [x0 - grow, x1 + grow, a, b]
  })
}

let muteKey = ''
function drawMutes() {
  const w = lines.clientWidth
  const key = `${w}|${length()}|${p.mutes.parts.length}|${p.mutes.parts.at(-1)?.[1]}`
  if (key === muteKey) return
  muteKey = key
  const px = mutePx()
  if (!px.length) return lines.style.removeProperty('--muted-mask')
  // Full height between the parts (rounded ends, so each pinch narrows softly), a thin line all along
  let d = ''
  let x = 0
  for (const [x0, x1] of [...px, [w, w]]) {
    if (x0 > x) d += `<rect x="${x.toFixed(1)}" y="0" width="${(x0 - x).toFixed(1)}" height="10" rx="2.5" ry="5"/>`
    x = Math.max(x, x1)
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} 10" preserveAspectRatio="none">` +
    `<rect x="0" y="3.6" width="${w}" height="2.8"/>${d}</svg>`
  lines.style.setProperty('--muted-mask', `url("data:image/svg+xml,${encodeURIComponent(svg)}")`)
}
new ResizeObserver(() => drawMutes()).observe(lines)
audio.addEventListener('durationchange', () => drawMutes())

const mutedAt = (x) => {
  const hit = mutePx().find(([x0, x1]) => x >= x0 - MUTE_HIT_PX && x <= x1 + MUTE_HIT_PX)
  return hit ? [hit[2], hit[3]] : null
}
let spanOn = null
function showSpan(part) {
  if (part?.[0] === spanOn?.[0]) return
  spanOn = part
  span.dataset.on = Boolean(part)
  if (!part) return
  const [x0, x1] = mutePx().find(([, , a]) => a === part[0])
  const w = Math.max(10, x1 - x0 + 6)
  span.style.left = `${(x0 + x1) / 2 - w / 2}px`
  span.style.width = `${w}px`
}

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
  setGear(false, { instant: true })
  if (open && document.fullscreenElement) document.exitFullscreen().catch(() => {})   // the Save row is under the screen
  setSaveOpen(open)
  if (open) saveGo.focus({ preventScroll: true })
})

function setSaveStatus(text, state = '') {
  const el = $('#save-status')
  if (el.textContent !== text) el.textContent = text
  el.dataset.state = state
  el.title = text
  // A failed Save can be reported: Copy details puts it on the clipboard with the versions
  const details = $('#save-details')
  if (state === 'error') details.replaceChildren(detailsButton({ where: `Player, Save as ${saveFmt.value().toUpperCase()}`, title: 'Save failed', text }, { small: true }))
  details.hidden = state !== 'error'
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
  $('#gear-save-value').textContent = mine ? 'saving…' : ready ? 'MP3 or MP4' : p.live ? 'when all is clean' : 'not now'
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

// ---------- The bar on the picture (ROADMAP T10.1b) ----------
// Like YouTube: while the picture plays, the bar hides a moment after the mouse stops and comes back when the mouse
// moves over the screen or a key is pressed. It stays while anything needs it: paused or ended, waiting at the clean
// edge, a sound only (no picture to uncover), the time bar dragged, the mouse on the bar, the Save row or the keys card
// open. Keyboard focus on a control does not hold it (it stayed for good after a key in fullscreen); a key wakes it.
const BAR_IDLE_MS = 3000
const bar = $('#screen-bar')
let wokeAt = 0
let lastMove = ''
function wake(instant = false) {
  wokeAt = performance.now()
  if (screen.dataset.bar === 'hidden') {
    screen.toggleAttribute('data-bar-instant', instant)   // from a key: at once, a key should not wait for motion
    screen.dataset.bar = 'shown'
  }
}
// The browser also sends a move when the page changes under a still mouse: only a real move counts
screen.addEventListener('pointermove', (e) => {
  const at = `${e.screenX},${e.screenY},${e.clientX},${e.clientY}`
  if (at !== lastMove) { lastMove = at; wake() }
})
screen.addEventListener('pointerdown', () => wake())
screen.addEventListener('pointerleave', () => { if (!barNeeded()) wokeAt = -Infinity })   // the mouse left: hide now
bar.addEventListener('focusin', () => wake())
const barNeeded = () => screen.dataset.kind !== 'video' || audio.paused || audio.ended || p.waiting || p.dragging ||
  bar.matches(':hover') || keysOpen() || gearOpen() || saveToggle.getAttribute('aria-expanded') === 'true'
function drawBar() {
  const now = performance.now()
  if (barNeeded()) wokeAt = Math.max(wokeAt, now)   // the wait starts once nothing holds the bar any more
  const state = now - wokeAt > BAR_IDLE_MS ? 'hidden' : 'shown'
  if (screen.dataset.bar === state) return
  if (state === 'hidden') screen.removeAttribute('data-bar-instant')
  screen.dataset.bar = state
}

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
  const played = len ? Math.min(1, at / len) : 0
  timebar.style.setProperty('--played', played)
  peek.style.setProperty('--played', played)
  $('#t-now').textContent = clock(at)
  timebar.setAttribute('aria-valuenow', Math.round(at))
  timebar.setAttribute('aria-valuetext', `${clock(at)} of ${clock(len)}`)
}

function draw() {
  if (p.id === null) return
  const len = length()
  const clean = p.live ? (len ? Math.min(1, p.ready / len) : 0) : 1
  timebar.style.setProperty('--cleaned', clean)
  peek.style.setProperty('--cleaned', clean)
  timebar.dataset.cleaning = p.live
  drawMutes()
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
  drawBar()
  drawCorner()
}

// The time moves smoothly while the player is open (in its page or in the corner)
function frame() {
  if (p.id !== null && (!$('#watch').hidden || inCorner())) draw()
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
