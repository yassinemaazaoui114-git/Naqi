// The Settings page (ROADMAP T11.2, SPEC R43): look, where saves go, how long and how much
// cleaned sound is kept, and GPU or CPU. Each choice is kept at once (settings.json in %APPDATA%\Naqi); the keep rule
// reaches the engine at once, the device starts the engine again. Opened by the gear at the bottom of the library or
// the strip; Back (or Escape) returns where it was opened from. Home hears about its shared choices through a
// 'naqi-settings' event (folder). MP3 quality is chosen when saving (Home's Options, the player's Save), not here.
import * as pages from './pages.js'
import * as player from './player.js'
import { seg } from './seg.js'

const $ = (s) => document.querySelector(s)
const BARS = 40
const s = { back: 'home', settings: {}, device: 'gpu', switching: false }

const tell = (patch) => window.dispatchEvent(new CustomEvent('naqi-settings', { detail: patch }))
const plain = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

// ---------- Opening and Back ----------
export async function open() {
  if (pages.shown() === 'settings') return
  s.back = pages.shown() === 'player' ? 'player' : pages.shown() === 'report' ? 'report' : 'home'
  $('#settings-back').setAttribute('aria-label', `Back to ${{ home: 'Home', player: 'the player', report: 'Report a slip' }[s.back]}`)
  s.settings = await window.naqi.getSettings()
  showFolder()
  pages.show('settings')
  showKeep()
  showDevice()
}
const goBack = (instant = false) => pages.show(s.back === 'player' && player.openId() === null ? 'home' : s.back, {}, { instant })
$('#settings-back').addEventListener('click', () => goBack())
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented || $('#settings').hidden || e.ctrlKey || e.altKey) return
  goBack(true)
})
$('#open-settings').addEventListener('click', () => open())
window.addEventListener('naqi-page', (e) => {
  for (const b of [$('#open-settings'), $('#rail-settings')]) {
    if (e.detail.page === 'settings') b.setAttribute('aria-current', 'page')
    else b.removeAttribute('aria-current')
  }
})

// ---------- Saving: the folder (the same one Home's Options show) ----------
function showFolder() {
  const el = $('#set-folder')
  el.textContent = s.settings.folder || ''
  el.title = s.settings.folder || ''
}
$('#set-folder-change').addEventListener('click', async () => {
  const next = await window.naqi.chooseFolder()
  if (!next) return
  s.settings = next
  showFolder()
  tell({ folder: next.folder })
})
$('#set-folder-show').addEventListener('click', () => window.naqi.showInFolder(s.settings.folder))

// ---------- Cleaned sounds kept: 2 weeks / 5 GB unless changed (v5 SPEC rule, Yassine 2026-11-26) ----------
const days = seg($('#set-days'), () => setKeep())
const gb = seg($('#set-gb'), () => setKeep())
$('#keep-bars').innerHTML = Array.from({ length: BARS }, (_, i) =>
  `<i style="--h:${(0.35 + 0.65 * Math.abs(Math.sin(i * 1.7) * Math.cos(i * 0.6))).toFixed(2)};--d:${i}"></i>`).join('')

const size = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`)
function drawMeter(rule) {
  const share = Math.min(1, rule.used / (rule.gb * 1e9))
  const lit = rule.used > 0 ? Math.max(1, Math.round(share * BARS)) : 0
  $('#keep-bars').querySelectorAll('i').forEach((b, i) => b.classList.toggle('is-lit', i < lit))
  $('#keep-meter').setAttribute('aria-valuenow', Math.round(share * 100))
  $('#keep-text').textContent = `${size(rule.used)} of ${rule.gb} GB used`
}
async function showKeep() {
  $('#keep-note').textContent = ''
  try {
    const rule = await window.naqi.keepRule()
    days.set(null, String(rule.days))
    gb.set(null, String(rule.gb))
    drawMeter(rule)
  } catch {
    days.set(null, s.settings.keep_days || '14')
    gb.set(null, s.settings.keep_gb || '5')
    $('#keep-text').textContent = 'The space used shows once the engine is ready.'
  }
}
async function setKeep() {
  const note = $('#keep-note')
  try {
    const rule = await window.naqi.setKeepRule(days.value(), gb.value())
    drawMeter(rule)
    note.textContent = rule.removed ? `${rule.removed === 1 ? 'One older sound was' : `${rule.removed} older sounds were`} deleted to fit. Those items are cleaned again when played.` : ''
  } catch (e) {
    note.textContent = `Kept for the next start; the engine did not answer (${plain(e)}).`
  }
}

// ---------- GPU or CPU: the engine starts again with the choice ----------
const deviceEl = $('#set-device')
const cards = () => [...deviceEl.querySelectorAll('button')]
function drawDevice(value) {
  for (const b of cards()) {
    const on = b.dataset.value === value
    b.setAttribute('aria-checked', on)
    b.tabIndex = on ? 0 : -1
  }
}
async function showDevice() {
  const info = await window.naqi.systemInfo()
  s.hasGpu = Boolean(info.gpu)
  s.device = s.settings.device === 'cpu' || !s.hasGpu ? 'cpu' : 'gpu'
  $('#device-gpu-text').textContent = s.hasGpu ? `${info.gpu.split(',')[0]} · about 7 times faster than the video plays` : 'No NVIDIA graphics card was found on this PC'
  cards()[0].disabled = !s.hasGpu
  drawDevice(s.device)
  if (!s.switching) $('#device-note').textContent = 'Changing it starts the engine again (about 10 s). What is playing stops.'
}
async function pickDevice(value) {
  if (value === s.device || s.switching) return
  const note = $('#device-note')
  const before = s.device
  s.switching = true
  drawDevice(value)
  deviceEl.dataset.busy = 'true'
  note.textContent = 'Starting the engine again…'
  try {
    if (player.openId() !== null) player.close()   // its sound comes from the engine, which goes away for a moment
    await window.naqi.setDevice(value)
    s.device = value
    s.settings.device = value
  } catch (e) {
    drawDevice(before)
    note.textContent = plain(e)
    s.switching = false
    delete deviceEl.dataset.busy
  }
}
deviceEl.addEventListener('click', (e) => {
  const b = e.target.closest('button')
  if (b && !b.disabled) pickDevice(b.dataset.value)
})
deviceEl.addEventListener('keydown', (e) => {
  const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key]
  if (!step) return
  e.preventDefault()
  const list = cards().filter((b) => !b.disabled)
  const next = list[(list.findIndex((b) => b.dataset.value === s.device) + step + list.length) % list.length]
  next.focus()
  pickDevice(next.dataset.value)
})
// The engine comes back: the page says on what it runs now
window.naqi.onEngineStatus((st) => {
  if (!s.switching || (st.status !== 'ready' && st.status !== 'stopped' && st.status !== 'error')) return
  s.switching = false
  delete deviceEl.dataset.busy
  const on = st.gpu?.device === 'cuda' ? `the graphics card (${st.gpu.name})` : 'the CPU'
  $('#device-note').textContent = st.status === 'ready' ? `Ready: cleaning runs on ${on}.` : `The engine did not start: ${st.message || 'unknown error'}`
  if (st.status === 'ready') showKeep()
})
