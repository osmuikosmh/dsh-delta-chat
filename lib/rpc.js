import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import readline from 'node:readline'

// Every kernel this process spawned, so a dsh exit (or a crash) never leaves
// an orphan holding accounts.lock.
const LIVE_CHILDREN = new Set()
let exitHookInstalled = false

function trackChild(proc) {
  LIVE_CHILDREN.add(proc)
  proc.once('exit', () => LIVE_CHILDREN.delete(proc))
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once('exit', () => {
    for (const child of LIVE_CHILDREN) {
      try { child.kill('SIGKILL') } catch {}
    }
  })
}

/**
 * Minimal JSON-RPC 2.0 client for `deltachat-rpc-server`.
 *
 * The server speaks newline-delimited JSON over stdio. It is intentionally
 * dependency-free: the plugin ships its own arm64 binary and only needs the
 * handful of methods used by the chat service.
 */
export class DeltaRpc extends EventEmitter {
  constructor(bin, accountsDir, options = {}) {
    super()
    this.bin = bin
    this.accountsDir = accountsDir
    this.timeoutMs = options.timeoutMs ?? 60_000
    this.proc = undefined
    this.rl = undefined
    this.nextId = 1
    this.pending = new Map()
    this.stderrTail = []
    this.closed = false
    this.stopping = false
  }

  get running() {
    return this.proc !== undefined && this.proc.exitCode === null && !this.closed
  }

  async start() {
    if (this.running) return this
    this.closed = false
    this.stopping = false
    this.stderrTail = []
    this.proc = spawn(this.bin, [], {
      env: { ...process.env, DC_ACCOUNTS_PATH: this.accountsDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    trackChild(this.proc)

    this.proc.on('error', (error) => {
      this.#failAll(new Error(`Delta Chat RPC server failed to start: ${error.message}`))
      this.emit('error', error)
    })
    this.proc.on('exit', (code, signal) => {
      const wasStopping = this.stopping
      this.closed = true
      this.#failAll(
        new Error(
          `Delta Chat RPC server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})` +
            (this.stderrTail.length ? `: ${this.stderrTail.slice(-3).join(' | ')}` : ''),
        ),
      )
      if (!wasStopping) this.emit('exit', { code, signal })
    })

    this.proc.stdin.on('error', () => {})
    this.proc.stderr.setEncoding('utf8')
    this.proc.stderr.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) {
        const text = line.trim()
        if (!text) continue
        this.stderrTail.push(text)
        if (this.stderrTail.length > 40) this.stderrTail.shift()
        this.emit('stderr', text)
      }
    })

    this.rl = readline.createInterface({ input: this.proc.stdout })
    this.rl.on('line', (line) => this.#handleLine(line))

    // `--version` is the only CLI flag the server understands; account data
    // location comes from DC_ACCOUNTS_PATH above.
    await this.call('get_all_accounts', [], { timeoutMs: 15_000 })
    return this
  }

  #handleLine(line) {
    const text = String(line).trim()
    if (!text) return
    let message
    try {
      message = JSON.parse(text)
    } catch {
      this.emit('stderr', `non-JSON stdout: ${text.slice(0, 200)}`)
      return
    }
    if (message && message.id !== undefined && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id)
      this.pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) {
        const err = new Error(
          typeof message.error === 'string' ? message.error : JSON.stringify(message.error),
        )
        err.rpc = message.error
        entry.reject(err)
      } else {
        entry.resolve(message.result)
      }
      return
    }
    // Notifications carry `method` (e.g. ConfigureProgress, IncomingMsg).
    this.emit('event', message)
  }

  call(method, params = [], options = {}) {
    if (!this.proc || this.closed) {
      return Promise.reject(new Error('Delta Chat RPC server is not running'))
    }
    const id = this.nextId++
    const timeoutMs = options.timeoutMs ?? this.timeoutMs
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Delta Chat RPC timeout: ${method} (${timeoutMs}ms)`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer, method })
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params })
      try {
        this.proc.stdin.write(payload + '\n')
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  #failAll(error) {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      this.pending.delete(id)
      entry.reject(error)
    }
  }

  async stop({ timeoutMs = 5_000 } = {}) {
    this.stopping = true
    this.closed = true
    this.#failAll(new Error('Delta Chat RPC client stopped'))
    if (this.rl) {
      try { this.rl.close() } catch {}
      this.rl = undefined
    }
    const proc = this.proc
    this.proc = undefined
    if (!proc || proc.exitCode !== null) return
    try { proc.stdin.end() } catch {}
    await new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL') } catch {}
        finish()
      }, timeoutMs)
      proc.once('exit', finish)
      try { proc.kill('SIGTERM') } catch { finish() }
    })
  }
}
