// The library side bar folds away (T11.1, like Claude's): the button at its top or Ctrl+B folds it to a thin strip,
// and Naqi remembers it. Folded, a hover on the strip (on the window's left edge in theater) slides the library out
// over the page and leaving slides it back; the button in it pins it open again. Styles in home.css.
const $ = (s) => document.querySelector(s)
const body = document.body
const side = $('.side')
const toggle = $('#side-toggle')
const OPEN_MS = 400    // a mouse only passing over the strip does not open it (Yassine, 2026-11-26: 0.4 s)
const CLOSE_MS = 280   // nor does slipping off its edge for a moment close it
const FOLD_MS = 480    // home.css --fold-t, and a little more
let closed = false
let openTimer = 0
let closeTimer = 0
let foldTimer = 0
let save = () => {}

export const folded = () => closed || body.hasAttribute('data-theater')
export const peeking = () => body.hasAttribute('data-peek')

const setTip = (btn, text) => { btn.setAttribute('aria-label', text); btn.dataset.tip = text }

// instant: no motion (the remembered choice at start, and Ctrl+B: a key is pressed many times a day)
export function setClosed(on, { instant = false, remember = false } = {}) {
  closed = on
  clearTimeout(openTimer)
  clearTimeout(closeTimer)
  const pinned = peeking()   // pinned from the hover: already out, it only settles into its column
  body.removeAttribute('data-peek')   // not peek(false): pinned from the hover, the focus stays on its button
  if (instant) {
    body.setAttribute('data-instant', '')
    requestAnimationFrame(() => requestAnimationFrame(() => body.removeAttribute('data-instant')))
  } else folding(pinned ? '' : 'strip', !on && !pinned)
  if (on) body.dataset.side = 'closed'
  else body.removeAttribute('data-side')
  setTip(toggle, 'Hide the library (Ctrl+B)')
  if (remember) save(on)
  // The focus stays somewhere seen: on the strip's button when the library goes, on the library's when it comes
  const focus = document.activeElement
  if (on && side.contains(focus)) $('#rail-open').focus()
  else if (!on && focus === $('#rail-open')) toggle.focus()
}

export function peek(on) {
  clearTimeout(closeTimer)
  if (on && !folded()) return
  if (on === peeking()) return
  body.toggleAttribute('data-peek', on)
  if (closed) setTip(toggle, on ? 'Keep the library open (Ctrl+B)' : 'Hide the library (Ctrl+B)')
  // Hidden, the panel lets the keyboard go: nothing can be reached that cannot be seen
  if (!on && side.contains(document.activeElement)) document.activeElement.blur()
}

// One timer at a time: a mouse move cancels what the one before it planned (left running, an old "open" fired while
// the mouse was already on a button, and the "close" after it made the library flicker)
const soon = (on) => {
  clearTimeout(openTimer)
  clearTimeout(closeTimer)
  if (on) { if (!peeking()) openTimer = setTimeout(() => peek(true), OPEN_MS) }
  else if (peeking()) closeTimer = setTimeout(() => { if (!side.contains(document.activeElement)) peek(false) }, CLOSE_MS)
}

// how: 'strip' (the button: the strip grows into the library and back, home.css), '' (theater, player.js, narrows the
// column too: the library slides like a fold). rows: opening by the button, its parts come in one after another.
const ROWS_MAX = 8   // the rows after these come in with the last one
const ROWS_MS = 80 + ROWS_MAX * 28 + 280   // home.css side-row: the last one has arrived
function folding(how = '', rows = false) {
  body.setAttribute('data-folding', how)
  for (const el of side.querySelectorAll('[data-grow]')) el.removeAttribute('data-grow')
  if (rows) {
    const parts = [...side.querySelectorAll(':scope > :is(.side-head, .lib-find, .lib, .side-foot)')]
      .flatMap((el) => (el.matches('.lib') ? [...el.querySelectorAll(':scope > li[data-id]:not([hidden])')] : [el]))
      .filter((el) => !el.hidden)
    parts.forEach((el, i) => { el.dataset.grow = ''; el.style.setProperty('--n', Math.min(i, ROWS_MAX)) })
  }
  clearTimeout(foldTimer)
  foldTimer = setTimeout(() => {
    // Folded by the strip, the hidden library goes to its waiting place under the strip at once, not travelling there
    if (how === 'strip' && closed) {
      body.setAttribute('data-instant', '')
      requestAnimationFrame(() => requestAnimationFrame(() => body.removeAttribute('data-instant')))
    }
    body.removeAttribute('data-folding')
    for (const el of side.querySelectorAll('[data-grow]')) el.removeAttribute('data-grow')
  }, rows ? Math.max(FOLD_MS, ROWS_MS) : FOLD_MS)
}

export function setupSide({ closed: start, onSave }) {
  save = (on) => onSave(on ? 'closed' : 'open')
  setClosed(start, { instant: true })
  let theater = body.hasAttribute('data-theater')
  new MutationObserver(() => {
    if (body.hasAttribute('data-theater') === theater) return
    theater = !theater
    if (!peeking()) folding()
  }).observe(body, { attributes: true, attributeFilter: ['data-theater'] })

  toggle.addEventListener('click', () => setClosed(!closed, { remember: true }))
  $('#rail-open').addEventListener('click', () => setClosed(false, { remember: true }))
  $('#rail-search').addEventListener('click', () => {
    peek(true)
    const box = $('#lib-q')
    if (!$('#lib-find').hidden) { void getComputedStyle(side).visibility; box.focus() }
  })
  $('#rail-report').addEventListener('click', () => $('#open-report').click())
  $('#rail-settings').addEventListener('click', () => $('#open-settings').click())

  // The strip opens the library from anywhere on it but its own buttons (going for them, the list would cover
  // nothing, but it would be in the way of the eye)
  const rail = $('#rail')
  rail.addEventListener('pointermove', (e) => soon(!e.target.closest('[data-no-peek]') || peeking()))
  rail.addEventListener('pointerleave', () => { clearTimeout(openTimer); if (peeking()) soon(false) })
  const edge = $('#side-edge')
  edge.addEventListener('pointerenter', () => soon(true))
  edge.addEventListener('pointerleave', () => { clearTimeout(openTimer); if (peeking()) soon(false) })
  side.addEventListener('pointerenter', () => clearTimeout(closeTimer))
  side.addEventListener('pointerleave', () => { if (peeking()) soon(false) })
  // The focus going to the strip (Search pressed again) is not leaving: closed there, the click opened it again
  side.addEventListener('focusout', (e) => {
    if (peeking() && !side.contains(e.relatedTarget) && !rail.contains(e.relatedTarget) && !side.matches(':hover')) peek(false)
  })
  // A press on the page, a page change (a row picked, Report a slip) or Escape puts it away
  document.addEventListener('pointerdown', (e) => {
    if (peeking() && !side.contains(e.target) && !rail.contains(e.target)) peek(false)
  }, true)
  window.addEventListener('naqi-page', () => peek(false))
  side.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !peeking() || e.defaultPrevented) return   // the search box and a picked row use it first
    e.preventDefault()
    peek(false)
    if (closed) $('#rail-open').focus()
  })

  document.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'b' || document.fullscreenElement) return
    e.preventDefault()
    // In theater the column stays closed: Ctrl+B shows or hides the library over the player instead
    if (body.hasAttribute('data-theater')) peek(!peeking())
    else setClosed(!closed, { instant: true, remember: true })
  })
}
