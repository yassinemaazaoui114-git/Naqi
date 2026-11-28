// Rating and a quick slip in the player (ROADMAP T13.9): Bad / Good / Perfect next to the title, and "Quick slip"
// opens a small row under the player with the 6 s up to the playhead, the problem and a note. It saves the same
// slip_cases.csv row and sound copy as the report page (engine/cases.py), without leaving the player. Bad given here
// opens this row (main.js skips the report page for it); "Report page" still opens the full page at the playhead.
import { icon } from './design/icons.js'
import { detailsButton } from './details.js'
import * as player from './player.js'
import { onRated, rate, rateEl, showRating } from './rating.js'
import { seconds } from './report.js'
import { seg } from './seg.js'
import { stamp } from './strip.js'

const $ = (sel, root = document) => root.querySelector(sel)

const REPORT_BACK_S = 6   // as Report here: the slip is the last few seconds up to the playhead (old Naqi)
const verdict = $('#watch-verdict')
const panel = $('#slip-panel')
const toggleBtn = $('#slip-toggle')
const from = $('#qs-from')
const to = $('#qs-to')
const note = $('#qs-note')
const saveBtn = $('#qs-save')
const kind = seg($('#qs-kind'), () => {})
kind.set(null, 'music')

const q = { id: null, rating: null, saving: false }
const cleanError = (e) => e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const plural = (n) => `${n} slip${n === 1 ? '' : 's'}`

// ---------- Rating ----------
const rating = rateEl(async (value) => {
  const id = q.id
  showRating(rating, value)
  try {
    await rate(id, value, 'player')
    q.rating = value
    if (value === 'bad') openSlip()   // a bad file most likely has a slip to report, right where it was heard
  } catch (e) {
    showRating(rating, q.rating)
    player.note(`Rating not saved: ${cleanError(e)}`)
  }
})
$('#watch-rate').append(rating)
onRated(({ id, rating: value }) => {
  if (id !== q.id) return
  q.rating = value
  showRating(rating, value)
})

window.addEventListener('naqi-player-opened', (e) => {
  q.id = e.detail.id
  q.rating = e.detail.rating || null
  showRating(rating, q.rating)
  verdict.hidden = false
  setOpen(false)
  setStatus('')
})
window.addEventListener('naqi-player-closed', () => { q.id = null; setOpen(false) })

// ---------- The quick slip ----------
function setOpen(open) {
  panel.dataset.open = open
  toggleBtn.setAttribute('aria-expanded', open)
  panel.firstElementChild.inert = !open
}

// The slip was just heard: the sound pauses and the moment up to the playhead is filled in (old Naqi's set_moment)
function openSlip() {
  if (q.id === null) return
  player.pause()
  const end = Math.floor(player.playhead()) + 1
  from.value = stamp(Math.max(0, end - REPORT_BACK_S))
  to.value = stamp(end)
  showLength()
  if (panel.dataset.open !== 'true') setStatus('')
  setOpen(true)
  $('#qs-kind [aria-checked="true"]').focus({ preventScroll: true })
}

function closeSlip() {
  setOpen(false)
  toggleBtn.focus({ preventScroll: true })
}

toggleBtn.addEventListener('click', () => (panel.dataset.open === 'true' ? closeSlip() : openSlip()))
$('#qs-close').addEventListener('click', closeSlip)
$('#qs-more').addEventListener('click', () => {
  if (q.id === null) return
  setOpen(false)
  window.dispatchEvent(new CustomEvent('naqi-report-here', { detail: { id: q.id, at: player.playhead() } }))
})
// Escape closes the row first (before the player's Escape goes back to Home)
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || panel.dataset.open !== 'true' || !panel.contains(document.activeElement)) return
  e.preventDefault()
  closeSlip()
}, true)

function showLength() {
  const len = seconds(to.value) - seconds(from.value)
  const el = $('#qs-len')
  const ok = Number.isFinite(len) && len > 0
  el.textContent = ok ? `${len < 10 ? Math.round(len * 10) / 10 : Math.round(len)} s` : ''
  el.parentElement.dataset.on = ok
}
for (const box of [from, to]) box.addEventListener('input', showLength)
for (const box of [from, to, note]) box.addEventListener('keydown', (e) => { if (e.key === 'Enter') save() })

function setStatus(text, state = '', where = '') {
  const el = $('#qs-status')
  el.dataset.kind = state
  el.innerHTML = text ? `${state ? icon(state === 'error' ? 'error' : 'done', 'icon-sm') : ''}<span></span>` : ''
  if (text) $('span', el).textContent = text
  if (text && where) el.append(detailsButton({ where, title: '', text }, { small: true }))
}

async function save() {
  if (q.saving || q.id === null) return
  for (const [box, msg] of [[from, 'Write when the slip starts, e.g. 1:23.'], [to, 'Write when the slip ends, e.g. 1:26.']]) {
    if (!box.value.trim()) { setStatus(msg, 'error'); box.focus(); return }
  }
  const id = q.id
  q.saving = true
  saveBtn.disabled = true
  $('#qs-save-text').textContent = 'Saving…'
  setStatus('Copying the sound for the case…')
  try {
    const got = await window.naqi.slipSource({ row: id })
    if (got.download) setStatus('Downloading the sound for the case…')
    const { count } = await window.naqi.saveSlip({ source: got.source, start: from.value, end: to.value,
      expect: kind.value(), note: note.value, row: id })
    if (q.id !== id) return
    setStatus(`Saved. ${plural(count)} saved so far. Thank you!`, 'done')
    note.value = ''
  } catch (e) {
    if (q.id === id) setStatus(cleanError(e), 'error', 'Player, quick slip')
  } finally {
    q.saving = false
    saveBtn.disabled = false
    $('#qs-save-text').textContent = 'Save the slip'
  }
}
saveBtn.addEventListener('click', save)
setOpen(false)
