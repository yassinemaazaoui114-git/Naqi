// "Report a slip" (ROADMAP T5.1, old Naqi SlipPage, old SPEC R11 / R13): a moment where Naqi got it wrong (music
// heard, or talking / singing / another sound cut) is saved as a permanent test case: a row in slip_cases.csv and a
// copy of its sound (engine/cases.py). The file comes from Recent files (a link's kept sound is used), a pasted link
// or a picked file (a file Naqi cleaned is traced back to its history row or its link). A Bad rating opens this page
// with that file picked (main.js). Above the times, the sound strip plays a picked library file's cleaned sound
// (strip.js), so the moment is found by ear and its times taken from the playhead.
import { icon } from './design/icons.js'
import { detailsButton } from './details.js'
import * as pages from './pages.js'
import * as player from './player.js'
import { onRated, rate, rateEl, showRating } from './rating.js'
import { seg } from './seg.js'
import * as strip from './strip.js'

const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]

const RECENT_MAX = 30   // old Naqi's Recent files
const REPORT_BACK_S = 6 // Report here: the slip is taken as the last few seconds up to the playhead (old Naqi)
const SRC_HINT = 'For your own files, pick the original (not the cleaned copy).'
const STRIP_IDLE = 'Pick a file above to hear its cleaned sound here.'
const STRIP_NONE = 'Naqi has no cleaned sound of this one, so it cannot play here. Type the times below.'

const list = $('#recent')
const light = $('.lib-light', list)
const source = $('#source')
const from = $('#from')
const to = $('#to')
const note = $('#note')
const saveBtn = $('#save-slip')
const kind = seg($('#slip-kind'), () => {})
kind.set(null, 'music')

const r = {
  items: [],
  chosen: null,   // { row, source, title, download } the report is about; row null = a pasted link or picked file
  back: 'home',   // where Back goes: 'player' after Report here (while that player is still open)
  saving: false
}

const cleanError = (e) => e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const isLink = (s) => /^https?:\/\//i.test(s.trim())
const plural = (n) => `${n} slip${n === 1 ? '' : 's'}`

// 'Today, 14:03', 'Yesterday, 09:12' or '12 Nov' (as in the library)
function when(added) {
  const t = new Date(added)
  const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const days = Math.round((day(new Date()) - day(t)) / 86400000)
  const time = t.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  if (days === 0) return `Today, ${time}`
  if (days === 1) return `Yesterday, ${time}`
  return t.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

// '1:23', '1:02:03' or '83.5' -> seconds (speech_only.parse_time), NaN when it is not a time
export function seconds(text) {
  const t = text.trim()
  if (!/^\d+(\.\d+)?$|^\d+(:\d{1,2}(\.\d+)?){1,2}$/.test(t)) return NaN
  return t.split(':').reduce((sum, part) => sum * 60 + Number(part), 0)
}

// ---------- Opening ----------
// id: a library item to pick (a Bad rating, Report here); otherwise the page opens as it was left.
// at: the player's playhead (Report here): the moment heard just before it is filled in. back: 'player' to return there.
export async function open({ id = null, at = null, back = 'home' } = {}) {
  r.back = back
  $('#report-back').setAttribute('aria-label', back === 'player' ? 'Back to the player' : 'Back to Home')
  if (at !== null) setMoment(at)
  pages.show('report')
  await Promise.all([fillRecent(), showCount()])
  if (id !== null) await choose({ row: id })
  ;(source.value ? from : source).focus({ preventScroll: true })
}

// Old Naqi's set_moment: whole seconds, ready to adjust (the strip lights it and can play it)
function setMoment(at) {
  const end = Math.floor(at) + 1
  from.value = strip.stamp(Math.max(0, end - REPORT_BACK_S))
  to.value = strip.stamp(end)
  showLength()
}

async function showCount() {
  if (r.saving) return
  try {
    const { count } = await window.naqi.slipCount()
    setStatus(count ? `${plural(count)} saved so far.` : '')
  } catch { setStatus('') }
}

const goBack = (instant = false) => pages.show(r.back === 'player' && player.openId() !== null ? 'player' : 'home', {}, { instant })
$('#report-back').addEventListener('click', () => goBack())
// Escape goes back too (at once: it came from a key), unless a list or the strip uses it first
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented || $('#report').hidden || e.ctrlKey || e.altKey) return
  goBack(true)
})
$('#open-report').addEventListener('click', () => open())
window.addEventListener('naqi-page', (e) => {
  const on = e.detail.page === 'report'
  if (on) $('#open-report').setAttribute('aria-current', 'page')
  else $('#open-report').removeAttribute('aria-current')
})

// ---------- Recent files: newest first, with their rating; a row picks the file ----------
async function fillRecent() {
  try {
    r.items = (await window.naqi.library()).items.slice(0, RECENT_MAX)
  } catch {
    r.items = []   // the history is a help, never a reason for the page to fail
  }
  list.querySelectorAll('li[data-id]').forEach((li) => li.remove())
  for (const it of r.items) list.append(rowEl(it))
  $('#recent-empty').hidden = r.items.length > 0
  list.hidden = !r.items.length
  $('#recent-note').textContent = r.items.length ? 'Rate them so Naqi learns' : ''
  mark()
}

function rowEl(it) {
  const li = document.createElement('li')
  li.dataset.id = it.id
  li.innerHTML = `
    <button class="lib-row" data-kind="${it.kind}" data-gone="${it.state === 'gone'}">
      <span class="lib-thumb">${icon(it.state === 'gone' ? 'warning' : it.kind)}</span>
      <span class="lib-text"><span class="lib-title" dir="auto"></span><span class="lib-meta"></span></span>
    </button>`
  const row = $('.lib-row', li)
  $('.lib-title', row).textContent = it.title
  row.title = it.source
  $('.lib-meta', row).textContent = [when(it.added), it.from, ...(it.reported ? ['Slip reported'] : [])].join(' · ')
  const rating = rateEl(async (value) => {
    showRating(rating, value)
    try { await rate(it.id, value) } catch (e) {   // a Bad rating picks the row (onRated -> main.js -> open)
      showRating(rating, it.rating)
      setStatus(`Rating not saved: ${cleanError(e)}`, 'error', 'Report a slip, rating')
    }
  })
  showRating(rating, it.rating)
  li.append(rating)
  row.addEventListener('click', () => choose({ row: it.id }))
  return li
}
onRated(({ id, rating }) => {
  const it = r.items.find((x) => x.id === id)
  const el = $(`li[data-id="${id}"] .rate`, list)
  if (it) it.rating = rating
  if (el) showRating(el, rating)
})

// The picked row: aria-current, and the one light slides to it (as in the library)
function mark() {
  const id = r.chosen?.row ?? null
  let picked = null
  for (const li of $$('li[data-id]', list)) {
    const on = Number(li.dataset.id) === id
    if (on) { $('.lib-row', li).setAttribute('aria-current', 'true'); picked = li } else $('.lib-row', li).removeAttribute('aria-current')
  }
  light.style.opacity = picked ? 1 : 0
  if (!picked) return
  light.style.transform = `translateY(${picked.offsetTop}px)`
  light.style.height = `${picked.offsetHeight}px`
  const top = picked.offsetTop - list.scrollTop
  if (top < 0 || top + picked.offsetHeight > list.clientHeight) picked.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
}

// ---------- The source: a row, a pasted link or a picked file ----------
async function choose(what) {
  try {
    const got = await window.naqi.slipSource(what)
    r.chosen = got
    source.value = got.source
    source.setSelectionRange(0, 0)
    source.scrollLeft = 0
    showHint(got.hint)
    strip.load(got.row, STRIP_NONE)
    $('#source-field').dataset.state = ''
    mark()
    from.focus({ preventScroll: true })
  } catch (e) {
    setStatus(cleanError(e), 'error', 'Report a slip, picking the file')
  }
}

function showHint(text) {
  const help = $('#source-help')
  help.textContent = text
  help.classList.remove('is-swapping')
  void help.offsetWidth
  help.classList.add('is-swapping')
}

source.addEventListener('input', () => {
  if (!r.chosen) return
  r.chosen = null
  mark()
  showHint(SRC_HINT)
  strip.load(null, source.value.trim() ? STRIP_NONE : STRIP_IDLE)
})
$('#pick-file').addEventListener('click', async () => {
  const [path] = await window.naqi.chooseFile()
  if (path) choose({ path })
})
showHint(SRC_HINT)
strip.load(null, STRIP_IDLE)

// ---------- When: the length of the moment shows between the two times ----------
function showLength() {
  const a = seconds(from.value)
  const b = seconds(to.value)
  const len = b - a
  const el = $('#moment-len')
  const ok = Number.isFinite(len) && len > 0
  el.textContent = ok ? `${len < 10 ? Math.round(len * 10) / 10 : Math.round(len)} s` : ''
  el.parentElement.dataset.on = ok
  strip.moment(a, b)
}
for (const box of [from, to]) box.addEventListener('input', showLength)
// From here / To here: the playhead's time goes in the box, which flashes once
strip.onFill((which, time) => {
  const box = which === 'from' ? from : to
  box.value = time
  showLength()
  box.parentElement.classList.remove('is-filled')
  void box.offsetWidth
  box.parentElement.classList.add('is-filled')
})
for (const box of [source, from, to, note]) box.addEventListener('keydown', (e) => { if (e.key === 'Enter') save() })

// ---------- Saving ----------
// where: an engine error, named for Copy details (after the text)
function setStatus(text, kind = '', where = '') {
  const el = $('#report-status')
  el.dataset.kind = kind
  el.innerHTML = text ? `${kind ? icon(kind === 'error' ? 'error' : 'done', 'icon-sm') : ''}<span></span>` : ''
  if (text) $('span', el).textContent = text
  if (text && where) el.append(detailsButton({ where, title: '', text }, { small: true }))
}

async function save() {
  if (r.saving) return
  const src = source.value.trim()
  for (const [box, empty, msg] of [[source, !src, 'Paste the link or pick the file first.'],
    [from, !from.value.trim(), 'Write when the slip starts, e.g. 1:23.'],
    [to, !to.value.trim(), 'Write when the slip ends, e.g. 1:26.']]) {
    if (empty) { setStatus(msg, 'error'); box.focus(); return }
  }
  const chosen = r.chosen && r.chosen.source === src ? r.chosen : null
  r.saving = true
  saveBtn.disabled = true
  $('#save-text').textContent = 'Saving…'
  setStatus(isLink(src) && (!chosen || chosen.download) ? 'Downloading the sound for the case…' : 'Copying the sound for the case…')
  try {
    const { count } = await window.naqi.saveSlip({ source: src, start: from.value, end: to.value, expect: kind.value(),
      note: note.value, row: chosen?.row ?? null })
    setStatus(`Saved. ${plural(count)} saved so far. Thank you!`, 'done')
    // The file stays: often there is more than one slip in it
    from.value = to.value = note.value = ''
    showLength()
    from.focus()
    fillRecent()
  } catch (e) {
    setStatus(cleanError(e), 'error', 'Report a slip, saving')
  } finally {
    r.saving = false
    saveBtn.disabled = false
    $('#save-text').textContent = 'Save the slip'
  }
}
saveBtn.addEventListener('click', save)
