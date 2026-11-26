// The pages of the content column (Home, the player, Report a slip, Settings): one is shown at a time, in the same place.
// They sit on one line, Home first: a page further along (the player, then the report) slides in from the right,
// going back slides in from the left, so the window always says which way you went (home.css). A change made with
// the keyboard (Escape) swaps at once: something done many times a day should not wait for motion.
// Everyone hears about a change through a 'naqi-page' event.
const PAGES = { home: '.home', player: '#watch', report: '#report', settings: '#settings' }
const DEPTH = { home: 0, player: 1, report: 2, settings: 3 }
let current = 'home'

export const shown = () => current

// detail: extra fields for the 'naqi-page' event (the player sends its item's id). instant: no motion.
export function show(name, detail = {}, { instant = false } = {}) {
  if (name === current) return
  const way = DEPTH[name] > DEPTH[current] ? 'forward' : 'back'
  const leaving = document.querySelector(PAGES[current])
  current = name
  for (const [page, sel] of Object.entries(PAGES)) document.querySelector(sel).hidden = page !== name
  const el = document.querySelector(PAGES[name])
  el.classList.remove('is-entering')
  if (!instant) {
    el.dataset.way = way
    void el.offsetWidth
    el.classList.add('is-entering')
  }
  // Focus left on the page that went away would be lost: the new page takes it (each page names where)
  if (leaving.contains(document.activeElement) || document.activeElement === document.body) {
    el.querySelector('[data-autofocus]')?.focus({ preventScroll: true })
  }
  window.dispatchEvent(new CustomEvent('naqi-page', { detail: { page: name, instant, ...detail } }))
}
