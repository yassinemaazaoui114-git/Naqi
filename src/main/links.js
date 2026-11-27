import { app } from 'electron'

// Share to Naqi (T11.5, SPEC R45): Windows opens naqi://clean?url=<web link> with Naqi (the "Clean in Naqi" bookmark
// on a video page sends it). Only a normal web link (http / https, not this PC or the home network) is taken, and it
// only ever fills Home's link box (Clean and play is clicked by hand); anything else becomes a plain-words refusal.
// The installed app registers naqi:// itself (and its installer does). Dev mode registers only with NAQI_LINKS=dev
// (Windows then starts this dev Electron with --dev-links and the built out/ files), so npm start never takes the
// link type from the installed Naqi by accident.
export const devLinks = !app.isPackaged && (process.env.NAQI_LINKS === 'dev' || process.argv.includes('--dev-links'))

export function registerLinks() {
  if (app.isPackaged) app.setAsDefaultProtocolClient('naqi')
  else if (process.env.NAQI_LINKS === 'dev') app.setAsDefaultProtocolClient('naqi', process.execPath, [app.getAppPath(), '--dev-links'])
}

const REFUSED = 'Naqi only cleans links to web pages (starting with http or https).'

// This PC and the home network are never fetched: a page could otherwise point Naqi at a local address
function localHost(host) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || !h.includes('.') && !h.includes(':')) return true
  if (h.includes(':')) return h === '::1' || h === '::' || /^(fc|fd|fe8|fe9|fea|feb)/.test(h) || h.startsWith('::ffff:')
  const ip = h.split('.').map(Number)
  if (ip.length !== 4 || ip.some((n) => !Number.isInteger(n))) return false
  const [a, b] = ip
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
}

// A naqi:// address -> { url } (the web link to clean) or { error } (what the page says)
export function parseLink(raw) {
  const s = String(raw || '').trim()
  if (s.length > 4000) return { error: 'That link is too long for Naqi.' }
  let u
  try { u = new URL(s) } catch { return { error: REFUSED } }
  if (u.protocol !== 'naqi:' || u.hostname.toLowerCase() !== 'clean' || !['', '/'].includes(u.pathname)) {
    return { error: 'Naqi did not understand that request. Use the "Clean in Naqi" bookmark from the Settings page.' }
  }
  const link = (u.searchParams.get('url') || '').trim()
  if (!link) return { error: 'No link came with it. Open the video page first, then click the bookmark.' }
  if (link.length > 2000 || /\s/.test(link)) return { error: REFUSED }
  let web
  try { web = new URL(link) } catch { return { error: REFUSED } }
  if (!['http:', 'https:'].includes(web.protocol) || web.username || web.password) return { error: REFUSED }
  if (localHost(web.hostname)) return { error: 'Naqi does not open links to this PC or the home network.' }
  return { url: web.href }
}

// The naqi:// address Windows passed on the command line (first start or a second start), if any
export const linkIn = (argv) => argv.find((a) => /^naqi:/i.test(a)) || null
