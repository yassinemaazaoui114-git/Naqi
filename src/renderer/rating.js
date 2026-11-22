// Ratings (ROADMAP T3.2, old SPEC R13): Bad / Good / Perfect on one cleaned file, saved in its history row. Shown in
// the job card after one "Clean and play" and in a picked library row; both stay in step through a 'naqi-rated' event.
// Bad opens "Report a slip" with the file filled in (main.js, T5.1).
import { icon } from './design/icons.js'

const CHOICES = [['bad', 'Bad', 'thumb-down'], ['good', 'Good', 'thumb-up'], ['perfect', 'Perfect', 'check']]

// The control: a radio group of three; onPick(value) runs when one is clicked
export function rateEl(onPick) {
  const el = document.createElement('div')
  el.className = 'rate'
  el.setAttribute('role', 'radiogroup')
  el.setAttribute('aria-label', 'How clean was it?')
  el.innerHTML = CHOICES.map(([value, label, glyph]) =>
    `<button role="radio" aria-checked="false" data-value="${value}" aria-label="Rate ${label}">${icon(glyph, 'icon-sm')}${label}</button>`).join('')
  for (const b of el.querySelectorAll('button')) b.addEventListener('click', () => onPick(b.dataset.value))
  return el
}

export function showRating(el, value) {
  for (const b of el.querySelectorAll('button')) b.setAttribute('aria-checked', b.dataset.value === value)
}

// Saves it; throws the engine's plain-words error. Everyone showing this item hears about it.
export async function rate(id, value) {
  const it = await window.naqi.rate(id, value)
  window.dispatchEvent(new CustomEvent('naqi-rated', { detail: { id, rating: it.rating } }))
  return it
}

export const onRated = (fn) => window.addEventListener('naqi-rated', (e) => fn(e.detail))
