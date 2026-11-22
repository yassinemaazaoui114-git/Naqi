// The design sheet's behaviour. Only demo data here: nothing talks to the engine.
import { hydrateIcons, icon, iconNames } from './design/icons.js'
import { setupThemeButton } from './design/theme.js'

const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]

// ---------- Colour swatches ----------
const SWATCHES = [
  ['--bg', 'Window'], ['--glass', 'Glass card'], ['--surface', 'Field, raised'], ['--sunken', 'Track, well'],
  ['--text', 'Text'], ['--muted', 'Second text'], ['--faint', 'Hints'], ['--border-strong', 'Lines'],
  ['--primary', 'Main action'], ['--clean', 'Clean, progress'], ['--clean-soft', 'Clean, soft'],
  ['--brand', 'Brand'], ['--brand-soft', 'Brand, soft'], ['--warn', 'CPU only, careful'], ['--danger', 'Error, Bad']
]
$('#swatches').innerHTML = SWATCHES.map(([token, use]) => `
  <div class="swatch">
    <div class="swatch-chip" style="background: var(${token})"></div>
    <div class="swatch-text"><div class="swatch-name">${token.slice(2)}</div><div class="swatch-use">${use}</div></div>
  </div>`).join('')

// ---------- Segmented choices: --n and --i drive the sliding thumb ----------
function setupSeg(seg, onPick) {
  const buttons = $$('button', seg)
  seg.setAttribute('role', 'radiogroup')
  seg.style.setProperty('--n', buttons.length)
  const pick = (i) => {
    buttons.forEach((b, j) => { b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', i === j) })
    seg.style.setProperty('--i', i)
    onPick?.(buttons[i])
  }
  buttons.forEach((b, i) => b.addEventListener('click', () => pick(i)))
  seg.addEventListener('keydown', (e) => {
    const now = buttons.findIndex((b) => b.getAttribute('aria-checked') === 'true')
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    const next = (now + step + buttons.length) % buttons.length
    pick(next)
    buttons[next].focus()
  })
  pick(0)
}

// ---------- Library: one selection light slides to the picked row ----------
const lib = $('#lib')
const light = $('.lib-light', lib)
function moveLight(row) {
  const li = row.parentElement
  light.style.transform = `translateY(${li.offsetTop}px)`
  light.style.height = `${li.offsetHeight}px`
}
for (const row of $$('.lib-row', lib)) {
  row.addEventListener('click', () => {
    $$('.lib-row', lib).forEach((r) => r.removeAttribute('aria-current'))
    row.setAttribute('aria-current', 'true')
    moveLight(row)
  })
}

// ---------- Buttons ----------
const primary = $('#primary-demo')
primary.addEventListener('click', () => {
  const cancel = primary.classList.toggle('is-cancel')
  primary.innerHTML = cancel ? `${icon('close')}<span>Cancel</span>` : `${icon('play')}<span>Clean and play</span>`
})
const toggle = $('#toggle-demo')
toggle.addEventListener('click', () => toggle.setAttribute('aria-pressed', toggle.getAttribute('aria-pressed') !== 'true'))
for (const id of ['#play-demo', '#player-play']) {
  const b = $(id)
  b.addEventListener('click', () => {
    const on = b.getAttribute('aria-pressed') !== 'true'
    b.setAttribute('aria-pressed', on)
    b.setAttribute('aria-label', on ? 'Pause' : 'Play')
  })
}

// ---------- Volume sliders: the filled part follows the value ----------
for (const r of $$('.range')) {
  const show = () => r.style.setProperty('--v', r.value)
  r.addEventListener('input', show)
  show()
}

// ---------- Paste ----------
$('#paste').addEventListener('click', async () => {
  try { $('#link').value = (await navigator.clipboard.readText()).trim() } catch { /* clipboard not allowed */ }
  $('#link').focus()
})

// ---------- Drop zone: wakes up while files are dragged over the window ----------
const drop = $('#drop')
let dragDepth = 0
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; drop.dataset.state = 'drag' })
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; delete drop.dataset.state } })
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', (e) => {
  e.preventDefault()
  dragDepth = 0
  delete drop.dataset.state
  for (const f of e.dataTransfer.files) addFile(f.name)
})

// ---------- File list ----------
const files = $('#files')
const KIND = { mp4: 'VIDEO', mkv: 'VIDEO', avi: 'VIDEO', mov: 'VIDEO', webm: 'VIDEO', mp3: 'AUDIO', wav: 'AUDIO', m4a: 'AUDIO', flac: 'AUDIO', ogg: 'AUDIO' }
function addFile(name) {
  const ext = name.split('.').pop().toLowerCase()
  const kind = KIND[ext] || 'FILE'
  const li = document.createElement('li')
  li.className = 'file'
  li.innerHTML = `
    <span class="file-glyph">${icon(kind === 'AUDIO' ? 'audio' : kind === 'VIDEO' ? 'video' : 'files', 'icon-sm')}</span>
    <span class="file-name" title=""></span>
    <span class="tag ${kind === 'AUDIO' ? 'tag-audio' : kind === 'VIDEO' ? 'tag-video' : ''}">${kind} · ${ext.toUpperCase()}</span>
    <button class="btn btn-icon btn-sm" aria-label="Remove">${icon('close', 'icon-sm')}</button>`
  $('.file-name', li).textContent = name
  $('.file-name', li).title = name
  $('button', li).addEventListener('click', () => removeRow(li))
  files.append(li)
  countFiles()
}
function removeRow(li) {
  li.classList.add('is-leaving')
  li.addEventListener('animationend', () => { li.remove(); countFiles() }, { once: true })
}
function countFiles() {
  const n = $$('.file:not(.is-leaving)', files).length
  $('#file-count').textContent = n
  $('#files-empty').hidden = n > 0
}
const SAMPLE_FILES = ['Friday talk.mp4', 'Nature documentary, episode 4 - the long migration across the northern plains (1080p remaster).mkv',
  'Interview with the baker.mp3', 'Old family video.avi', 'Recitation practice.m4a']
let nextSample = 3
SAMPLE_FILES.slice(0, 3).forEach(addFile)
$('#add-file').addEventListener('click', () => addFile(SAMPLE_FILES[nextSample++ % SAMPLE_FILES.length]))
$('#clear-files').addEventListener('click', () => $$('.file', files).forEach((li, i) => setTimeout(() => removeRow(li), i * 40)))

// ---------- Options ----------
const optToggle = $('#opt-toggle')
optToggle.addEventListener('click', () => {
  const open = optToggle.getAttribute('aria-expanded') !== 'true'
  optToggle.setAttribute('aria-expanded', open)
  $('#opt').dataset.open = open
})

// ---------- Voice wave: green bars are speech, faint purple ones the music that goes ----------
const wave = $('#wave')
const HEIGHTS = [0.5, 0.8, 0.35, 1, 0.6, 0.25, 0.9, 0.45, 0.7, 0.3, 0.85, 0.55, 0.4, 0.75]
wave.innerHTML = HEIGHTS.map((h, i) => `<i class="${i % 5 === 2 ? 'is-music' : ''}" style="--h:${h};--d:${i}"></i>`).join('')

// ---------- Job demo: waiting, then real-looking values, then done / error / cancelled ----------
const ring = $('#ring'); const ringValue = $('#ring-value'); const ringMark = $('#ring-mark')
const bar = $('#bar'); const jobText = $('#job-text'); const jobNumbers = $('#job-numbers')
let timer = null
function setJob(state, p = 0, text = '') {
  ring.dataset.state = state
  ring.style.setProperty('--p', p)
  bar.style.setProperty('--p', p)
  ringValue.innerHTML = `${Math.round(p * 100)}<small>%</small>`
  const busy = state === 'running' || state === 'waiting'
  bar.dataset.busy = busy
  wave.dataset.busy = busy
  $('#status').dataset.busy = busy
  const mark = { done: 'check', error: 'warning', cancelled: 'close' }[state]
  ringMark.innerHTML = mark ? icon(mark, 'ring-mark-icon') : ''
  if (mark) { ringMark.style.animation = 'none'; void ringMark.offsetWidth; ringMark.style.animation = '' }
  if (text) jobText.textContent = text
}
function stopJob() { clearInterval(timer); timer = null }
$('#job-run').addEventListener('click', () => {
  stopJob()
  setJob('waiting', 0, 'Getting the sound from youtube.com…')
  jobNumbers.textContent = ''
  let p = 0
  setTimeout(() => {
    timer = setInterval(() => {
      p = Math.min(1, p + 0.012 + Math.random() * 0.01)
      setJob('running', p, p < 0.25 ? 'Cleaning the first part… it plays when this is ready.' : 'Cleaning the rest while you watch.')
      jobNumbers.textContent = `${(p * 9.5).toFixed(1)} of 9.5 min clean`
      if (p >= 1) { stopJob(); setJob('done', 1, 'Clean. Ready to play and save.') }
    }, 120)
  }, 1400)
})
$('#job-error').addEventListener('click', () => { stopJob(); setJob('error', Number(ring.style.getPropertyValue('--p')) || 0.4, 'The graphics card ran out of memory. Close other programs and try again.') })
$('#job-cancel').addEventListener('click', () => { stopJob(); setJob('cancelled', Number(ring.style.getPropertyValue('--p')) || 0, 'Cancelled. The half-made file was removed.') })
setJob('idle', 0, 'Ready to start.')

// ---------- Engine light demo ----------
const STATUS = {
  gpu: ['NVIDIA GeForce RTX 4050', 'Graphics card in use · 6 GB'],
  cpu: ['CPU only', 'No graphics card found · slower'],
  starting: ['Starting the engine…', 'Loading the models'],
  stopped: ['Engine stopped', 'Starting it again…']
}
setupSeg($('#status-demo'), (b) => {
  const st = b.dataset.state
  $('#status').dataset.state = st
  $('#status-name').textContent = STATUS[st][0]
  $('#status-text').textContent = STATUS[st][1]
})
$('#busy-demo').addEventListener('change', (e) => { $('#status').dataset.busy = e.target.checked })
for (const seg of $$('.js-seg')) if (seg.id !== 'status-demo') setupSeg(seg)

// ---------- Player time bar: play only inside the clean part ----------
const DURATION = 572 // 9:32
const timebar = $('#timebar'); const tip = $('#timebar-tip')
let clean = 0.3; let play = 0.08; let playing = false
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
function drawTime() {
  timebar.style.setProperty('--cleaned', clean)
  timebar.style.setProperty('--played', play)
  timebar.dataset.cleaning = clean < 1
  timebar.setAttribute('aria-valuemax', Math.round(DURATION * clean))
  timebar.setAttribute('aria-valuenow', Math.round(DURATION * play))
  $('#t-now').textContent = fmt(play * DURATION)
  $('#clean-tag').textContent = clean < 1 ? `Clean up to ${fmt(clean * DURATION)}` : 'All clean'
}
const fracAt = (e) => { const r = timebar.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) }
timebar.addEventListener('pointermove', (e) => {
  const f = fracAt(e)
  tip.style.left = `${f * 100}%`
  const blocked = f > clean
  tip.dataset.blocked = blocked
  tip.textContent = blocked ? `${fmt(f * DURATION)} · not clean yet` : fmt(f * DURATION)
  if (timebar.classList.contains('is-dragging')) { play = Math.min(f, clean); drawTime() }
})
timebar.addEventListener('pointerdown', (e) => {
  timebar.setPointerCapture(e.pointerId)
  timebar.classList.add('is-dragging')
  play = Math.min(fracAt(e), clean)
  drawTime()
})
timebar.addEventListener('pointerup', () => timebar.classList.remove('is-dragging'))
timebar.addEventListener('keydown', (e) => {
  const step = e.key === 'ArrowRight' ? 5 : e.key === 'ArrowLeft' ? -5 : 0
  if (!step) return
  play = Math.min(clean, Math.max(0, play + step / DURATION))
  drawTime()
})
$('#player-play').addEventListener('click', () => { playing = !playing })
setInterval(() => {
  clean = Math.min(1, clean + 0.004)
  if (playing) play = Math.min(clean, play + 0.25 / DURATION)
  drawTime()
}, 250)
drawTime()

// ---------- Rating ----------
const NOTES = { bad: 'Bad opens "Report a slip".', good: 'Saved.', perfect: 'Saved. Thank you!' }
for (const b of $$('#rate button')) {
  b.addEventListener('click', () => {
    $$('#rate button').forEach((x) => x.setAttribute('aria-checked', x === b))
    $('#rate-note').textContent = NOTES[b.dataset.value]
  })
}

// ---------- Toasts ----------
function toast(kind, title, text) {
  const t = document.createElement('div')
  t.className = 'msg toast'
  t.dataset.kind = kind
  t.innerHTML = `${icon(kind === 'error' ? 'error' : 'done')}<div><p class="msg-title"></p><p class="msg-text"></p></div><span></span>`
  $('.msg-title', t).textContent = title
  $('.msg-text', t).textContent = text
  $('#toasts').append(t)
  setTimeout(() => {
    t.classList.add('is-leaving')
    t.addEventListener('transitionend', () => t.remove(), { once: true })
  }, 3200)
}
$('#toast-btn').addEventListener('click', () => toast('done', 'Saved as MP3', 'Interview with the baker.mp3 is in Naqi\\2026-11-22.'))
$('#toast-err').addEventListener('click', () => toast('error', 'The engine stopped', 'Naqi is starting it again. Your files are safe.'))

// ---------- Icons ----------
$('#icons').innerHTML = iconNames.map((n) => `<div class="icon-cell">${icon(n)}<span>${n}</span></div>`).join('')

hydrateIcons()
setupThemeButton($('#theme'))
requestAnimationFrame(() => moveLight($('.lib-row[aria-current="true"]')))
