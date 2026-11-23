// "Copy details" on an engine error (ROADMAP T10.3): puts the error, the time and the versions on the clipboard (the
// main process builds the text and leaves out anything private). The button says "Copied" for a moment, the copy
// icon turning into a check, so the click is seen to have worked.
import { icon } from './design/icons.js'

const COPIED_MS = 1800

// what = { where, title, text } or a function giving it at click time; small = icon only, with a tip
export function detailsButton(what, { small = false } = {}) {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = `btn btn-quiet btn-sm copy-details${small ? ' btn-icon' : ''}`
  b.setAttribute('aria-label', 'Copy details')
  if (small) b.dataset.tip = 'Copy details'
  const draw = (state) => {
    b.dataset.state = state
    const label = { copied: 'Copied', failed: 'Not copied' }[state] || 'Copy details'
    b.innerHTML = `${icon(state === 'copied' ? 'check' : 'copy', 'icon-sm')}${small ? '' : `<span>${label}</span>`}`
    if (small) b.dataset.tip = label
  }
  draw('')
  let timer = 0
  b.addEventListener('click', async () => {
    clearTimeout(timer)
    try {
      await window.naqi.copyDetails(typeof what === 'function' ? what() : what)
      draw('copied')
    } catch {
      draw('failed')
    }
    timer = setTimeout(() => draw(''), COPIED_MS)
  })
  return b
}
