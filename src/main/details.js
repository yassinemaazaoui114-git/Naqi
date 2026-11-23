import { app, clipboard } from 'electron'
import { homedir, release, userInfo } from 'node:os'

// "Copy details" on an engine error (ROADMAP T10.3): the error, the time and the versions as plain text on the
// clipboard, so a problem is easy to report. Nothing private: the Windows user folder and name, e-mail addresses and
// long keys (the engine's token) are blanked out of the error text.
let health = null   // the engine's last /health answer, kept for when it has stopped

export async function remember(engine) {
  try { health = await engine.call('/health') } catch { /* keeps the one before */ }
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function scrub(text) {
  let out = String(text || '')
  const home = homedir().replace(/[\\/]+$/, '')
  for (const form of [home, home.replace(/\\/g, '/'), home.replace(/\\/g, '\\\\')]) {
    out = out.replace(new RegExp(escape(form), 'gi'), '%USERPROFILE%')
  }
  let user = ''
  try { user = userInfo().username } catch { /* no user name to blank */ }
  if (user.length > 2) out = out.replace(new RegExp(`\\b${escape(user)}\\b`, 'gi'), '<user>')
  return out
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<e-mail>')
    .replace(/\b[0-9a-f]{32,}\b/gi, '<key>')
}

function stamp(d) {
  const pad = (n) => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const zone = `UTC${off >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${zone}`
}

// where: what failed, in the page's words ("Cleaning", "Engine", "Player"...); text: the message the page shows
export async function details(engine, info, { where, title, text }) {
  if (engine.status.status === 'ready') await remember(engine)
  const sys = await info
  const gpu = engine.status.gpu
  const card = gpu ? (gpu.device === 'cuda' ? `${gpu.name}${gpu.vram_total_mb ? `, ${Math.round(gpu.vram_total_mb / 1024)} GB` : ''}` : 'none, CPU only') : 'not known yet'
  const driver = (sys.gpu || '').split(',')[2]?.trim()
  const lines = [
    'Naqi error details',
    `Time: ${stamp(new Date())}`,
    `Where: ${scrub(where) || 'not given'}`,
    `Error: ${scrub([title, text].filter(Boolean).join(': ')) || 'no message'}`,
    `Engine: ${engine.status.status}${engine.status.message ? ` (${scrub(engine.status.message)})` : ''}`,
    '',
    `Naqi ${app.getVersion()} (${app.isPackaged ? 'installed' : 'dev'})`,
    `Windows ${release()} ${process.arch}`,
    `Electron ${process.versions.electron}, Chrome ${process.versions.chrome}, Node ${process.versions.node}`,
    `Python ${health?.python || sys.python || 'not known'}, PyTorch ${gpu?.torch || 'not known'}, CUDA ${gpu?.cuda || 'none'}`,
    `yt-dlp ${health?.ytdlp || 'not known'}, ffmpeg ${sys.ffmpeg || 'not known'}`,
    `Graphics card: ${card}${driver ? `, driver ${driver}` : ''}`
  ]
  const out = lines.join('\n') + '\n'
  await clipboard.writeText(out)
  return out
}
