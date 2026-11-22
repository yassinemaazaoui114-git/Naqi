// The theme button: System / Light / Dark. The page flips its own colours at once (`data-theme` on <html>, read by
// tokens.css); the choice also goes to Electron (nativeTheme) for the Windows title bar and the next start.
// Waiting for Electron's colour-scheme event inside the circle stalled each switch: a view transition pauses the
// page's rendering, so that event only came after a timeout.
// The new theme opens as a circle from the clicked button (View Transitions API); with reduced motion it just swaps.

const reduce = window.matchMedia('(prefers-reduced-motion: reduce)')
const MODES = ['system', 'light', 'dark']

function setPageTheme(mode) {
  if (mode === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = mode
}

async function apply(mode, from) {
  const change = () => {
    setPageTheme(mode)
    window.naqi.setTheme(mode).catch(() => {})
  }
  if (!document.startViewTransition || reduce.matches || !from) return change()
  const r = from.getBoundingClientRect()
  const x = r.left + r.width / 2
  const y = r.top + r.height / 2
  const root = document.documentElement.style
  root.setProperty('--vt-x', `${x}px`)
  root.setProperty('--vt-y', `${y}px`)
  root.setProperty('--vt-r', `${Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))}px`)
  // The circle is only a nicety: if it gives up (the colours took too long to arrive), the new theme still applies
  const vt = document.startViewTransition(change)
  vt.ready.catch(() => {})
  vt.updateCallbackDone.catch(() => {})
  await vt.finished.catch(() => {})
}

// seg: a .seg element with three buttons carrying data-mode="system|light|dark".
export async function setupThemeButton(seg) {
  const buttons = [...seg.querySelectorAll('button[data-mode]')]
  seg.setAttribute('role', 'radiogroup')
  seg.style.setProperty('--n', buttons.length)
  const show = (mode) => {
    buttons.forEach((b, i) => {
      const on = b.dataset.mode === mode
      b.setAttribute('role', 'radio')
      b.setAttribute('aria-checked', on)
      if (on) seg.style.setProperty('--i', i)
    })
  }
  const saved = await window.naqi.getTheme()
  let current = MODES.includes(saved) ? saved : 'system'
  setPageTheme(current)
  show(current)
  for (const b of buttons) {
    b.addEventListener('click', () => {
      if (b.dataset.mode === current) return
      current = b.dataset.mode
      show(current)
      apply(current, b)
    })
  }
}
