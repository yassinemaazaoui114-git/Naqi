const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]

// Segmented choices (Home's Options, the report's Problem). seg: .seg with buttons carrying data-value. Returns { value(), set(values?, value) }.
export function seg(el, onPick) {
  const draw = (value) => {
    const buttons = $$('button', el)
    el.setAttribute('role', 'radiogroup')
    el.style.setProperty('--n', buttons.length)
    let i = buttons.findIndex((b) => b.dataset.value === value)
    if (i < 0) i = 0
    buttons.forEach((b, j) => { b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', i === j); b.tabIndex = i === j ? 0 : -1 })
    el.style.setProperty('--i', i)
    return buttons[i]?.dataset.value
  }
  let current = null
  const api = {
    value: () => current,
    set(values, value) {
      if (values) el.innerHTML = values.map((v) => `<button data-value="${v}">${v}</button>`).join('')
      current = draw(value)
    },
    disable(off) { $$('button', el).forEach((b) => { b.disabled = off }) }
  }
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button')
    if (!b || b.disabled || b.dataset.value === current) return
    current = draw(b.dataset.value)
    onPick(current)
  })
  el.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    const buttons = $$('button', el)
    const i = (buttons.findIndex((b) => b.dataset.value === current) + step + buttons.length) % buttons.length
    current = draw(buttons[i].dataset.value)
    buttons[i].focus()
    onPick(current)
  })
  return api
}
