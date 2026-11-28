// Library side bar (ROADMAP T3.1): every cleaned file from the history, newest first (engine/library.py gives the
// items with old Naqi's rules). Clicking a row picks it: one light slides to it and its actions open under it
// (its rating, Show in folder, Remove). Its round Play button (or a double click) plays it (T4.1: a 'naqi-play' event,
// main.js decides how). Remove waits a few seconds with an Undo, then
// the engine deletes the row and Naqi's own kept copy; saved files and own files are never touched.
// T10.6: a search box (name) and filters (when, rating, link or own file) above the list hide the rows that do not match.
// T13.4: Continue watching above the list: items stopped before the end, the last one watched first.
// T13.8: Add to Up next in a row's actions puts it in Up next (queue.js).
import { icon } from './design/icons.js'
import { detailsButton } from './details.js'
import { onRated, rate, rateEl, showRating } from './rating.js'

const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]

const UNDO_MS = 5000
const list = $('#lib')
const light = $('.lib-light', list)
const lib = {
  items: [],
  picked: null,        // id of the picked row
  leaving: new Map(),  // id -> timer: removed, waiting for Undo
  live: null,          // { row_id, frac } of the "Clean and play" job running now
  drawn: false,        // after the first draw, new rows slide in
  q: '',               // T10.6: the search text (name)
  f: { when: '', rating: '', from: '' }   // T10.6: the filters ('' = any)
}

// ---------- Search and filters (T10.6) ----------
// Rows that do not match are only hidden (kept in the list), so typing never rebuilds or re-animates them.
// Letters are compared without case and accents (é = e, Arabic short vowels ignored); every word must be in the name.
const fold = (s) => (s || '').normalize('NFKD').replace(/[̀-ًͯ-ٰٟ]/g, '').toLowerCase()
const DAY = 86400000
const FILTER_TEXT = {
  when: { today: 'Today', week: 'Last 7 days', month: 'Last 30 days' },
  rating: { none: 'Not rated', bad: 'Bad', good: 'Good', perfect: 'Perfect' },
  from: { link: 'Links', own: 'Own files' }
}

function matches(it) {
  const name = fold(it.title)
  if (!fold(lib.q).split(/\s+/).filter(Boolean).every((w) => name.includes(w))) return false
  const { when, rating, from } = lib.f
  if (when) {
    const added = new Date(it.added)
    const today = new Date(new Date().toDateString())
    if (when === 'today' ? added < today : Date.now() - added > (when === 'week' ? 7 : 30) * DAY) return false
  }
  if (rating && (it.rating || 'none') !== rating) return false
  if (from && (/^https?:\/\//i.test(it.source || '') ? 'link' : 'own') !== from) return false
  return true
}

const filtering = () => !!lib.q.trim() || Object.values(lib.f).some(Boolean)

const search = $('#lib-q')
const filterToggle = $('#lib-filter-toggle')
const filters = $('#lib-filters')

function setSearch(text) {
  search.value = text
  lib.q = text
  $('#lib-q-clear').hidden = !text
  draw()
}
search.addEventListener('input', () => setSearch(search.value))
$('#lib-q-clear').addEventListener('click', () => { setSearch(''); search.focus() })
search.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    // A first Escape clears the text, a second leaves the box (and never reaches the player behind it)
    e.preventDefault()
    if (search.value) setSearch('')
    else search.blur()
  } else if (e.key === 'ArrowDown') {
    const first = $('li[data-id]:not(.is-leaving):not([hidden]) .lib-row', list)
    if (first) { e.preventDefault(); first.focus() }
  }
})

function setFilters(open) {
  filterToggle.setAttribute('aria-expanded', open)
  filters.dataset.open = open
  $$('button', filters).forEach((b) => { b.tabIndex = open ? 0 : -1 })
}
filterToggle.addEventListener('click', () => setFilters(filterToggle.getAttribute('aria-expanded') !== 'true'))

// One choice per group; clicking the chosen one again sets the group back to any
function setFilter(group, value) {
  lib.f[group] = value
  for (const b of $$(`[data-filter="${group}"] button`, filters)) b.setAttribute('aria-pressed', b.dataset.value === value)
  draw()
}
filters.addEventListener('click', (e) => {
  const b = e.target.closest('.lib-chips button')
  if (!b) return
  const group = b.closest('[data-filter]').dataset.filter
  setFilter(group, lib.f[group] === b.dataset.value ? '' : b.dataset.value)
})
function clearFilters() { for (const group of Object.keys(lib.f)) setFilter(group, '') }
$('#lib-filter-clear').addEventListener('click', () => { clearFilters(); filterToggle.focus() })
$('#lib-show-all').addEventListener('click', () => { clearFilters(); setSearch('') })

function noneText() {
  const parts = Object.entries(lib.f).filter(([, v]) => v).map(([g, v]) => FILTER_TEXT[g][v])
  const q = lib.q.trim()
  if (q && parts.length) return `No file named “${q}” in ${parts.join(' · ')}.`
  if (q) return `No file named “${q}”.`
  return `No file in ${parts.join(' · ')}.`
}

// 'Today, 14:03', 'Yesterday, 09:12' or '12 Nov' (old Naqi when_text)
function when(added) {
  const t = new Date(added)
  const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const days = Math.round((day(new Date()) - day(t)) / 86400000)
  const time = t.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  if (days === 0) return `Today, ${time}`
  if (days === 1) return `Yesterday, ${time}`
  return t.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

function metaText(it) {
  if (it.state === 'gone') return 'File moved or deleted'
  if (it.state === 'cleaning') return `Cleaning… ${Math.floor((lib.live?.frac || 0) * 100)}%`
  // When and where from, like old Naqi's library (the format would be cut off at this width)
  return [when(it.added), it.state === 'again' ? 'Cleans again when played' : it.from].join(' · ')
}

function tipText(it) {
  if (it.state === 'gone') return 'The cleaned file was moved or deleted. Remove it, or clean it again from Home.'
  if (it.state === 'again') return 'Its cleaned sound was tidied away after 2 weeks. It is cleaned again when you play it.'
  return it.source
}

function rowEl(it) {
  const li = document.createElement('li')
  li.dataset.id = it.id
  li.innerHTML = `
    <button class="lib-row">
      <span class="lib-thumb"></span>
      <span class="lib-text"><span class="lib-title" dir="auto"></span><span class="lib-meta"></span></span>
      <span class="btn btn-play" role="button" aria-label="Play" data-act="play">${icon('play')}</span>
    </button>
    <div class="lib-actions"><div>
      <button class="btn btn-quiet btn-sm" data-act="next" tabindex="-1">${icon('queue', 'icon-sm')}Add to Up next</button>
      <button class="btn btn-quiet btn-sm" data-act="show" tabindex="-1">${icon('folder', 'icon-sm')}Show in folder</button>
      <button class="btn btn-quiet btn-sm btn-danger" data-act="remove" tabindex="-1">${icon('trash', 'icon-sm')}Remove</button>
    </div></div>`
  const rating = rateEl((value) => rateItem(it.id, value))
  $('.lib-actions > div', li).prepend(rating)
  $('.lib-row', li).addEventListener('click', (e) => {
    if (e.target.closest('[data-act="play"]')) return play(it.id)
    pick(it.id)
  })
  $('.lib-row', li).addEventListener('dblclick', (e) => { if (!e.target.closest('[data-act="play"]')) play(it.id) })
  $('[data-act="next"]', li).addEventListener('click', () => window.dispatchEvent(new CustomEvent('naqi-queue', { detail: { id: it.id } })))
  $('[data-act="show"]', li).addEventListener('click', () => window.naqi.showInFolder(itemOf(it.id)?.show))
  $('[data-act="remove"]', li).addEventListener('click', () => remove(it.id))
  return li
}

function fill(li, it) {
  const row = $('.lib-row', li)
  row.dataset.kind = it.kind
  row.dataset.gone = it.state === 'gone'
  row.title = tipText(it)
  const glyph = it.state === 'gone' ? 'warning' : it.kind
  const thumb = $('.lib-thumb', row)
  if (thumb.dataset.glyph !== glyph) { thumb.innerHTML = icon(glyph); thumb.dataset.glyph = glyph }
  $('.lib-title', row).textContent = it.title
  const meta = $('.lib-meta', row)
  meta.textContent = metaText(it)
  meta.dataset.state = it.state
  let bar = $('.lib-progress', li)
  if (it.state === 'cleaning' && !bar) {
    bar = document.createElement('span')
    bar.className = 'lib-progress'
    li.append(bar)
  } else if (it.state !== 'cleaning' && bar) bar.remove()
  bar?.style.setProperty('--p', lib.live?.frac || 0)
  const rating = $('.rate', li)
  rating.hidden = it.state === 'cleaning'   // rated once it is clean
  showRating(rating, it.rating)
  $('[data-act="play"]', li).hidden = it.state === 'gone'
  $('[data-act="next"]', li).hidden = it.state === 'gone'
  $('[data-act="show"]', li).hidden = !it.show
  $('[data-act="remove"]', li).hidden = it.state === 'cleaning'   // cancel it first (Home)
  $('[data-act="remove"]', li).title = 'Take it out of the library. Saved files stay where they are.'
}

const itemOf = (id) => lib.items.find((it) => it.id === id)
export const item = itemOf

function play(id) {
  const it = itemOf(id)
  if (!it || it.state === 'gone') return
  lib.picked = id
  mark()
  window.dispatchEvent(new CustomEvent('naqi-play', { detail: { id } }))
}

// Rows are kept by id: new ones slide in, the rest stay still (so the light and an open row do not jump)
function draw() {
  const all = lib.items.filter((it) => !lib.leaving.has(it.id))
  const shown = all.filter(matches)
  const rows = new Map($$('li[data-id]', list).map((li) => [Number(li.dataset.id), li]))
  for (const [id, li] of rows) if (!all.some((it) => it.id === id) && !li.classList.contains('is-leaving')) li.remove()
  for (const it of all) {
    let li = rows.get(it.id)
    if (!li) {
      li = rowEl(it)
      sizes.observe(li)
      if (lib.drawn) li.classList.add('is-new')
    }
    fill(li, it)
    li.hidden = !shown.includes(it)
    list.append(li)   // in order, newest first
  }
  lib.drawn = true
  if (lib.picked && !shown.some((it) => it.id === lib.picked)) lib.picked = null
  const narrowed = filtering()
  $('#lib-count').textContent = narrowed ? `${shown.length} of ${all.length}` : all.length
  $('#lib-count').hidden = !all.length
  $('#lib-empty').hidden = all.length > 0
  $('#lib-find').hidden = !all.length
  filterToggle.dataset.on = Object.values(lib.f).some(Boolean)
  $('#lib-filter-clear').hidden = !Object.values(lib.f).some(Boolean)
  $('#lib-none').hidden = !(all.length && !shown.length)
  if (all.length && !shown.length) $('#lib-none-text').textContent = noneText()
  list.hidden = !shown.length
  mark()
  drawCont()
}

// ---------- Continue watching (T13.4, SPEC R48) ----------
// at > 0: the engine kept where it stopped (it is 0 again once finished). Hidden while searching or filtering, so the
// narrowed list is the only answer shown.
const CONT_MAX = 3
const cont = $('#cont')
const contList = $('#cont-list')
const leftText = (it) => {
  const m = Math.ceil((it.length - it.at) / 60)
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min left` : `${m} min left`
}
function contRow(it) {
  const li = document.createElement('li')
  li.dataset.id = it.id
  li.innerHTML = `<button class="lib-row cont-row"><span class="cont-shot"><span class="cont-play">${icon('play')}</span></span>
    <span class="lib-text"><span class="lib-title" dir="auto"></span><span class="lib-meta"></span></span></button>`
  $('button', li).addEventListener('click', () => play(it.id))
  return li
}
function drawCont() {
  const items = lib.items
    .filter((it) => it.at > 0 && it.length > 0 && !lib.leaving.has(it.id) && (it.state === 'ready' || it.state === 'again'))
    .sort((a, b) => (b.watched || '').localeCompare(a.watched || ''))
    .slice(0, CONT_MAX)
  const rows = new Map($$('li', contList).map((li) => [Number(li.dataset.id), li]))
  for (const [id, li] of rows) if (!items.some((it) => it.id === id)) li.remove()
  for (const it of items) {
    let li = rows.get(it.id)
    if (!li) { li = contRow(it); if (lib.drawn) li.classList.add('is-new') }
    const row = $('button', li)
    row.dataset.kind = it.kind
    row.title = `${it.title}
Plays on from ${clock(it.at)}`
    $('.lib-title', li).textContent = it.title
    $('.lib-meta', li).textContent = it.state === 'again' ? `${leftText(it)} · cleans again` : leftText(it)
    const shot = $('.cont-shot', li)
    shot.style.setProperty('--p', Math.min(1, it.at / it.length))
    let img = $('img', shot)
    // The picture of that moment, or the row's sign (a sound, or a picture the page could not read)
    const glyph = it.shot ? '' : it.kind
    if (shot.dataset.glyph !== glyph) {
      $('.cont-glyph', shot)?.remove()
      if (glyph) shot.insertAdjacentHTML('beforeend', icon(glyph, 'cont-glyph'))
      shot.dataset.glyph = glyph
    }
    if (it.shot) {
      if (!img) { img = document.createElement('img'); img.alt = ''; shot.prepend(img) }
      if (img.getAttribute('src') !== it.shot) img.src = it.shot
    } else img?.remove()
    contList.append(li)
  }
  cont.hidden = !items.length || filtering()
}
const clock = (s) => {
  s = Math.floor(s)
  const h = Math.floor(s / 3600)
  const mm = String(Math.floor((s % 3600) / 60))
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${mm.padStart(2, '0')}:${ss}` : `${mm}:${ss}`
}
// Local time as the engine writes it (2026-11-27T14:03:05), so the two sort together
const localNow = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19) }
// The player kept a new place: the group follows at once
window.addEventListener('naqi-position', (e) => {
  const it = itemOf(e.detail.id)
  if (!it) return
  Object.assign(it, { at: e.detail.at, length: e.detail.length, shot: e.detail.shot, watched: localNow() })
  drawCont()
})

// The picked row: aria-current, its actions open, the light follows it (and its height while the actions open)
function mark() {
  for (const li of $$('li[data-id]', list)) {
    const on = Number(li.dataset.id) === lib.picked
    if (on) $('.lib-row', li).setAttribute('aria-current', 'true')
    else $('.lib-row', li).removeAttribute('aria-current')
    li.dataset.open = on
    $$('.lib-actions button', li).forEach((b) => { b.tabIndex = on ? 0 : -1 })
  }
  placeLight()
}

function placeLight() {
  const li = $(`li[data-id="${lib.picked}"]`, list)
  light.style.opacity = li ? 1 : 0
  if (!li) return
  light.style.transform = `translateY(${li.offsetTop}px)`
  light.style.height = `${li.offsetHeight}px`
}
const sizes = new ResizeObserver(placeLight)   // rows grow while their actions open

function pick(id) {
  lib.picked = lib.picked === id ? null : id   // a second click closes it again
  mark()
}

// Up / Down move between rows, Enter picks a row and plays the picked one, Escape closes it, Delete removes it
list.addEventListener('keydown', (e) => {
  const rows = $$('li[data-id]:not(.is-leaving):not([hidden]) .lib-row', list)
  const i = rows.indexOf(document.activeElement)
  const id = i >= 0 ? Number(rows[i].closest('li').dataset.id) : null
  if (e.key === 'ArrowUp' && i === 0 && !$('#lib-find').hidden) {
    e.preventDefault()
    search.focus()   // Up from the first row goes back to the search box
  } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && i >= 0) {
    e.preventDefault()
    rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))].focus()
  } else if (e.key === 'Enter' && id !== null && lib.picked === id) {
    e.preventDefault()
    play(id)
  } else if (e.key === 'Escape' && id !== null && lib.picked === id) {
    e.preventDefault()
    pick(id)
  } else if (e.key === 'Delete' && lib.picked && itemOf(lib.picked)?.state !== 'cleaning') {
    remove(lib.picked)
  }
})

// Rating: shown at once, saved by the engine; put back if that fails
async function rateItem(id, value) {
  const it = itemOf(id)
  if (!it) return
  const before = it.rating
  it.rating = value
  draw()
  try { await rate(id, value) } catch (e) {
    it.rating = before
    draw()
    undoToast(null, 'Rating not saved', cleanError(e), 'Library, rating')
  }
}
onRated(({ id, rating }) => {
  const it = itemOf(id)
  if (it && it.rating !== rating) { it.rating = rating; draw() }
})

// Remove: the row folds away now; the engine deletes it after the Undo time
function remove(id) {
  const it = itemOf(id)
  const li = $(`li[data-id="${id}"]`, list)
  if (!it || !li || lib.leaving.has(id)) return
  if (lib.picked === id) lib.picked = null
  li.classList.add('is-leaving')
  li.addEventListener('animationend', () => { li.remove(); placeLight() }, { once: true })
  const finish = async () => {
    lib.leaving.delete(id)
    window.dispatchEvent(new CustomEvent('naqi-removed', { detail: { id } }))
    try { await window.naqi.removeFromLibrary(id) } catch (e) { undoToast(null, 'Could not remove it', cleanError(e), 'Library, Remove') }
    load()
  }
  lib.leaving.set(id, setTimeout(finish, UNDO_MS))
  draw()
  undoToast(() => {
    clearTimeout(lib.leaving.get(id))
    lib.leaving.delete(id)
    draw()
  }, `${it.title} removed`, it.show ? 'The saved file stays in its folder.' : 'Your own files are never touched.')
}

const cleanError = (e) => e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

function undoToast(undo, title, text, where = '') {
  const t = document.createElement('div')
  t.className = 'msg toast'
  if (!undo) t.dataset.kind = 'error'
  t.innerHTML = `${icon(undo ? 'trash' : 'error')}<div><p class="msg-title"></p><p class="msg-text"></p></div>`
  $('.msg-title', t).textContent = title
  $('.msg-text', t).textContent = text
  if (where) $('.msg-text', t).after(detailsButton({ where, title, text }))
  const leave = () => {
    if (t.classList.contains('is-leaving')) return
    t.classList.add('is-leaving')
    t.addEventListener('transitionend', () => t.remove(), { once: true })
  }
  if (undo) {
    const b = document.createElement('button')
    b.className = 'btn btn-ghost btn-sm'
    b.textContent = 'Undo'
    b.addEventListener('click', () => { undo(); leave() })
    t.append(b)
  } else t.append(document.createElement('span'))
  $('#toasts').append(t)
  setTimeout(leave, undo ? UNDO_MS - 200 : 3600)
}

// ---------- Keeping it current ----------
let loading = null
export async function load() {
  if (loading) return loading
  loading = (async () => {
    try {
      lib.items = (await window.naqi.library()).items
      draw()
      window.dispatchEvent(new CustomEvent('naqi-library'))   // Up next follows (queue.js)
    } catch { /* engine not up yet: it loads when the engine is ready */ }
  })()
  try { await loading } finally { loading = null }
}

export function select(id) {
  lib.picked = id
  mark()
  $(`li[data-id="${id}"]`, list)?.scrollIntoView({ block: 'nearest' })
}

window.naqi.onEngineStatus((s) => { if (s.status === 'ready') load() })
const aheadJobs = new Set()
window.addEventListener('naqi-ahead-job', (e) => aheadJobs.add(e.detail.id))
window.naqi.onJob((j) => {
  if (j.kind === 'play' && j.state === 'running' && j.row_id) {
    const first = lib.live?.row_id !== j.row_id
    lib.live = { row_id: j.row_id, frac: j.frac }
    if (first || !itemOf(j.row_id)) return load()   // its row exists now: it shows as "Cleaning…"
    const it = itemOf(j.row_id)
    const li = $(`li[data-id="${j.row_id}"]`, list)
    if (it && li) fill(li, it)
  } else if (j.state !== 'running') {
    lib.live = null
    // A cleaning ahead for Up next (T13.8) ends in the background: the picked row stays
    const ahead = aheadJobs.delete(j.id)
    load().then(() => { if (j.kind === 'play' && j.state === 'done' && j.row_id && !ahead) select(j.row_id) })
  }
})
// Files moved or deleted outside Naqi show as gone when the window comes back
window.addEventListener('focus', () => load())
