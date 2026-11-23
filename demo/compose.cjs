// Puts the demo video together from the recorder's output (src/main/demorecord.js). Run with Electron:
//   node_modules/.bin/electron demo/compose.cjs <phase>     phase: timeline | frames | render | all
// timeline: the order of everything (intro, the recording with its fast parts, chapter cards, captions, zooms,
//           outro) into timeline.json; demo/soundtrack.py then builds soundtrack.wav and levels.json from it.
// frames:   the recording's frames that are used, as JPEG files; plus the "before / after" clip's frames.
// render:   every frame of stage.html captured and encoded with the soundtrack into the final MP4.
// Folders: NAQI_DEMO_DIR (the recording), NAQI_DEMO_WORK (frames, timeline, sound), NAQI_DEMO_OUT (final MP4),
// NAQI_DEMO_SOURCE (the link's original video file, for "before / after"), NAQI_DEMO_BEFORE_AT (its start second).
const { app, BrowserWindow, nativeImage, screen } = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const REC = process.env.NAQI_DEMO_DIR
const WORK = process.env.NAQI_DEMO_WORK
const OUT = process.env.NAQI_DEMO_OUT
const SOURCE = process.env.NAQI_DEMO_SOURCE
const BEFORE_AT = Number(process.env.NAQI_DEMO_BEFORE_AT || 53)
const BA_S = 4.5          // seconds of "before" and of "after"
const MAX_S = 178         // the whole video stays under 3 minutes
const FPS = 30
const sec = (s) => Math.round(s * FPS)

const CHAPTERS = {
  'ch-link': ['01', 'Clean and play a link', 'Paste a link from YouTube, TikTok, Facebook, X or any site yt-dlp supports'],
  'ch-save': ['02', 'Save it', 'MP3 or MP4, made from the cleaned sound'],
  'ch-report': ['03', 'Report a slip', 'Heard music? Mark the moment, and every new version is tested on it'],
  'ch-rate': ['04', 'Rate it', 'Bad, Good or Perfect, kept with the file'],
  'ch-drop': ['05', 'Your own files', 'Drag them in. The originals are never changed'],
  'ch-theme': ['06', 'Light and dark', 'Follows Windows, or your own choice'],
  'ch-files': ['07', 'Many files at once', 'Cleaned and saved into one folder per day'],
  'ch-errors': ['08', 'Clear messages, quick cancel', 'Nothing freezes, nothing crashes'],
  'ch-playlist': ['09', 'Whole playlists', 'A YouTube playlist, saved as MP3 or MP4'],
  'ch-library': ['10', 'The library', 'Everything you cleaned, ready to play again']
}
const CH_S = 1.7

function captions(m, ctx) {
  const n = (x, d = 0) => Number(x).toFixed(d)
  return {
    boot: 'Naqi starts its cleaning engine',
    ready: 'Ready, on the <em>RTX 4050</em> graphics card',
    'go-link': 'One link: <em>Clean and play</em>. Nothing is saved unless you ask',
    plays: 'It plays as soon as the first part is clean, while the rest is still being cleaned',
    stream: 'The picture is streamed, in sync with the cleaned sound',
    lit: 'The lit part of the bar is already clean, and it grows ahead of you',
    'jump-in': 'Jump anywhere in the clean part',
    'jump-edge': 'Past the clean part? It stops at the edge and plays on by itself',
    pause: '<em>Space</em> plays and pauses, <em>M</em> mutes',
    'done-link': 'The whole video is clean. Save turns on',
    'saved-mp3': `MP3 saved in <em>${n(ctx.mp3s, 1)} s</em>, nothing is cleaned again`,
    'saved-mp4': 'MP4 720p: the picture is downloaded only now, on Save',
    'report-open': '<em>Report here</em> fills in the 6 seconds up to the playhead',
    strip: 'The sound strip plays the cleaned sound. Muted parts show as gaps',
    'from-to': '<em>From here</em> and <em>To here</em> set the moment by ear',
    'slip-saved': 'Saved as a permanent test case, with a copy of the sound',
    'back-player': 'Back returns to the paused player',
    rated: 'Rated Perfect',
    dropped: 'An AVI file: the window cannot show this picture as it is',
    'avi-plays': 'So Naqi makes a quick picture copy, first a part, then all of it',
    'picture-copy': 'Sound and picture in sync, cleaned while you watch',
    light: 'The same window in light mode',
    'three-files': 'Every file is tagged audio or video',
    'removed-file': 'Take one out, or add more',
    options: 'Options show only what applies: video size, MP3 quality, folder',
    'files-go': 'The library shows each file while it is cleaned',
    'files-done': 'All saved: <em>2 MP4 and 1 MP3</em> in today\'s folder',
    'bad-link': 'A broken link gets a plain message, not a crash',
    cancel: 'Started by mistake?',
    cancelled: '<em>Cancel</em> stops it in under a second, and leaves no half file',
    'playlist-options': 'A playlist link offers the whole playlist, with its save options',
    picked: 'Pick a file: rate it, show it in its folder, or remove it',
    replay: 'Plays again at once: its cleaned sound is kept',
    'cleans-again': 'Kept sounds are tidied after 2 weeks or 5 GB. Then the file cleans again when played',
    removed: 'Remove, with <em>Undo</em>',
    undo: 'Back in the library',
    'bad-opens-report': 'Rated <em>Bad</em>? Report a slip opens with the file filled in'
  }[m.id]
}

// Zoom in on what matters, following the pointer: [seconds, zoom]
const ZOOMS = {
  lit: [5, 1.2], 'jump-edge': [4, 1.2], 'saved-mp3': [3, 1.2], 'saved-mp4': [3, 1.2], strip: [5, 1.2],
  'from-to': [3, 1.2], rated: [2.2, 1.2], 'three-files': [3.5, 1.18], 'bad-link': [3.2, 1.2], cancelled: [3, 1.2],
  'playlist-options': [3, 1.15], removed: [2.8, 1.2], 'cleans-again': [3, 1.2]
}

const read = (p) => fs.readFileSync(p, 'utf8')
const ease = (t) => { t = Math.min(1, Math.max(0, t)); return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2 }

function timeline() {
  // the parts where nothing plays go faster until it all fits in MAX_S
  for (let quiet = 1; ; quiet += 0.05) {
    const tl = build(quiet)
    if (tl.frames.length <= MAX_S * FPS || quiet > 4) {
      fs.mkdirSync(WORK, { recursive: true })
      fs.writeFileSync(path.join(WORK, 'timeline.json'), JSON.stringify(tl))
      console.log(`timeline: ${tl.frames.length} frames = ${(tl.frames.length / FPS).toFixed(0)} s, quiet parts ${quiet.toFixed(2)}x, ${tl.chapters.length} chapters, ${tl.caps.length} captions, ${tl.clicks.length} clicks`)
      return
    }
  }
}

function build(quiet) {
  const meta = JSON.parse(read(path.join(REC, 'marks.json')))
  const rec = read(path.join(REC, 'frames.jsonl')).trim().split('\n').map((l) => JSON.parse(l))
  const marks = meta.marks
  const first = (id) => marks.find((m) => m.id === id)
  const frames = []
  const card = (name, seconds, extra = {}) => { const n = sec(seconds); for (let k = 0; k < n; k++) frames.push({ card: name, ct: k / FPS, len: n / FPS, ...extra }) }

  // Intro
  card('title', 3.4)
  card('before', BA_S)
  card('after', BA_S)
  const bridgeAt = frames.length
  card('bridge', 1.9)

  // The recording: fast where it waits, chapter cards frozen on their moment
  const start = first('boot').f
  const end = Math.min(rec.length - 1, first('end').f + sec(2.5))
  const fast = []
  fast.push({ from: start, to: first('ready').f, x: 8 })
  marks.forEach((m, k) => {
    if (m.id !== 'ff+') return
    const stop = marks.slice(k + 1).find((n) => n.id === 'ff-')
    fast.push({ from: m.f, to: stop ? stop.f : end, x: m.x || 4 })
  })
  const speedAt = (r) => fast.find((s) => r >= s.from && r < s.to)
  const recOut = new Map()   // recording frame -> first output frame showing it
  const chapters = []
  const chapterMarks = marks.filter((m) => CHAPTERS[m.id])
  let pos = start
  let prev = start - 1
  let ffStartOut = null
  while (pos <= end) {
    const r = Math.floor(pos)
    for (const cm of chapterMarks) {
      if (cm.f > prev && cm.f <= r && !chapters.some((c) => c.id === cm.id)) {
        const [no, title, sub] = CHAPTERS[cm.id]
        chapters.push({ id: cm.id, no, title, sub, at: frames.length, len: sec(CH_S) })
        card('chapter', CH_S, { r: cm.f })
      }
    }
    const s = speedAt(r)
    if (s && ffStartOut === null) ffStartOut = frames.length
    if (!s) ffStartOut = null
    if (!recOut.has(r)) recOut.set(r, frames.length)
    frames.push({ r, ff: s ? s.x : 0, ffReal: s ? (r - s.from) / FPS : 0, ffAge: s ? (frames.length - ffStartOut) / FPS : 0 })
    prev = r
    pos += s ? s.x : rec[r].m.length ? 1 : quiet
  }
  const outOf = (f) => { for (let r = f; r <= end; r++) if (recOut.has(r)) return recOut.get(r); return frames.length - 1 }

  // Outro
  card('outro', 5.5)
  card('credits', 4.2)

  // Pointer, dragged files, zoom (around a slowly following pointer)
  let fx = meta.size.width / meta.scale / 2
  let fy = meta.size.height / meta.scale / 2
  const zooms = marks.filter((m) => ZOOMS[m.id]).map((m) => ({ at: outOf(m.f), len: sec(ZOOMS[m.id][0]), z: ZOOMS[m.id][1] }))
  frames.forEach((f, i) => {
    f.z = 1
    if (f.r === undefined) return
    const st = rec[f.r]
    f.c = st.c
    f.d = st.d
    if (f.card !== 'chapter') {
      fx += (st.c[0] - fx) * 0.05
      fy += (st.c[1] - fy) * 0.05
    }
    f.fx = fx
    f.fy = fy
    for (const z of zooms) {
      const age = i - z.at
      if (age < 0 || age > z.len) continue
      const a = Math.min(ease(age / sec(0.8)), 1 - ease((age - (z.len - sec(0.8))) / sec(0.8)))
      f.z = Math.max(f.z, 1 + (z.z - 1) * a)
    }
  })
  frames.forEach((f) => { if (f.card === 'bridge') { f.fx = frames.find((g) => g.r !== undefined).fx; f.fy = frames.find((g) => g.r !== undefined).fy; f.z = 1 } })

  // Clicks (pointer pressed), keys, captions
  const clicks = []
  for (let r = start + 1; r <= end; r++) {
    if (rec[r].c[2] && !rec[r - 1].c[2]) clicks.push({ at: outOf(r), x: rec[r].c[0], y: rec[r].c[1], r })
  }
  const keys = marks.filter((m) => m.id === 'key').map((m) => ({ at: outOf(m.f), label: m.label }))
  const mp3 = first('saved-mp3')
  const mp3Click = mp3 && clicks.filter((c) => c.r < mp3.f).at(-1)
  const ctx = { mp3s: mp3 && mp3Click ? (mp3.f - mp3Click.r) / FPS : 1 }
  const caps = []
  for (const m of marks) {
    const text = captions(m, ctx)
    if (!text) continue
    let from = outOf(m.f)
    const last = caps.at(-1)
    if (last && from < last.from + sec(1.6)) from = last.from + sec(1.6)
    if (last) last.to = Math.min(last.to, from)
    caps.push({ text, from, to: from + sec(3.2) })
  }
  // a caption never runs into a chapter card
  for (const c of caps) for (const ch of chapters) if (c.from < ch.at && c.to > ch.at) c.to = ch.at

  // Naqi's measured numbers (PROJECT_CONTEXT, T6.3 speed pass), not this recording's: recording the screen at the
  // same time slows the graphics card down
  const stats = [
    { value: 7.9, digits: 1, num: '7.9', unit: '×', what: '<b>faster than real time</b><br>a 41 min video in 5.2 min, RTX 4050' },
    { value: 18, digits: 0, num: '18', unit: 's', what: '<b>from the click to the first word</b><br>the rest is cleaned while you watch' },
    { value: 3.3, digits: 1, num: '3.3', unit: 'GB', what: '<b>graphics memory at most</b><br>fits a 6 GB card, any video length' },
    { value: 0, digits: 0, num: '0', unit: 'bytes', what: '<b>uploaded</b><br>everything runs on your PC' }
  ]
  const credits = '<b>Videos used, all under Creative Commons Attribution (CC BY):</b><br>' +
    '“Why is biodiversity important? – with Sir David Attenborough”, The Royal Society<br>' +
    '“Wild Shorts – Places Afar”, North Devon Moving Image · “Guatemala: 12 Minute Documentary”, Opentiera<br>' +
    'No narration was added. Apart from the “Before” clip, every sound is Naqi\'s own cleaned output.'

  const tl = {
    rec: { w: meta.size.width, h: meta.size.height, scale: meta.scale }, firstRec: start, bridgeAt,
    frames, chapters, caps, keys, clicks, stats, credits, beforeAt: BEFORE_AT, baSeconds: BA_S
  }
  return tl
}

async function extractFrames() {
  const tl = JSON.parse(read(path.join(WORK, 'timeline.json')))
  const need = new Set(tl.frames.filter((f) => f.r !== undefined).map((f) => f.r))
  need.add(tl.firstRec)
  const dir = path.join(WORK, 'rec')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const { w, h } = tl.rec
  const ff = spawn('ffmpeg', ['-v', 'error', '-i', path.join(REC, 'raw.mp4'), '-f', 'rawvideo', '-pix_fmt', 'bgra', '-'])
  const size = w * h * 4
  let buf = Buffer.alloc(0)
  let k = 0
  let written = 0
  await new Promise((resolve, reject) => {
    ff.stdout.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
      while (buf.length >= size) {
        if (need.has(k)) {
          fs.writeFileSync(path.join(dir, `${k}.jpg`), nativeImage.createFromBitmap(buf.subarray(0, size), { width: w, height: h }).toJPEG(93))
          written++
        }
        buf = buf.subarray(size)
        k++
      }
    })
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`))))
  })
  console.log(`frames: ${written} of ${k} recording frames kept`)
  // "before / after": the link's own video at the chosen moment
  const src = path.join(WORK, 'src')
  fs.rmSync(src, { recursive: true, force: true })
  fs.mkdirSync(src, { recursive: true })
  spawnSync('ffmpeg', ['-v', 'error', '-ss', String(BEFORE_AT), '-t', String(BA_S), '-i', SOURCE, '-vf', 'fps=30,scale=1400:-2',
    '-q:v', '2', path.join(src, '%04d.jpg')], { stdio: 'inherit' })
}

async function render() {
  const tl = JSON.parse(read(path.join(WORK, 'timeline.json')))
  tl.levels = JSON.parse(read(path.join(WORK, 'levels.json')))
  tl.recUrl = pathToFileURL(path.join(WORK, 'rec')).href
  tl.srcUrl = pathToFileURL(path.join(WORK, 'src')).href
  tl.srcFrames = fs.readdirSync(path.join(WORK, 'src')).length
  // Frameless and allowed larger than this screen, so the page is the full 1920 x 1080 (an offscreen page draws at
  // 1 pixel per page pixel)
  const win = new BrowserWindow({ width: 1920, height: 1080, show: false, frame: false, useContentSize: true, enableLargerThanScreen: true,
    webPreferences: { offscreen: true, backgroundThrottling: false } })
  win.setContentSize(1920, 1080)   // a size given at creation is cut down to the screen
  win.webContents.setFrameRate(60)
  await win.loadFile(path.join(__dirname, 'stage.html'))
  win.webContents.setZoomFactor(1)   // Chromium remembers a zoom per page address; never inherit one
  await win.webContents.executeJavaScript(`init(${JSON.stringify(tl)})`)
  console.log('page size', await win.webContents.executeJavaScript('[innerWidth, innerHeight]'), 'capture', (await win.webContents.capturePage()).getSize())
  const from = Number(process.env.NAQI_DEMO_FROM || 0)
  const to = Math.min(tl.frames.length, Number(process.env.NAQI_DEMO_TO || tl.frames.length))
  const preview = !!process.env.NAQI_DEMO_FROM || !!process.env.NAQI_DEMO_TO
  const target = preview ? path.join(WORK, 'preview.mp4') : OUT
  const args = ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', '1920x1080', '-r', String(FPS), '-i', '-']
  if (!preview) args.push('-i', path.join(WORK, 'soundtrack.wav'))
  args.push('-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS))
  if (!preview) args.push('-c:a', 'aac', '-b:a', '192k', '-shortest')
  args.push('-movflags', '+faststart', target)
  const ff = spawn('ffmpeg', args, { stdio: ['pipe', 'inherit', 'inherit'] })
  const t0 = Date.now()
  for (let i = from; i < to; i++) {
    await win.webContents.executeJavaScript(`render(${i})`)
    let img = await win.webContents.capturePage()
    const s = img.getSize()
    if (s.width >= 1920 && s.height >= 1080) { if (s.width > 1920 || s.height > 1080) img = img.crop({ x: 0, y: 0, width: 1920, height: 1080 }) }
    else img = img.resize({ width: 1920, height: 1080, quality: 'best' })
    if (!ff.stdin.write(img.toBitmap())) await new Promise((r) => ff.stdin.once('drain', r))
    if (i % 300 === 0) console.log(`render ${i}/${to} (${((Date.now() - t0) / 1000).toFixed(0)} s)`)
  }
  ff.stdin.end()
  await new Promise((r) => ff.on('close', r))
  console.log(`rendered ${to - from} frames into ${target} in ${((Date.now() - t0) / 60000).toFixed(1)} min`)
}

app.whenReady().then(async () => {
  const phase = process.argv.at(-1)
  try {
    if (phase === 'timeline' || phase === 'all') timeline()
    if (phase === 'frames' || phase === 'all') await extractFrames()
    if (phase === 'all') spawnSync('py', ['-3.12', path.join(__dirname, 'soundtrack.py')], { stdio: 'inherit' })
    if (phase === 'render' || phase === 'all') await render()
  } catch (e) {
    console.error(e)
    process.exitCode = 1
  }
  app.quit()
})
