// Home page (ROADMAP T2.2): a link or own files wait in the zone, Options (hidden until opened) hold what applies to
// them, the main button starts the engine job, the job card shows its progress and result. The rules follow old
// Naqi's Home (refresh, start, on_done in app.py): one link or one file is "Clean and play" (cleaned and kept in the
// history, nothing saved; it plays in the player as soon as its first part is clean, T4.1; "Save as…" comes with
// T4.3); a playlist or several files are cleaned and saved into the day folder.
import { hydrateIcons, icon } from './design/icons.js'
import { setupThemeButton } from './design/theme.js'
import { setupTips } from './design/tips.js'
import { detailsButton } from './details.js'
import * as library from './library.js'
import * as pages from './pages.js'
import * as player from './player.js'
import * as report from './report.js'
import { onRated, rate, rateEl, showRating } from './rating.js'
import { seg } from './seg.js'

const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]

const AUDIO_EXTS = ['mp3', 'm4a', 'wav', 'flac', 'ogg', 'opus', 'aac', 'wma']
const VIDEO_EXTS = ['mp4', 'mkv', 'webm', 'mov', 'avi', 'wmv', 'm4v']
const MP3_QUALITIES = ['128 kbps', '192 kbps', '320 kbps']
const MP4_QUALITIES = ['Best', '1080p', '720p', '480p', '360p']
const JOB_WORDS = { play: 'Clean and play', files: 'cleaning files', link: 'cleaning a link' }
const DEFAULTS = { format: 'mp4', mp3_quality: '192 kbps', mp4_quality: '1080p', files_format: 'mp4', files_size: 'Original' }

const ext = (p) => (p.split('.').pop() || '').toLowerCase()
const baseName = (p) => p.split(/[\\/]/).pop()
const guessKind = (p) => (AUDIO_EXTS.includes(ext(p)) ? 'audio' : 'video')
const isMedia = (p) => AUDIO_EXTS.includes(ext(p)) || VIDEO_EXTS.includes(ext(p))
const isLink = (s) => /^https?:\/\//i.test(s)
const sameFile = (a, b) => a.toLowerCase() === b.toLowerCase()

// Only YouTube playlists are offered as a whole; links to other sites are always one video (old downloads.py).
function isYouTube(url) {
  try {
    const host = new URL(url.trim()).hostname.toLowerCase()
    return ['youtube.com', 'youtu.be'].some((d) => host === d || host.endsWith('.' + d))
  } catch { return false }
}
const isPlaylistLink = (url) => url.includes('list=') && isYouTube(url)
const isPlaylistOnly = (url) => isPlaylistLink(url) && !url.includes('v=') && !url.includes('youtu.be/') && !url.includes('/shorts/')

const state = {
  files: [],          // own files waiting for the button: { path, kind }
  busy: false,
  job: null,          // { id, kind } of the running job
  early: new Map(),   // job events that arrived before startJob answered (the engine sends the first at once)
  last: null,         // the newest saved file (Show in folder)
  live: null,         // the latest event of the running "Clean and play" job
  opened: false,      // ...and the player opened it by itself once it could play
  playRow: null,      // the item the job card's Play button plays
  engine: { status: 'starting' },
  settings: { ...DEFAULTS }
}

function remember(patch) {
  Object.assign(state.settings, patch)
  window.naqi.setSettings(patch)
}

const fmt = seg($('#fmt'), (v) => { remember({ format: v }); fillQuality(); refresh() })
const quality = seg($('#quality'), (v) => { remember(fmt.value() === 'mp3' ? { mp3_quality: v } : { mp4_quality: v }); refresh() })
const vfmt = seg($('#vfmt'), (v) => { remember({ files_format: v }); refresh() })
const vsize = seg($('#vsize'), (v) => { remember({ files_size: v }); refresh() })
const kbps = seg($('#kbps'), (v) => { remember({ mp3_quality: v }); refresh() })

function fillQuality() {
  const mp3 = fmt.value() === 'mp3'
  quality.set(mp3 ? MP3_QUALITIES : MP4_QUALITIES, mp3 ? state.settings.mp3_quality : state.settings.mp4_quality)
}

// ---------- What waits, the options that apply, and what the button will do (old refresh) ----------
const url = $('#url')
const zone = $('#zone')
const go = $('#go')

function filesButtonText(n, mp3, mp4) {
  const what = n > 1 ? [[mp3, 'MP3'], [mp4, 'MP4']].filter(([c]) => c).map(([c, k]) => `${c} ${k}`).join(' + ') : (mp3 ? 'MP3' : 'MP4')
  return `Clean ${n} file${n > 1 ? 's' : ''}  →  ${what}`
}

function playlistWanted() {
  const u = url.value.trim()
  return isPlaylistOnly(u) || ($('#whole').checked && isPlaylistLink(u))
}

// What "Clean and play" would take: the one link (not a whole playlist) or the one own file, else null.
// A whole playlist and several files are cleaned into saved files (old Naqi single()).
function single() {
  if (state.files.length) return state.files.length === 1 ? state.files[0].path : null
  const u = url.value.trim()
  return u && !playlistWanted() ? u : null
}

function refresh() {
  const files = state.files.length > 0
  const link = url.value.trim()
  const one = single() !== null   // "Clean and play": nothing is saved, so no format or folder to choose
  const videos = state.files.filter((f) => f.kind === 'video').length
  const audios = state.files.length - videos
  const asMp4 = vfmt.value() === 'mp4'

  $('#link-box').hidden = files
  $('#files-box').hidden = !files
  if (files) {
    const n = state.files.length
    $('#files-title').textContent = `${n} file${n > 1 ? 's' : ''} ${state.busy ? 'being cleaned' : 'ready'}`
  }
  $('#url-clear').hidden = !link || state.busy

  const shown = {
    fmt: !files && !one, quality: !files && !one, vfmt: videos > 0 && !one, vsize: videos > 0 && asMp4 && !one,
    kbps: files && !one && (audios > 0 || !asMp4), hint: audios > 0 && !one, folder: !one
  }
  for (const [row, on] of Object.entries(shown)) {
    $(`[data-row="${row}"]`).hidden = !on
    $(`[data-for="${row}"]`).hidden = !on
  }
  const hasOptions = !one && (files || !!link)   // Options only when something will be saved
  $('#opt-box').hidden = !hasOptions
  if (!hasOptions) setOptions(false)
  $('#opt-sum').textContent = optionsSummary(shown)

  if (state.busy) return
  const ready = state.engine.status === 'ready'
  if (one) {
    setButton('Clean and play', ready, '', 'play')
  } else if (files) {
    const mp4 = asMp4 ? videos : 0
    setButton(filesButtonText(state.files.length, state.files.length - mp4, mp4), ready)
  } else if (link) {
    setButton(`Clean playlist  →  ${fmt.value().toUpperCase()}`, ready)
  } else {
    setButton('Paste a link or add files', false)
  }
  if ((files || link) && !ready) setButton(state.engine.status === 'starting' ? 'Waiting for the engine…' : 'The engine is not running', false)
}

function optionsSummary(shown) {
  const parts = []
  if (shown.fmt) parts.push(fmt.value().toUpperCase(), quality.value())
  if (shown.vfmt) parts.push(`Videos → ${vfmt.value().toUpperCase()}` + (shown.vsize ? ` ${vsize.value()}` : ''))
  if (shown.kbps) parts.push(`MP3 ${kbps.value()}`)
  const folder = state.settings.folder || ''
  parts.push('saved in ' + (baseName(folder.replace(/[\\/]+$/, '')) || folder))
  return parts.filter(Boolean).join(' · ')
}

function setButton(text, enabled, mode = '', glyphName = '') {
  const [what, result] = text.split('  →  ')
  const glyph = mode === 'cancel' ? icon('close') : glyphName ? icon(glyphName) : ''
  go.innerHTML = `${glyph}<span id="go-text"></span>`
  $('#go-text').textContent = what
  if (result) $('#go-text').insertAdjacentHTML('beforeend', ` <span class="go-arrow" aria-hidden="true">→</span> `)
  if (result) $('#go-text').append(result)
  go.disabled = !enabled
  go.classList.toggle('is-cancel', mode === 'cancel')
}

function setOptions(open) {
  $('#opt-toggle').setAttribute('aria-expanded', open)
  $('#opt').dataset.open = open
}
$('#opt-toggle').addEventListener('click', () => setOptions($('#opt-toggle').getAttribute('aria-expanded') !== 'true'))

// ---------- The link ----------
function linkError(text) {
  const help = $('#url-help')
  help.hidden = !text
  help.textContent = text || ''
  help.dataset.state = text ? 'error' : ''
  $('#url-field').dataset.state = text ? 'error' : ''
}
url.addEventListener('input', () => {
  const u = url.value
  const list = isPlaylistLink(u)
  $('#whole-row').hidden = !list            // only a playlist link has the choice
  $('#whole').checked = list
  $('#whole').disabled = isPlaylistOnly(u)  // a playlist page itself can only be the whole playlist
  linkError('')
  refresh()
})
url.addEventListener('keydown', (e) => { if (e.key === 'Enter') start() })
$('#whole').addEventListener('change', refresh)
$('#paste').addEventListener('click', async () => {
  url.value = (await window.naqi.clipboardText()).trim()
  url.dispatchEvent(new Event('input'))
  url.focus()
  asked(url.value)   // pasted by hand: no need to offer it as well
})

// ---------- A copied link (ROADMAP T10.4) ----------
// When Naqi opens or comes back to the front with a video link on the clipboard, a toast offers to clean it; one
// click is Clean and play. Each link is asked once (also after a restart), and one pasted or cleaned by hand is
// not asked at all. Only a link to one video on a known video site counts: any other text or link stays quiet.
const VIDEO_SITES = ['youtube.com', 'youtu.be', 'vimeo.com', 'dailymotion.com', 'dai.ly', 'tiktok.com', 'instagram.com',
  'facebook.com', 'fb.watch', 'x.com', 'twitter.com', 'twitch.tv', 'reddit.com', 'soundcloud.com', 'bilibili.com', 'rumble.com']
function videoLink(text) {
  const s = (text || '').trim()
  if (!isLink(s) || /\s/.test(s) || s.length > 2000) return null
  let u
  try { u = new URL(s) } catch { return null }
  const host = u.hostname.toLowerCase()
  if (!VIDEO_SITES.some((d) => host === d || host.endsWith('.' + d))) return null
  if (isYouTube(s)) return u.searchParams.get('v') || /^\/(shorts|live|embed)\/[\w-]+/.test(u.pathname) || (host === 'youtu.be' && u.pathname.length > 1) ? s : null
  return u.pathname.length > 1 ? s : null   // a site's front page is not a video
}
const ASKED_MAX = 30
function askedList() {
  try { return JSON.parse(state.settings.clip_asked || '[]') } catch { return [] }
}
function asked(link) {
  const s = (link || '').trim()
  if (!s) return
  const list = askedList().filter((l) => l !== s)
  remember({ clip_asked: JSON.stringify([...list, s].slice(-ASKED_MAX)) })
}
let checking = false
async function offerCopiedLink() {
  // Not while something is cleaned or files wait: the offer comes the next time Naqi is in front
  if (checking || state.busy || state.files.length || state.engine.status !== 'ready') return
  checking = true
  try {
    const link = videoLink(await window.naqi.clipboardOffer())
    if (!link || askedList().includes(link) || url.value.trim() === link) return
    asked(link)
    toast('', 'Clean the link you copied?', link, '', {
      label: 'Clean and play', glyph: 'play', ms: 12000,
      run: () => {
        if (state.busy || state.engine.status !== 'ready') return
        if (pages.shown() !== 'home') pages.show('home')   // the job card is on Home; a playing item goes to the corner
        state.files = []
        drawFiles()
        url.value = link
        url.dispatchEvent(new Event('input'))
        $('#whole').checked = false   // a video in a playlist: just that video
        refresh()
        start()
      }
    })
  } catch { /* the clipboard could not be read: nothing to offer */ } finally { checking = false }
}
window.addEventListener('focus', offerCopiedLink)
$('#url-clear').addEventListener('click', () => { url.value = ''; url.dispatchEvent(new Event('input')); url.focus() })

// ---------- Own files ----------
const list = $('#files')

function fileRow(f) {
  const li = document.createElement('li')
  li.className = 'file'
  li.dataset.path = f.path
  li.innerHTML = `
    <span class="file-glyph"></span>
    <span class="file-name-wrap"><span class="file-name"></span></span>
    <span class="tag"></span>
    <button class="btn btn-icon btn-sm" aria-label="">${icon('close', 'icon-sm')}</button>`
  const name = baseName(f.path)
  $('.file-name', li).textContent = name
  $('.file-name', li).title = f.path
  $('button', li).setAttribute('aria-label', `Remove ${name}`)
  $('button', li).addEventListener('click', () => removeFile(f.path))
  drawKind(li, f.kind)
  return li
}

function drawKind(li, kind) {
  const glyph = $('.file-glyph', li)
  glyph.dataset.kind = kind
  glyph.innerHTML = icon(kind, 'icon-sm')
  const tag = $('.tag', li)
  tag.className = `tag tag-${kind}`
  tag.textContent = `${kind.toUpperCase()} · ${ext(li.dataset.path).toUpperCase()}`
}

// Rows are kept by path: new ones slide in, removed ones fold away, the rest stay still.
function drawFiles() {
  const rows = new Map($$('.file:not(.is-leaving)', list).map((li) => [li.dataset.path, li]))
  for (const [path, li] of rows) {
    if (!state.files.some((f) => f.path === path)) {
      li.classList.add('is-leaving')
      li.addEventListener('animationend', () => li.remove(), { once: true })
    }
  }
  for (const f of state.files) {
    const li = rows.get(f.path)
    if (li) drawKind(li, f.kind)
    else list.append(fileRow(f))
  }
  $$('.file button', list).forEach((b) => { b.disabled = state.busy })
}

function addFiles(paths) {
  const fresh = []
  for (const p of paths) {
    if (!state.files.some((f) => sameFile(f.path, p)) && !fresh.some((f) => sameFile(f.path, p))) fresh.push({ path: p, kind: guessKind(p) })
  }
  if (fresh.length) {
    state.files.push(...fresh)
    // Is there a real picture in each file? (An MP4 can be sound only, an MP3 can carry a cover.)
    window.naqi.fileKinds(fresh.map((f) => f.path)).then(({ kinds }) => {
      for (const f of state.files) if (kinds[f.path]) f.kind = kinds[f.path]
      drawFiles()
      refresh()
    }).catch(() => { /* the guess from the name stays; cleaning checks again anyway */ })
  }
  if (!state.busy) hideJob()   // the last job's card goes away: these files are what comes next
  drawFiles()
  refresh()
}

function removeFile(path) {
  state.files = state.files.filter((f) => f.path !== path)
  drawFiles()
  refresh()
}

async function chooseFiles() {
  const paths = await window.naqi.chooseFiles()
  if (paths.length) addFiles(paths)
}
$('#choose').addEventListener('click', chooseFiles)
$('#add-more').addEventListener('click', chooseFiles)
$('#clear-files').addEventListener('click', () => { state.files = []; drawFiles(); refresh() })

// Dropping: the zone wakes up while files are dragged anywhere over the window.
let dragDepth = 0
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files')
window.addEventListener('dragenter', (e) => {
  e.preventDefault()
  if (!hasFiles(e) || state.busy) return
  dragDepth++
  zone.dataset.state = 'drag'
})
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; delete zone.dataset.state } })
window.addEventListener('dragover', (e) => {
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = state.busy ? 'none' : 'copy'
})
window.addEventListener('drop', (e) => {
  e.preventDefault()
  dragDepth = 0
  delete zone.dataset.state
  if (state.busy) return
  const paths = [...e.dataTransfer.files].map((f) => window.naqi.pathForFile(f)).filter(Boolean)
  const media = paths.filter(isMedia)
  if (media.length) addFiles(media)
  if (!media.length) toast('error', 'Not an audio or video file', 'Drop audio or video files (MP3, MP4, WAV, MKV…).')
  else if (media.length < paths.length) toast('', `${paths.length - media.length} dropped item${paths.length - media.length > 1 ? 's' : ''} skipped`, 'Not an audio or video file.')
})

// ---------- Keys on Home: Ctrl+O adds files, Ctrl+V anywhere pastes a link into the link box, Escape closes Options ----------
document.addEventListener('keydown', (e) => {
  if ($('.home').hidden || e.defaultPrevented) return
  const el = document.activeElement
  const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.type !== 'checkbox'
  const key = e.key.toLowerCase()
  if (e.ctrlKey && key === 'o' && !state.busy) { e.preventDefault(); chooseFiles() }
  else if (e.ctrlKey && key === 'v' && !typing && !state.busy && !state.files.length) { e.preventDefault(); $('#paste').click() }
  else if (e.key === 'Escape' && $('#opt-toggle').getAttribute('aria-expanded') === 'true') { setOptions(false); $('#opt-toggle').focus() }
})

// ---------- Save to ----------
function showFolder() {
  const el = $('#folder')
  el.textContent = state.settings.folder
  el.title = state.settings.folder
}
$('#change-folder').addEventListener('click', async () => {
  const next = await window.naqi.chooseFolder()
  if (next) { state.settings = { ...state.settings, ...next }; showFolder(); refresh() }
})

// ---------- The job ----------
const job = $('#job')
const ring = $('#ring')
const bar = $('#bar')
const wave = $('#wave')
const HEIGHTS = [0.5, 0.8, 0.35, 1, 0.6, 0.25, 0.9, 0.45, 0.7, 0.3, 0.85, 0.55, 0.4, 0.75]
wave.innerHTML = HEIGHTS.map((h, i) => `<i class="${i % 5 === 2 ? 'is-music' : ''}" style="--h:${h};--d:${i}"></i>`).join('')

function lockInputs(on) {
  state.busy = on
  zone.dataset.busy = on
  for (const el of [url, $('#paste'), $('#choose'), $('#add-more'), $('#clear-files'), $('#whole'), $('#change-folder')]) el.disabled = on
  if (!on) $('#whole').disabled = isPlaylistOnly(url.value)
  for (const s of [fmt, quality, vfmt, vsize, kbps]) s.disable(on)
  drawFiles()
}

function showJob({ title, item, tag }) {
  job.hidden = false
  job.classList.remove('is-entering')
  void job.offsetWidth
  job.classList.add('is-entering')
  job.dataset.state = 'running'
  $('#job-title').textContent = title
  $('#job-item').textContent = item || ''
  $('#job-item').title = item || ''
  $('#job-tag').textContent = tag || ''
  $('#job-tag').className = tag ? `tag tag-${tag.toLowerCase()}` : 'tag'
  $('#show').hidden = true
  $('#play-now').hidden = true
  $('#job-details').hidden = true
  hideRating()
  progress(0, 'Starting…', true)
  $('#job-device').textContent = ''   // the engine light at the top already names the graphics card
  // On a short window the card starts below the button: bring it into view so the progress is seen
  requestAnimationFrame(() => job.scrollIntoView({ block: 'nearest', behavior: reduceMotion.matches ? 'auto' : 'smooth' }))
}
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

function hideJob() { job.hidden = true }

// Where a saved file landed, short: "Naqi\2026-11-22" (a playlist adds its own folder)
function dayFolder(file) {
  const root = state.settings.folder.replace(/\//g, '\\').replace(/\\+$/, '')
  const dir = (file || '').replace(/\//g, '\\').split('\\').slice(0, -1).join('\\')
  const inside = dir.toLowerCase().startsWith(root.toLowerCase()) ? dir.slice(root.length).replace(/^[\\/]+/, '') : dir
  return [baseName(root), inside].filter(Boolean).join('\\')
}

function progress(frac, text, waiting = false) {
  ring.dataset.state = waiting || frac <= 0 ? 'waiting' : 'running'
  ring.style.setProperty('--p', frac)
  bar.style.setProperty('--p', frac)
  $('#ring-value').innerHTML = `${Math.floor(frac * 100)}<small>%</small>`
  bar.dataset.busy = true
  wave.dataset.busy = true
  $('#engine').dataset.busy = true
  if (text) $('#job-text').textContent = text
}

function finish(kind, title, text) {
  job.dataset.state = kind === 'done' ? 'done' : kind
  ring.dataset.state = kind
  bar.dataset.busy = false
  wave.dataset.busy = false
  $('#engine').dataset.busy = false
  if (kind === 'done') { ring.style.setProperty('--p', 1); bar.style.setProperty('--p', 1) }
  else { ring.style.setProperty('--p', 0); bar.style.setProperty('--p', 0) }
  const mark = { done: 'check', error: 'warning', cancelled: 'close' }[kind]
  $('#ring-mark').innerHTML = mark ? icon(mark) : ''
  $('#job-title').textContent = title
  $('#job-text').textContent = text
  $('#job-text').title = text
  // An engine error can be reported: Copy details puts it on the clipboard with the versions
  $('#job-details').hidden = kind !== 'error'
  if (kind === 'error') $('#job-details').replaceChildren(detailsButton({ where: `Home, ${JOB_WORDS[state.jobKind] || 'cleaning'}`, title, text }))
}

function showDevice(numbers) {
  const gpu = state.engine.gpu
  let text = gpu?.device === 'cuda' ? `Graphics card · ${gpu.name}` : gpu ? 'CPU only · slower' : ''
  if (numbers?.speed_x) text = `${numbers.speed_x.toFixed(1)}x real time · ${numbers.device === 'cuda' ? 'graphics card' : 'CPU'}`
  $('#job-device').textContent = text
}

async function start() {
  if (state.busy || state.engine.status !== 'ready') return
  const out = state.settings.folder
  let spec, card
  const one = single()
  if (one && !isLink(one) && state.files.length === 0) { linkError('This does not look like a link. It should start with https://'); url.focus(); return }
  if (isLink(url.value.trim()) && !state.files.length) asked(url.value)   // cleaned by hand: never offered after
  if (one) {
    const file = state.files[0]
    const video = file ? file.kind === 'video' : true
    spec = { kind: 'play', source: one }
    card = { title: video ? 'Cleaning your video…' : 'Cleaning your sound…', item: file ? baseName(one) : one, tag: video ? 'VIDEO' : 'AUDIO' }
  } else if (state.files.length) {
    const paths = state.files.map((f) => f.path)
    const n = paths.length
    const size = vsize.value()
    spec = { kind: 'files', files: paths, out, fmt: vfmt.value(), height: size === 'Original' ? null : parseInt(size, 10), kbps: parseInt(kbps.value(), 10) }
    card = { title: n > 1 ? `Cleaning ${n} files…` : 'Cleaning your file…', item: n > 1 ? '' : baseName(paths[0]), tag: n > 1 ? '' : state.files[0].kind.toUpperCase() }
  } else {
    const link = url.value.trim()
    if (!link) { url.focus(); return }
    if (!isLink(link)) { linkError('This does not look like a link. It should start with https://'); url.focus(); return }
    const playlist = playlistWanted()
    spec = { kind: 'link', url: link, out, fmt: fmt.value(), quality: quality.value(), playlist }
    card = { title: playlist ? 'Cleaning the playlist…' : 'Cleaning your video…', item: link, tag: fmt.value() === 'mp3' ? 'AUDIO' : 'VIDEO' }
  }
  run(spec, card)
}

async function run(spec, card) {
  lockInputs(true)
  setOptions(false)
  refresh()
  setButton('Cancel', true, 'cancel')
  showJob(card)
  state.live = null
  state.opened = false
  state.playRow = null
  state.job = { id: null, kind: spec.kind }
  state.jobKind = spec.kind
  try {
    const started = await window.naqi.startJob(spec)
    state.job.id = started.id
    const early = state.early.get(started.id)
    state.early.clear()
    if (early) onJob(early)
  } catch (e) {
    state.job = null
    lockInputs(false)
    finish('error', 'Could not start', e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    refresh()
  }
}

go.addEventListener('click', async () => {
  if (!state.busy) return start()
  if (!state.job?.id) return
  setButton('Cancelling…', false, 'cancel')
  try { await window.naqi.cancelJob(state.job.id) } catch { /* the job ended by itself */ }
})

function onJob(j) {
  if (!state.job || !['files', 'link', 'play'].includes(j.kind)) return
  if (state.job.id === null) { state.early.set(j.id, j); return }
  if (j.id !== state.job.id) return
  if (j.last) state.last = j.last
  if (j.kind === 'play') onPlayJob(j)
  if (j.state === 'running') return progress(j.frac, j.text)
  state.live = null
  // Finished: saved files leave the list; failed or not-yet-done ones stay, ready to try again
  state.job = null
  lockInputs(false)
  if (j.kind === 'files' || (j.kind === 'play' && j.state === 'done')) {
    const done = j.kind === 'play' ? state.files.map((f) => f.path) : j.done || []
    state.files = state.files.filter((f) => !done.some((d) => sameFile(d, f.path)))
    drawFiles()
  }
  const saved = (j.saved || []).length > 0
  $('#show').hidden = !saved
  if (j.state === 'done' && j.kind === 'play') {
    // Cleaned and kept, nothing saved: Play and "Save as…" are in the player
    finish('done', 'Clean', j.text)
    if (j.row_id) askRating(j.row_id)
    if (!state.files.length) { url.value = ''; url.dispatchEvent(new Event('input')) }
    showDevice(j.numbers)
  } else if (j.state === 'done') {
    finish('done', j.outcome === 'partial' ? 'Partly saved' : 'Saved', `${j.text}, in ${dayFolder(j.last)}`)
    if (j.kind === 'link') { url.value = ''; url.dispatchEvent(new Event('input')) }
    showDevice(j.numbers)
  } else if (j.state === 'cancelled') {
    finish('cancelled', 'Cancelled', j.text)
  } else {
    finish('error', 'Something went wrong', j.text)
  }
  refresh()
}
window.naqi.onJob(onJob)

// ---------- Playing ----------
// "Clean and play": the player opens by itself once the first part is clean (old on_plays), if Home is still shown;
// the job card's Play button opens it any time after that.
function onPlayJob(j) {
  if (j.row_id) state.playRow = j.row_id
  if (j.state === 'running') state.live = j
  $('#play-now').hidden = !(j.row_id && (j.plays || j.state === 'done'))
  if (j.state === 'running' && j.plays && !state.opened) {
    state.opened = true
    if (player.openId() === null || player.inCorner()) playItem(j.row_id)
  }
}
$('#play-now').addEventListener('click', () => playItem(state.playRow))

// Plays a library item. The one being cleaned plays once enough is clean; one whose cleaned sound was tidied away
// is cleaned again first (old Naqi play()).
async function playItem(id) {
  const live = state.live?.row_id === id ? state.live : null
  if (live && !live.plays) {
    player.close()
    return toast('', 'Not ready yet', 'It starts playing by itself as soon as the first part is clean.')
  }
  try {
    await player.open(id, live)
    library.select(id)
  } catch (e) {
    const why = e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    if (why !== 'again') return toast('error', 'Could not play it', why, 'Player, opening an item')
    player.close()
    if (state.busy) return toast('error', 'Naqi is still busy cleaning', 'Play this again when it is done, or cancel it.')
    const it = library.item(id)
    run({ kind: 'play', row: id }, { title: it?.kind === 'audio' ? 'Cleaning your sound again…' : 'Cleaning your video again…',
      item: it?.title || '', tag: it?.kind === 'audio' ? 'AUDIO' : 'VIDEO' })
  }
}
window.addEventListener('naqi-play', (e) => playItem(e.detail.id))
window.addEventListener('naqi-removed', (e) => { if (player.openId() === e.detail.id) player.close() })
window.addEventListener('naqi-saved', () => library.load())   // its saved format and Show in folder

// ---------- Rating after one cleaned file (several files are rated in the library) ----------
const jobRate = $('#job-rate')
const rateNote = $('#rate-note')
const RATE_NOTES = { bad: 'Thanks for telling us.', good: 'Thanks!', perfect: 'Thanks!' }
const jobRating = rateEl(async (value) => {
  const id = Number(jobRate.dataset.id)
  showRating(jobRating, value)
  try {
    await rate(id, value)
    rateNote.textContent = RATE_NOTES[value]
  } catch (e) {
    showRating(jobRating, null)
    rateNote.textContent = `Rating not saved: ${e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`
  }
})
jobRate.append(jobRating)

function askRating(id) {
  jobRate.dataset.id = id
  showRating(jobRating, null)
  rateNote.textContent = 'How clean was it?'
  jobRate.hidden = false
}
function hideRating() { jobRate.hidden = true }
// Rated in the library: the card follows
onRated(({ id, rating }) => { if (Number(jobRate.dataset.id) === id) showRating(jobRating, rating) })
// Bad, wherever it was given: a bad file most likely has a slip to report (old SPEC R13), so the report opens with
// it filled in. The player's item waits, paused, in the corner.
onRated(({ id, rating }) => {
  if (rating !== 'bad') return
  player.pause()
  report.open({ id })
})
// Report here in the player: the moment is filled in too, and Back returns to the paused player
window.addEventListener('naqi-report-here', (e) => report.open({ ...e.detail, back: 'player' }))
$('#show').addEventListener('click', () => window.naqi.showInFolder(state.last))

// ---------- Engine light: green graphics card, amber CPU only, red stopped, grey starting ----------
function showEngine(s) {
  state.engine = s
  const el = $('#engine')
  const gpu = s.gpu
  let look = 'starting'
  let name = 'Starting the engine…'
  let text = 'Loading the music remover'
  if (s.status === 'ready') {
    look = gpu?.device === 'cuda' ? 'gpu' : 'cpu'
    name = gpu?.device === 'cuda' ? gpu.name : 'CPU only'
    text = gpu?.device === 'cuda' ? `Graphics card in use${gpu.vram_total_mb ? ` · ${Math.round(gpu.vram_total_mb / 1024)} GB` : ''}` : 'No graphics card found · slower'
  } else if (s.status === 'restarting') {
    name = 'Engine stopped'
    text = 'Starting it again…'
  } else if (s.status === 'stopped' || s.status === 'error') {
    look = 'stopped'
    name = s.status === 'error' ? 'The music remover is not working' : 'Engine stopped'
    text = s.message || ''
  }
  el.dataset.state = look
  $('#engine-name').textContent = name
  $('#engine-text').textContent = text
  el.title = s.message || ''
  $('#engine-restart').hidden = s.status !== 'stopped'
  const failed = s.status === 'stopped' || s.status === 'error'
  if (failed && $('#engine-details').hidden) $('#engine-details').replaceChildren(detailsButton(() => ({ where: 'Engine', title: $('#engine-name').textContent, text: $('#engine-text').textContent }), { small: true }))
  $('#engine-details').hidden = !failed
  if (state.busy && s.status !== 'ready' && s.status !== 'starting') {
    // The engine died during the job: its job is gone with it
    state.job = null
    lockInputs(false)
    finish('error', 'Something went wrong', 'The engine stopped during the cleaning. Naqi is starting it again; press the button to try once more.')
  }
  refresh()
  if (s.status === 'ready' && document.hasFocus()) offerCopiedLink()   // Naqi just opened (or the engine is back)
}
$('#engine-restart').addEventListener('click', () => window.naqi.restartEngine())
window.naqi.onEngineStatus(showEngine)

// ---------- Toasts ----------
// An error stays long enough to be read (and until the pointer leaves it); any toast can be closed. At most three.
// where: an engine error, named for Copy details (the button under its text).
// action: an offer ({ label, glyph, run, ms }): its button under the text runs it and closes the toast.
const TOAST_MS = { error: 8000, '': 4000 }
function toast(kind, title, text, where = '', action = null) {
  const t = document.createElement('div')
  t.className = 'msg toast'
  t.setAttribute('role', kind === 'error' ? 'alert' : 'status')
  if (kind) t.dataset.kind = kind
  t.innerHTML = `${icon(kind === 'error' ? 'error' : action ? 'link' : 'info')}<div><p class="msg-title"></p><p class="msg-text"></p></div>
    <button class="btn btn-icon btn-sm toast-close" aria-label="Close">${icon('close', 'icon-sm')}</button>`
  $('.msg-title', t).textContent = title
  $('.msg-text', t).textContent = text
  if (where) $('.msg-text', t).after(detailsButton({ where, title, text }))
  if (action) {
    t.classList.add('toast-offer')
    $('.msg-text', t).title = text
    const b = document.createElement('button')
    b.className = 'btn btn-primary btn-sm toast-action'
    b.innerHTML = `${action.glyph ? icon(action.glyph, 'icon-sm') : ''}<span></span>`
    b.querySelector('span').textContent = action.label
    b.addEventListener('click', () => { leave(); action.run() })
    $('.msg-text', t).after(b)
  }
  const leave = () => {
    if (t.classList.contains('is-leaving')) return
    t.classList.add('is-leaving')
    t.addEventListener('transitionend', () => t.remove(), { once: true })
    setTimeout(() => t.remove(), 400)   // also when no frame is drawn (window hidden)
  }
  let timer = setTimeout(leave, action?.ms || TOAST_MS[kind] || TOAST_MS[''])
  t.addEventListener('pointerenter', () => clearTimeout(timer))
  t.addEventListener('pointerleave', () => { timer = setTimeout(leave, 2000) })
  $('.toast-close', t).addEventListener('click', leave)
  $('#toasts').append(t)
  const live = $$('.toast:not(.is-leaving)', $('#toasts'))
  for (const old of live.slice(0, Math.max(0, live.length - 3))) old.querySelector('.toast-close').click()
}
// Anything that fails without its own message still says so, in plain words (the window never fails silently)
window.addEventListener('unhandledrejection', (e) => {
  const why = String(e.reason?.message || e.reason || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
  toast('error', 'Something did not work', why || 'Please try again.', 'Window')
})

// ---------- Start ----------
async function init() {
  hydrateIcons()
  setupTips()
  setupThemeButton($('#theme'))
  state.settings = { ...DEFAULTS, ...(await window.naqi.getSettings()) }
  fmt.set(null, state.settings.format)
  fillQuality()
  vfmt.set(null, state.settings.files_format)
  vsize.set(null, state.settings.files_size)
  kbps.set(null, state.settings.mp3_quality)
  showFolder()
  player.setVolume(state.settings.volume)
  player.setTheater(state.settings.theater === '1')
  showEngine(await window.naqi.engineStatus())
  library.load()
  url.focus()
}
init()
