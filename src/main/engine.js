import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'

const RESTARTS = 3          // restarts allowed within RESTART_WINDOW_MS...
const RESTART_WINDOW_MS = 60000
const RESTART_DELAY_MS = 1000
const STOP_WAIT_MS = 3000   // ...and on quit, the engine gets this long to stop after /shutdown before it is killed

// The real python.exe behind "py -3.12", so that stopping it stops the engine (not just the py launcher).
function findPython() {
  return new Promise((resolve, reject) => {
    execFile('py', ['-3.12', '-c', 'import sys; print(sys.executable)'], { windowsHide: true, timeout: 15000 },
      (err, stdout) => (err ? reject(new Error('Python 3.12 not found (py -3.12)')) : resolve(stdout.trim())))
  })
}

// Runs engine/server.py (or, in the installed app, the packed engine NaqiEngine.exe), keeps it running, and reports
// its status: { status: 'starting' | 'ready' | 'error' | 'restarting' | 'stopped', gpu, message }
export class Engine extends EventEmitter {
  // env: extra environment for each start (the Settings page's device and keep rule, T11.2)
  constructor(engineDir, exe = null, env = () => ({})) {
    super()
    this.env = env
    this.dir = engineDir
    this.exe = exe
    this.status = { status: 'starting', gpu: null, message: null }
    this.child = null
    this.port = null
    this.token = null
    this.restarts = []
    this.quitting = false
    this.reloading = false
  }

  _set(patch) {
    this.status = { ...this.status, ...patch }
    this.emit('status', this.status)
  }

  async start() {
    this._set({ status: 'starting', message: null })
    let python
    try {
      python = this.exe || this.python || (this.python = await findPython())
    } catch (e) {
      return this._set({ status: 'stopped', message: e.message })
    }
    if (this.quitting) return
    this.token = randomBytes(32).toString('hex')
    const child = spawn(python, this.exe ? [] : ['-u', join(this.dir, 'server.py')], {
      cwd: this.dir,
      env: { ...process.env, NAQI_TOKEN: this.token, NAQI_PARENT_PID: String(process.pid), PYTHONIOENCODING: 'utf-8',
        PYTHONUNBUFFERED: '1', ...this.env() },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.child = child
    let stderr = ''
    let out = ''
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000) })
    child.stdout.on('data', (d) => {
      if (this.port && child === this.child) return
      out += d
      const line = out.split(/\r?\n/)[0]
      if (out.includes('\n')) {
        try {
          this.port = JSON.parse(line).port
          this._listen(child)
        } catch { /* not the port line; the exit handler reports it */ }
      }
    })
    child.on('error', (e) => { stderr += e.message })
    child.on('exit', (code) => {
      if (child !== this.child) return
      this.child = null
      this.port = null
      if (this.quitting) return
      if (this.reloading) { this.reloading = false; this.restarts = []; return this.start() }
      const last = stderr.trim().split(/\r?\n/).slice(-3).join(' ')
      this._died(`Engine stopped (exit code ${code})${last ? ': ' + last : ''}`)
    })
  }

  _died(message) {
    const now = Date.now()
    this.restarts = this.restarts.filter((t) => now - t < RESTART_WINDOW_MS)
    if (this.restarts.length >= RESTARTS) {
      return this._set({ status: 'stopped', message: `${message}. It stopped ${RESTARTS} times in a minute, so it was not started again.` })
    }
    this.restarts.push(now)
    this._set({ status: 'restarting', message })
    setTimeout(() => { if (!this.quitting && !this.child) this.start() }, RESTART_DELAY_MS)
  }

  // Start again by hand after it gave up.
  restart() {
    if (this.child) return
    this.restarts = []
    this.start()
  }

  // Start again with new settings (GPU or CPU, T11.2): asked to stop like on quit, then started at once
  reload() {
    const child = this.child
    if (!child) return this.restart()
    this.reloading = true
    this._set({ status: 'starting', gpu: null, message: null })
    const timer = setTimeout(() => child.kill(), STOP_WAIT_MS)
    child.once('exit', () => clearTimeout(timer))
    this.request('/shutdown', { method: 'POST' }).catch(() => child.kill())
  }

  request(path, options = {}) {
    if (!this.port) return Promise.reject(new Error('engine not running'))
    return fetch(`http://127.0.0.1:${this.port}${path}`, {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${this.token}` }
    })
  }

  // Call a JSON route; an engine refusal (busy, bad request) becomes an Error with its message.
  async call(path, body) {
    const res = await this.request(path, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || `engine answered ${res.status}`)
    return data
  }

  // naqi-media://engine/<path> (the page's <audio> / <video>) -> the engine's /media/<path>, byte ranges kept
  async media(request) {
    const path = new URL(request.url).pathname
    const range = request.headers.get('Range')
    try {
      const res = await this.request(`/media${path}`, { headers: range ? { Range: range } : {} })
      // Readable by the page with CORS (the player's Web Audio chain, T10.5c); only this app's pages can ask for it
      const headers = new Headers(res.headers)
      headers.set('Access-Control-Allow-Origin', '*')
      return new Response(res.body, { status: res.status, headers })
    } catch {
      return new Response('engine not running', { status: 503 })
    }
  }

  // Read the event stream and turn engine events into status updates.
  async _listen(child) {
    try {
      const res = await this.request('/events')
      const decoder = new TextDecoder()
      let buf = ''
      for await (const part of res.body) {
        buf += decoder.decode(part, { stream: true })
        let end
        while ((end = buf.indexOf('\n\n')) >= 0) {
          this._event(buf.slice(0, end))
          buf = buf.slice(end + 2)
        }
      }
    } catch { /* the engine stopped; its exit handler reports it */ }
    // The stream closed while the engine still runs: listen again.
    if (child === this.child && !this.quitting) setTimeout(() => { if (child === this.child) this._listen(child) }, 500)
  }

  _event(block) {
    let event = 'message'
    let data = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7)
      else if (line.startsWith('data: ')) data += line.slice(6)
    }
    if (!data) return
    const value = JSON.parse(data)
    if (event === 'gpu') this._set({ gpu: value })
    else if (event === 'state') {
      // When the engine first answered and when its models were loaded (the speed test reads these)
      if (value.state === 'ready') this.readyAt ??= Date.now()
      if (value.models) this.modelsAt ??= Date.now()
      if (value.state === 'ready') this._set({ status: 'ready', message: null })
      else if (value.state === 'error') this._set({ status: 'error', message: value.error })
      else this._set({ status: 'starting' })
    }
    this.emit('event', event, value)
  }

  // Stop the engine on quit: ask it to stop, kill it if it does not.
  stop() {
    this.quitting = true
    const child = this.child
    if (!child) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve() }, STOP_WAIT_MS)
      child.once('exit', () => { clearTimeout(timer); resolve() })
      this.request('/shutdown', { method: 'POST' }).catch(() => child.kill())
    })
  }
}
