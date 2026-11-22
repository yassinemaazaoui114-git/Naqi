// Library side bar (ROADMAP T3.1): every cleaned file from the history, newest first (engine/library.py gives the
// items with old Naqi's rules). Clicking a row picks it: one light slides to it and its actions open under it
// (its rating, Show in folder, Remove). Its round Play button (or a double click) plays it (T4.1: a 'naqi-play' event,
// main.js decides how). Remove waits a few seconds with an Undo, then
// the engine deletes the row and Naqi's own kept copy; saved files and own files are never touched.
import { icon } from './design/icons.js'
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
  drawn: false         // after the first draw, new rows slide in
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
  const shown = lib.items.filter((it) => !lib.leaving.has(it.id))
  const rows = new Map($$('li[data-id]', list).map((li) => [Number(li.dataset.id), li]))
  for (const [id, li] of rows) if (!shown.some((it) => it.id === id) && !li.classList.contains('is-leaving')) li.remove()
  for (const it of shown) {
    let li = rows.get(it.id)
    if (!li) {
      li = rowEl(it)
      sizes.observe(li)
      if (lib.drawn) li.classList.add('is-new')
    }
    fill(li, it)
    list.append(li)   // in order, newest first
  }
  lib.drawn = true
  if (lib.picked && !shown.some((it) => it.id === lib.picked)) lib.picked = null
  $('#lib-count').textContent = shown.length
  $('#lib-count').hidden = !shown.length
  $('#lib-empty').hidden = shown.length > 0
  list.hidden = !shown.length
  mark()
}

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
  const rows = $$('li[data-id]:not(.is-leaving) .lib-row', list)
  const i = rows.indexOf(document.activeElement)
  const id = i >= 0 ? Number(rows[i].closest('li').dataset.id) : null
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && i >= 0) {
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
    undoToast(null, 'Rating not saved', cleanError(e))
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
    try { await window.naqi.removeFromLibrary(id) } catch (e) { undoToast(null, 'Could not remove it', cleanError(e)) }
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

function undoToast(undo, title, text) {
  const t = document.createElement('div')
  t.className = 'msg toast'
  if (!undo) t.dataset.kind = 'error'
  t.innerHTML = `${icon(undo ? 'trash' : 'error')}<div><p class="msg-title"></p><p class="msg-text"></p></div>`
  $('.msg-title', t).textContent = title
  $('.msg-text', t).textContent = text
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
    load().then(() => { if (j.kind === 'play' && j.state === 'done' && j.row_id) select(j.row_id) })
  }
})
// Files moved or deleted outside Naqi show as gone when the window comes back
window.addEventListener('focus', () => load())
