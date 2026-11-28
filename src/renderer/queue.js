// Up next (ROADMAP T13.8, SPEC R50): a queue of library items and links at the top of the library, under Continue
// watching. Library rows and Home's link box have Add to Up next. When a video ends, a small card on the
// picture says "Up next" and plays it after 5 s (Play now, Cancel). main.js cleans the first one ahead as soon as the
// engine is free (the playing item is clean), so it is usually ready when its turn comes. Kept in settings.json.
// An entry: { key, id } for a library item, or { key, url } for a link not cleaned yet (it gets its id once its
// cleaning makes its row). held: its cleaning ahead was cancelled or failed, it cleans when its turn comes.
import { icon } from './design/icons.js'
import * as library from './library.js'

const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]

const NEXT_MS = 5000
const MAX = 50
const box = $('#upnext')
const list = $('#upnext-list')
const q = {
  entries: [],
  frac: new Map(),   // key -> part cleaned of the one cleaned ahead
  save: () => {},
  play: () => {},    // play(entry): main.js
  changed: () => {}, // the first one may need cleaning ahead
  drawn: false
}

export function setupQueue({ saved, save, play, changed }) {
  Object.assign(q, { save, play, changed })
  try {
    q.entries = (JSON.parse(saved || '[]') || []).filter((e) => e && (Number.isInteger(e.id) || typeof e.url === 'string'))
      .map((e) => ({ key: e.key || (e.url ? `u${e.url}` : `i${e.id}`), id: e.id ?? null, url: e.url || null }))
  } catch { q.entries = [] }
  draw()
}

export const first = () => q.entries[0] || null
export const entries = () => q.entries
export const has = (id) => q.entries.some((e) => e.id === id)

function store() {
  // held is not kept: after a restart each one may be cleaned ahead again
  q.save(JSON.stringify(q.entries.map(({ key, id, url }) => ({ key, id, url }))))
  draw()
  q.changed()
}

// Adds at the end; an item or link already waiting is not added twice
export function add({ id = null, url = null }) {
  if (q.entries.length >= MAX) return 'full'
  if (q.entries.some((e) => (id !== null && e.id === id) || (url && e.url === url))) return 'there'
  q.entries.push({ key: url ? `u${url}` : `i${id}`, id, url })
  store()
  return 'added'
}

export function drop(key) {
  const before = q.entries.length
  q.entries = q.entries.filter((e) => e.key !== key)
  q.frac.delete(key)
  if (q.entries.length !== before) store()
}
export const dropItem = (id) => { for (const e of q.entries.filter((e) => e.id === id)) drop(e.key) }

export function clear() { q.entries = []; q.frac.clear(); store() }

// The cleaning ahead made its row (a link), or its row is gone again (a link's cleaning cancelled or failed)
export function setId(key, id) {
  const e = q.entries.find((e) => e.key === key)
  if (!e || e.id === id) return
  e.id = id
  store()
}
export function hold(key, why) {
  const e = q.entries.find((e) => e.key === key)
  if (!e) return
  e.held = why
  if (e.url) e.id = null
  q.frac.delete(key)
  store()
}
// Made way for something started by hand: not held (it is cleaned ahead again), a link's row went with its cleaning
export function reset(key) {
  const e = q.entries.find((e) => e.key === key)
  if (!e) return
  if (e.url) e.id = null
  q.frac.delete(key)
  store()
}
export function progress(key, frac) {
  if (frac === null) q.frac.delete(key)
  else q.frac.set(key, frac)
  draw()
}

// ---------- The list ----------
const linkText = (url) => {
  try { const u = new URL(url); return `${u.hostname.replace(/^www\./, '')}${u.pathname.length > 1 ? u.pathname : ''}${u.search}` } catch { return url }
}
function textOf(e) {
  const it = e.id !== null ? library.item(e.id) : null
  const title = it?.title || linkText(e.url || '')
  let meta
  if (q.frac.has(e.key)) meta = `Cleaning ahead… ${Math.floor(q.frac.get(e.key) * 100)}%`
  else if (it?.state === 'gone') meta = 'File moved or deleted: skipped'
  else if (it?.state === 'ready') meta = 'Ready'
  else if (it?.state === 'cleaning') meta = 'Cleaning…'
  else if (e.held) meta = 'Cleans when its turn comes'
  else meta = 'Cleans as soon as Naqi is free'
  return { title, meta, kind: it?.kind || 'video', ready: it?.state === 'ready', tip: e.held && e.held !== true ? e.held : (it?.source || e.url || '') }
}

function rowEl(e) {
  const li = document.createElement('li')
  li.dataset.key = e.key
  li.innerHTML = `<button class="lib-row upnext-row"><span class="upnext-n num"></span>
      <span class="lib-text"><span class="lib-title" dir="auto"></span><span class="lib-meta"></span></span></button>
    <button class="btn btn-icon btn-sm upnext-x" aria-label="Take it out of Up next" data-tip="Take out">${icon('close', 'icon-sm')}</button>`
  $('.upnext-row', li).addEventListener('click', () => { const x = q.entries.find((y) => y.key === e.key); if (x) q.play(x) })
  $('.upnext-x', li).addEventListener('click', () => leave(li, e.key))
  return li
}

function leave(li, key) {
  li.classList.add('is-leaving')
  const go = () => { li.remove(); drop(key) }
  li.addEventListener('animationend', go, { once: true })
  setTimeout(() => { if (li.isConnected) go() }, 400)   // also when no frame is drawn
}

export function draw() {
  const rows = new Map($$('li[data-key]', list).map((li) => [li.dataset.key, li]))
  for (const [key, li] of rows) if (!q.entries.some((e) => e.key === key) && !li.classList.contains('is-leaving')) li.remove()
  q.entries.forEach((e, i) => {
    let li = rows.get(e.key)
    if (!li) { li = rowEl(e); if (q.drawn) li.classList.add('is-new') }
    const t = textOf(e)
    const row = $('.upnext-row', li)
    row.dataset.kind = t.kind
    row.dataset.ready = t.ready
    row.title = t.tip
    $('.upnext-n', li).textContent = i + 1
    $('.lib-title', li).textContent = t.title
    const meta = $('.lib-meta', li)
    meta.textContent = t.meta
    meta.dataset.state = q.frac.has(e.key) ? 'cleaning' : ''
    li.style.setProperty('--p', q.frac.get(e.key) || 0)
    li.dataset.cleaning = q.frac.has(e.key)
    list.append(li)
  })
  q.drawn = true
  box.hidden = !q.entries.length
  $('#upnext-count').textContent = q.entries.length
}
$('#upnext-clear').addEventListener('click', clear)
// A library item that is not there any more (removed while Naqi was closed) leaves Up next; a link only goes back to
// waiting as a link (its cleaning ahead ended without a row)
window.addEventListener('naqi-library', () => {
  const lost = q.entries.filter((e) => e.id !== null && !library.item(e.id) && !q.frac.has(e.key))
  if (!lost.length) return draw()
  q.entries = q.entries.filter((e) => !lost.includes(e) || e.url)
  for (const e of lost) if (e.url) e.id = null
  store()
})
window.addEventListener('naqi-removed', (e) => dropItem(e.detail.id))
// Library rows: Add to Up next
window.addEventListener('naqi-queue', (e) => {
  const r = add({ id: e.detail.id })
  window.dispatchEvent(new CustomEvent('naqi-queued', { detail: { result: r, title: library.item(e.detail.id)?.title || '' } }))
})

// ---------- The card when a video ends ----------
// On the picture (it moves with the picture into the corner). Play now plays at once, Cancel (or Escape) stays on the
// ended item; the one waiting stays first in Up next.
const card = $('#next-card')
let timer = 0
export function showNext(where) {
  const e = skipGone()
  if (!e) return false
  const t = textOf(e)
  $('#next-title').textContent = t.title
  $('#next-title').title = t.title
  $('#next-meta').textContent = t.ready ? 'Ready' : q.frac.has(e.key) ? 'Still cleaning: plays once its first part is clean' : 'Cleaned first, then it plays'
  where.append(card)
  card.hidden = false
  card.classList.remove('is-counting')
  void card.offsetWidth
  card.classList.add('is-counting')
  clearTimeout(timer)
  timer = setTimeout(() => playFirst(), NEXT_MS)
  return true
}
export function hideNext() {
  clearTimeout(timer)
  card.hidden = true
  card.classList.remove('is-counting')
}
export const nextShown = () => !card.hidden
function playFirst() {
  hideNext()
  const e = skipGone()
  if (e) q.play(e)
}
// Files moved or deleted cannot play: they leave Up next as their turn comes
function skipGone() {
  let gone = false
  while (q.entries[0] && q.entries[0].id !== null && library.item(q.entries[0].id)?.state === 'gone') { q.entries.shift(); gone = true }
  if (gone) store()
  return q.entries[0] || null
}
$('#next-now').addEventListener('click', playFirst)
$('#next-cancel').addEventListener('click', hideNext)
const cornerEl = $('#corner')
window.addEventListener('naqi-ended', (e) => { if (!e.detail.stop) showNext(cornerEl.hidden ? $('#screen') : cornerEl) })
window.addEventListener('naqi-player-play', hideNext)     // played again from the start
window.addEventListener('naqi-player-closed', hideNext)
// The card goes with the picture (the player or the corner)
window.addEventListener('naqi-page', (e) => { if (nextShown()) (e.detail.page === 'player' ? $('#screen') : cornerEl).append(card) })
