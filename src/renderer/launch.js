// Launch intro (once per start, launch.css): starts when the window is really on screen (it opens hidden until its
// first paint), then hands off to Home by flying its logo or line onto the same one on the page. The page under it is
// live the whole time; a click or a key ends the intro at once.
// Yassine chose the ring (2026-11-23, SPEC R35). The others stay to switch to one day: NAQI_INTRO=wave (the page's
// own markup, his first liked one) | sweep | headline. The ring holds a moment (hold, ms) once it is whole.
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches

const bars = (list, attr) => list.map(([h, m], i) => `<i${m ? ' class="is-music"' : ''} style="--h:${h};${attr(i)}"></i>`).join('')
const SWEEP = Array.from({ length: 31 }, (_, i) => [[0.35, 0.6, 0.95, 0.45, 0.75, 1, 0.5, 0.3][i % 8], [2, 5, 9, 12, 16, 20, 23, 27].includes(i)])
const RING = Array.from({ length: 28 }, (_, i) => [[0.55, 0.8, 0.45, 1, 0.65, 0.4, 0.9][i % 7], i % 4 === 1])
const HEAD = ['The', 'music', 'goes.', 'Every', 'word', 'stays.']
const BRAND = '<img alt="" /><div class="brand-name">Naqi <span class="ar" lang="ar">نقي</span></div>'

// cue: the entrance whose end starts the hand-off; fly: what moves; from / to: the matching pieces it lines up;
// hold: a still moment before the hand-off; also: more pieces that fly at the same time
const VARIANTS = {
  wave: { cue: '.launch-brand', fly: '.launch-brand', from: '.launch-brand img', to: '.side .brand img' },
  sweep: {
    html: `<span class="launch-wave">${bars(SWEEP, (i) => `--i:${i}`)}<span class="launch-scan"></span></span>
      <div class="brand launch-brand">${BRAND}</div>`,
    cue: '.launch-brand', fly: '.launch-brand', from: '.launch-brand img', to: '.side .brand img', hide: true
  },
  ring: {
    html: `<div class="launch-ring">${RING.map(([h, m], k) => `<b${m ? ' class="is-music"' : ''} style="--ang:${k * (360 / RING.length)}deg;--k:${k};--h:${h}"><i></i></b>`).join('')}
      <img alt="" /></div>
      <div class="brand-name launch-name">Naqi <span class="ar" lang="ar">نقي</span></div>`,
    cue: '.launch-name', fly: '.launch-ring img', from: '.launch-ring img', to: '.side .brand img', hide: true, hold: 220,
    also: [{ fly: '.launch-name', from: '.launch-name', to: '.side .brand .brand-name', line: true }]
  },
  headline: {
    html: `<h1 class="launch-head">${HEAD.map((w, i) => `<span${i > 2 ? ' class="keep"' : ''} style="--w:${i}">${w}</span>`).join(' ')}</h1>
      <span class="launch-wave">${bars([[0.3, 0], [0.55, 0], [0.95, 1], [0.4, 0], [0.7, 0], [1, 1], [0.5, 0], [0.85, 0], [0.45, 0], [0.9, 1], [0.6, 0], [0.35, 0], [1, 1], [0.5, 0], [0.25, 0]], (i) => `--d:${Math.abs(i - 7)}`)}</span>`,
    cue: '.launch-head span:last-child', fly: '.launch-head', from: '.launch-head', to: 'main.home .headline', hide: true, line: true
  }
}

export function setupLaunch() {
  const el = document.getElementById('launch')
  if (!el) return
  const asked = new URLSearchParams(location.search).get('intro')
  const name = VARIANTS[asked] ? asked : 'ring'
  const v = VARIANTS[name]
  if (v.html) {
    el.dataset.variant = name
    el.querySelector('.launch-stage').innerHTML = v.html
    // The build renames the logo file; take its real address from the page's own logo
    const logo = document.querySelector('.side .brand img').getAttribute('src')
    for (const img of el.querySelectorAll('img')) img.setAttribute('src', logo)
  }
  const pace = parseFloat(getComputedStyle(el).getPropertyValue('--lt')) || 1   // launch.css's pace knob
  let gone = false
  const hidden = []
  const done = () => {
    if (gone) return
    gone = true
    for (const node of hidden) node.style.visibility = ''
    el.remove()
  }
  const go = () => { if (!el.classList.contains('is-go')) requestAnimationFrame(() => el.classList.add('is-go')) }
  const skip = () => { el.classList.add('is-skip'); setTimeout(done, 140) }
  addEventListener('pointerdown', skip, { once: true, capture: true })
  addEventListener('keydown', skip, { once: true, capture: true })

  el.addEventListener('animationend', (e) => {
    if (e.target.matches(v.cue) && e.animationName === 'launch-brand-in') setTimeout(leave, 60 * pace + (v.hold || 0))
  })
  if (document.visibilityState === 'visible') go()
  else document.addEventListener('visibilitychange', go, { once: true })
  setTimeout(go, 1200)                      // never stays on the first frame
  setTimeout(done, 3000)                    // never stays at all
  if (reduce) setTimeout(leave, 400)        // no flight: the whole intro fades

  function leave() {
    if (gone || el.classList.contains('is-leaving')) return
    el.classList.add('is-leaving')
    // Each flight lines up one piece of the intro with the same piece on the page (the ring: logo and name); it leaves
    // at once and settles softly (the drawer curve), so nothing still sits in the middle when Home shows
    const flights = [v, ...(v.also || [])].map((f) => {
      const fly = el.querySelector(f.fly)
      const target = document.querySelector(f.to)
      const to = target?.getBoundingClientRect()
      const size = (node) => parseFloat(getComputedStyle(node).fontSize)
      // A headline that wraps on a narrow window would not land on one line: it fades instead
      const lands = to && to.width && !(f.line && to.height > size(target) * 1.6)
      return { f, fly, target, to, lands, scale: lands && (f.line ? size(target) / size(fly) : null) }
    })
    if (reduce || flights.some((x) => !x.lands)) {
      for (const { fly } of flights) fly.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: 'ease-out', fill: 'forwards' })
      setTimeout(done, 340)
      return
    }
    const landed = flights.map(({ f, fly, target, to, scale }) => {
      const box = fly.getBoundingClientRect()
      const from = el.querySelector(f.from).getBoundingClientRect()
      if (v.hide) { hidden.push(target); target.style.visibility = 'hidden' }
      fly.style.transformOrigin = `${from.left - box.left}px ${from.top - box.top}px`
      return fly.animate([
        { transform: 'none' },
        { transform: `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${scale || to.height / from.height})` }
      ], { duration: 340 * pace, easing: 'cubic-bezier(0.32, 0.72, 0, 1)', fill: 'forwards' }).finished
    })
    Promise.all(landed).then(done, done)
  }
}
