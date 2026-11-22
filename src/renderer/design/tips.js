// Tooltips (data-tip, components.css) wait a moment before the first one shows, so passing over a button does not
// flash one. Once one has shown, the next ones along a row of buttons show at once (html.tips-warm), until the
// pointer has been away from every tip for a little while.
const WAIT_MS = 450
const COOL_MS = 600

export function setupTips() {
  const root = document.documentElement
  let showing = null
  let cooling = null
  document.addEventListener('pointerover', (e) => {
    const el = e.target.closest?.('[data-tip]')
    if (!el) return
    clearTimeout(cooling)
    clearTimeout(showing)
    showing = setTimeout(() => root.classList.add('tips-warm'), WAIT_MS)
  })
  document.addEventListener('pointerout', (e) => {
    const el = e.target.closest?.('[data-tip]')
    if (!el || el.contains(e.relatedTarget)) return
    clearTimeout(showing)
    cooling = setTimeout(() => root.classList.remove('tips-warm'), COOL_MS)
  })
}
