// Builds the installer you can give to someone else (T7.1): npm run installer. Takes a while (the engine is several GB).
// 1. the window (electron-vite build), 2. the engine packed by PyInstaller (build/naqi_engine.spec: ffmpeg, deno,
// models inside), 3. one app folder: Electron's own program renamed Naqi.exe, the window in resources\app, the engine
// in resources\engine, 4. Inno Setup makes Naqi-Setup.exe.
// Work files and the result go to %USERPROFILE%\Naqi6-build (outside OneDrive on purpose; Naqi-build is old Naqi's).
// NAQI_SKIP_ENGINE=1 reuses the engine packed last time (when only the window changed).
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(process.env.USERPROFILE, 'Naqi6-build')
const app = join(out, 'app')
const iscc = join(process.env.LOCALAPPDATA, 'Programs', 'Inno Setup 6', 'ISCC.exe')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', shell: cmd === 'npm' })
const t0 = Date.now()
const step = (text) => console.log(`\n[${((Date.now() - t0) / 1000).toFixed(0)} s] ${text}`)

step('1/4 Building the window (electron-vite)...')
run('npm', ['run', 'build'])

const engine = join(out, 'dist', 'NaqiEngine')
if (process.env.NAQI_SKIP_ENGINE && existsSync(join(engine, 'NaqiEngine.exe'))) step('2/4 Engine: reusing the one packed last time')
else {
  step('2/4 Packing the engine (PyInstaller)...')
  run('py', ['-3.12', '-m', 'PyInstaller', join('build', 'naqi_engine.spec'), '--noconfirm',
    '--distpath', join(out, 'dist'), '--workpath', join(out, 'work')])
}

step('3/4 Putting the app folder together...')
rmSync(app, { recursive: true, force: true })
cpSync(join(root, 'node_modules', 'electron', 'dist'), app, { recursive: true })
renameSync(join(app, 'electron.exe'), join(app, 'Naqi.exe'))
rmSync(join(app, 'resources', 'default_app.asar'), { force: true })
const res = join(app, 'resources', 'app')
mkdirSync(join(res, 'build'), { recursive: true })
writeFileSync(join(res, 'package.json'), JSON.stringify({ name: pkg.name, productName: pkg.productName, version: pkg.version, description: pkg.description,
  main: pkg.main }, null, 2))
cpSync(join(root, 'out'), join(res, 'out'), { recursive: true })
cpSync(join(root, 'build', 'icon.ico'), join(res, 'build', 'icon.ico'))
cpSync(engine, join(app, 'resources', 'engine'), { recursive: true })
run('py', ['-3.12', join('build', 'exe_resources.py'), join(app, 'Naqi.exe'), join(root, 'build', 'icon.ico'), pkg.version])
// credits and licence texts (SPEC 2c): THIRD-PARTY-NOTICES.txt with the packed Python packages listed, and licenses\
cpSync(join(root, 'licenses'), join(app, 'licenses'), { recursive: true })
run('py', ['-3.12', join('build', 'third_party.py'), join(app, 'resources', 'engine'), join(app, 'THIRD-PARTY-NOTICES.txt')])

step('4/4 Making the installer (Inno Setup)...')
run(iscc, ['/Q', `/DSourceDir=${app}`, `/DAppVersion=${pkg.version}`, `/O${join(out, 'installer')}`,
  join('build', 'installer.iss')])

step(`Done. The installer is in: ${join(out, 'installer', 'Naqi-Setup.exe')}`)
