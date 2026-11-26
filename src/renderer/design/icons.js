// Naqi's icons: one line style (24 px grid, 1.75 px round strokes), drawn for Naqi so they match each other.
// Use <i data-icon="play"></i> in HTML and call hydrateIcons(), or icon('play') for markup in code.
// Icons are decorative (aria-hidden); the button around them carries the name (aria-label or its text).

const P = {
  play: '<path d="M8 5.5v13a1 1 0 0 0 1.52.85l10.4-6.5a1 1 0 0 0 0-1.7L9.52 4.65A1 1 0 0 0 8 5.5Z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6.5" y="5" width="3.5" height="14" rx="1.2" fill="currentColor" stroke="none"/><rect x="14" y="5" width="3.5" height="14" rx="1.2" fill="currentColor" stroke="none"/>',
  volume: '<path d="M4 9.5h3l4.5-4v13L7 14.5H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  mute: '<path d="M4 9.5h3l4.5-4v13L7 14.5H4z"/><path d="m16 9.5 5 5m0-5-5 5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>',
  upload: '<path d="M12 15V4m0 0L7.5 8.5M12 4l4.5 4.5"/><path d="M4.5 14.5v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3"/>',
  paste: '<rect x="5.5" y="5" width="13" height="16" rx="2.5"/><path d="M9 5a3 3 0 0 1 6 0v1H9z"/><path d="M9 11h6M9 15h4"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>',
  files: '<path d="M8 4.5h6.5L19 9v8.5a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2Z"/><path d="M14 4.5V9h5"/>',
  video: '<rect x="3.5" y="6" width="12" height="12" rx="2.5"/><path d="m15.5 10.5 5-3v9l-5-3"/>',
  audio: '<path d="M9 17.5V6.5l10-2v11"/><circle cx="6.5" cy="17.5" r="2.5"/><circle cx="16.5" cy="15.5" r="2.5"/>',
  // The Naqi sign: a music note with a line through it (music gone, the rest stays)
  'music-off': '<path d="M9 17.5V8m0-1.5V6.5l10-2v9"/><circle cx="6.5" cy="17.5" r="2.5"/><path d="M4 4l16 16"/>',
  wave: '<path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  save: '<path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5"/><path d="M5 19.5h14"/>',
  back: '<path d="M15 5.5 8.5 12l6.5 6.5"/>',
  down: '<path d="m6 9.5 6 6 6-6"/>',
  close: '<path d="m6.5 6.5 11 11m0-11-11 11"/>',
  add: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  trash: '<path d="M4.5 7h15M10 4.5h4M6.5 7l.9 11.2a2 2 0 0 0 2 1.8h5.2a2 2 0 0 0 2-1.8L17.5 7"/><path d="M10 11v5m4-5v5"/>',
  flag: '<path d="M5.5 20.5V4.5"/><path d="M5.5 5h11l-2.5 4 2.5 4h-11"/>',
  warning: '<path d="M10.3 4.6a2 2 0 0 1 3.4 0l7 12.2a2 2 0 0 1-1.7 3H5a2 2 0 0 1-1.7-3z"/><path d="M12 10v3.5"/><circle cx="12" cy="16.6" r=".6" fill="currentColor"/>',
  error: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5.5"/><circle cx="12" cy="16.2" r=".6" fill="currentColor"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><circle cx="12" cy="7.9" r=".6" fill="currentColor"/>',
  done: '<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.3 2.4 2.4 4.8-5"/>',
  sun: '<circle cx="12" cy="12" r="3.8"/><path d="M12 2.8v2M12 19.2v2M2.8 12h2M19.2 12h2M5.5 5.5l1.4 1.4M17.1 17.1l1.4 1.4M5.5 18.5l1.4-1.4M17.1 6.9l1.4-1.4"/>',
  moon: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10Z"/>',
  system: '<rect x="3.5" y="4.5" width="17" height="12" rx="2"/><path d="M9 20h6M12 16.5V20"/>',
  library: '<path d="M5 4.5v15M9.5 4.5v15"/><path d="m14 5.2 4.3 14"/>',
  sidebar: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.5 4.5v15"/><path d="M6 8.5h1M6 11h1"/>',
  chip: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/><path d="M9.5 3.5v3M14.5 3.5v3M9.5 17.5v3M14.5 17.5v3M3.5 9.5h3M3.5 14.5h3M17.5 9.5h3M17.5 14.5h3"/>',
  keys: '<rect x="3" y="6.5" width="18" height="11" rx="2.5"/><path d="M7 10.2h.01M10.3 10.2h.01M13.7 10.2h.01M17 10.2h.01M8.5 14h7"/>',
  full: '<path d="M4.5 9V6a1.5 1.5 0 0 1 1.5-1.5h3M15 4.5h3A1.5 1.5 0 0 1 19.5 6v3M19.5 15v3a1.5 1.5 0 0 1-1.5 1.5h-3M9 19.5H6A1.5 1.5 0 0 1 4.5 18v-3"/>',
  'full-exit': '<path d="M9 4.5V7.5A1.5 1.5 0 0 1 7.5 9h-3M19.5 9h-3A1.5 1.5 0 0 1 15 7.5v-3M15 19.5v-3a1.5 1.5 0 0 1 1.5-1.5h3M4.5 15h3A1.5 1.5 0 0 1 9 16.5v3"/>',
  mini: '<rect x="2.5" y="4.5" width="19" height="15" rx="2"/><rect x="12" y="12" width="7" height="5" rx="1" fill="currentColor" stroke="none"/>',
  pip: '<path d="M10 19.5H4.5a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2h15a2 2 0 0 1 2 2V10"/><rect x="12.5" y="12.5" width="9.5" height="7" rx="1.5" fill="currentColor" stroke="none"/>',
  theater: '<rect x="2.5" y="6.5" width="19" height="11" rx="2"/>',
  'theater-exit': '<rect x="2.5" y="6.5" width="19" height="11" rx="2"/><rect x="6.5" y="9.5" width="11" height="5" rx="1"/>',
  gear: '<path d="M18.59 9.96L20.9 10.66L20.9 13.34L18.59 14.04L18.1 15.22L19.24 17.34L17.34 19.24L15.22 18.1L14.04 18.59L13.34 20.9L10.66 20.9L9.96 18.59L8.78 18.1L6.66 19.24L4.76 17.34L5.9 15.22L5.41 14.04L3.1 13.34L3.1 10.66L5.41 9.96L5.9 8.78L4.76 6.66L6.66 4.76L8.78 5.9L9.96 5.41L10.66 3.1L13.34 3.1L14.04 5.41L15.22 5.9L17.34 4.76L19.24 6.66L18.1 8.78Z"/><circle cx="12" cy="12" r="2.9"/>',
  speed: '<path d="M4.6 16.5a8 8 0 1 1 14.8 0"/><path d="m12 13 3.6-4.2"/><circle cx="12" cy="13.4" r="1.1" fill="currentColor" stroke="none"/>',
  steady: '<path d="M3.5 7.5h3m11 0h3m-17 9h3m11 0h3"/><path d="M8.5 10v4M12 9v6M15.5 10v4"/>',
  marks: '<rect x="3" y="9.5" width="6" height="5" rx="2.5"/><rect x="15" y="9.5" width="6" height="5" rx="2.5"/><path d="M9 12h6"/>',
  quality: '<rect x="3.5" y="5.5" width="17" height="13" rx="2.5"/><path d="M8.5 15v-1.5M12 15v-4M15.5 15V9"/>',
  sleep: '<path d="M16.5 15A7 7 0 0 1 8 6.5a7 7 0 1 0 8.5 8.5Z"/><path d="M14.5 3.5h4.5l-4.5 5h4.5"/>',
  next: '<path d="m9 5.5 6.5 6.5L9 18.5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 4.5 4.5"/>',
  options: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  'thumb-down': '<path d="M16.5 13.5V4.5h3v9z"/><path d="M16.5 13.5 13 20a2 2 0 0 1-2.4-2.4l.9-3.6H6a2 2 0 0 1-2-2.3l1.1-5.5A2 2 0 0 1 7 4.5h9.5"/>',
  'thumb-up': '<path d="M7.5 10.5v9h-3v-9z"/><path d="M7.5 10.5 11 4a2 2 0 0 1 2.4 2.4l-.9 3.6H18a2 2 0 0 1 2 2.3l-1.1 5.5a2 2 0 0 1-1.9 1.7H7.5"/>',
}

export const iconNames = Object.keys(P)

export function icon(name, cls = '') {
  const body = P[name]
  if (!body) throw new Error(`No icon named "${name}"`)
  return `<svg class="icon ${cls} i-${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
}

// Replaces every <i data-icon="name" class="..."> inside root with its SVG (keeps the extra classes).
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('i[data-icon]')) {
    el.outerHTML = icon(el.dataset.icon, el.className)
  }
}
