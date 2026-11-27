import { app, Menu, Tray } from 'electron'

// Naqi in the tray (T11.4, SPEC R44): closing the window hides it into the taskbar's hidden icons while the engine
// keeps its models loaded, so the next Clean and play starts at once. A click on the icon brings the window back;
// its menu has Open and Quit. Settings' switches: tray ('on' by default; 'off' = closing quits) and login ('on' =
// start with Windows, hidden in the tray; only the installed app registers itself, dev mode never does).
export const startHidden = process.argv.includes('--hidden')

let quitting = false
app.on('before-quit', () => { quitting = true })

export function applyLogin(settings) {
  if (!app.isPackaged) return
  app.setLoginItemSettings({ openAtLogin: settings.login === 'on', args: ['--hidden'] })
}

// settings(): the current settings; save(patch): keeps a change (tray_told: the first hide's balloon was shown)
export function setupTray(win, icon, settings, save) {
  const tray = new Tray(icon)
  const show = () => {
    if (win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
  tray.setToolTip('Naqi')
  const menu = Menu.buildFromTemplate([
    { label: 'Open Naqi', click: show },
    { type: 'separator' },
    { label: 'Quit Naqi', click: () => app.quit() }
  ])
  tray.setContextMenu(menu)
  tray.on('click', show)
  win.on('close', (event) => {
    if (quitting || settings().tray === 'off') return
    event.preventDefault()
    win.hide()
    if (settings().tray_told === 'yes') return
    save({ tray_told: 'yes' })
    tray.displayBalloon({ icon, title: 'Naqi is still here',
      content: 'It stays ready in the hidden icons, so the next cleaning starts at once. Right-click the icon to quit.' })
  })
  return { tray, menu, show }   // tray and menu: the self-test clicks them
}
