import { randomUUID } from 'node:crypto'

/**
 * Read an optional DSH service through the registry instead of `ctx.name`.
 * Cordis throws "cannot get property ... without inject" when a plugin
 * touches a service it did not declare, so shared helpers stay inject-safe.
 */
export function serviceOf(ctx, name) {
  try {
    return ctx?.get?.(name)
  } catch {
    return undefined
  }
}

function userMessage(text) {
  return Object.freeze({
    id: `delta-chat-${randomUUID()}`,
    role: 'user',
    content: Object.freeze([{ type: 'text', text: String(text) }]),
    source: Object.freeze({ kind: 'user' }),
  })
}

function textBlocks(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * A background DSH Agent owned by the Delta Chat plugin.
 *
 * A bare `ctx.tools.execute` call has no session, cwd, approval, or sandbox
 * context, so shell/file tools would be unreliable. Running a real Agent gives
 * each Delta Chat conversation the same tool surface and execution
 * environment as the Web GUI - inside a system-prompt scope the plugin owns.
 *
 * The bridge is created when the service needs it and disposed when the
 * service stops, so no agent outlives the chat service.
 */
export class AgentBridge {
  constructor(ctx, options = {}) {
    this.ctx = ctx
    this.logger = options.logger
    this.cwd = options.cwd
    this.workspaceTitle = options.workspaceTitle || ''
    this.workspaceId = undefined
    this.workspaceError = ''
    this.maxTokens = options.maxTokens
    this.timeoutMs = options.timeoutMs || 10 * 60_000
    this.sessionPrefix = options.sessionPrefix || 'delta-chat'
    this.permissions = options.permissions || 'danger-full-access'
    /** Agent preset to mount; empty means the deployment default preset. */
    this.preset = options.preset || ''
    /**
     * Model selection inherited from the session that started the service.
     * Falls back to the deployment default when absent.
     */
    this.selection = options.selection || null
    /**
     * Full system prompt for this agent: a string, or a function evaluated at
     * creation time (so edited prompt files are picked up for new agents).
     */
    this.systemPrompt = options.systemPrompt ?? ''
    /**
     * Extra setup for the scoped agent context: tool restrictions/guards and
     * anything else that must exist before the agent is published.
     */
    this.setup = options.setup ?? null
    /** Called with the new session id whenever an agent is (re)created. */
    this.onSession = options.onSession ?? null
    /** Called with a mid-turn reply text once the step after it has started. */
    this.onMidText = options.onMidText ?? null
    /** Recycle the agent session after this many replies, so its context cannot grow. */
    this.sessionTurns = Math.max(1, Number(options.sessionTurns) || 1)
    this.turns = 0
    this.systemTextSnapshot = ''
    this.handle = null
    this.agent = null
    this.unsubscribe = null
    this.sessionId = null
    this.lastText = ''
    this.midDelivered = 0
    this.toolCalls = []
    /** True from the moment a turn is submitted until its idle event. */
    this.busy = false
  }

  get ready() {
    return Boolean(this.agent)
  }

  #systemText() {
    const value = typeof this.systemPrompt === 'function' ? this.systemPrompt() : this.systemPrompt
    return String(value || '').trim()
  }

  #selection() {
    if (this.selection && typeof this.selection === 'object') return { ...this.selection }
    try {
      const service = serviceOf(this.ctx, 'agentDefaultModel')
      const value = service?.currentSelection?.()
      if (value && typeof value === 'object') return value
    } catch {}
    return {}
  }

  /**
   * Mount an agent preset into the scoped context. Without this the agent has
   * no tool composition and no base instructions — the same thing the Web GUI
   * does through its session controller before publishing an agent.
   */
  /**
   * Register the working folder as a Workspace and attach this session to it.
   * The GUI groups sessions by Workspace; a session nobody attached lands in
   * the "ungrouped" bucket, which hides its preset and system prompt. Retried
   * on every turn because the session header may not be readable yet at the
   * moment the agent is created.
   */
  async #attachWorkspace() {
    if (this.workspaceId !== undefined) return true
    const registry = serviceOf(this.ctx, 'workspaceRegistry')
    if (!registry?.create || !registry?.attachSession || !this.cwd) return false
    try {
      const ws = await registry.create(this.cwd, this.workspaceTitle || '大肥鱼')
      this.workspaceId = ws?.id
      await registry.attachSession(this.sessionId)
      this.workspaceError = ''
      return true
    } catch (error) {
      this.workspaceError = String(error?.message || error)
      this.logger?.warn?.(`[delta-chat] ${this.sessionPrefix} workspace attach failed: ${this.workspaceError}`)
      return false
    }
  }

  /** True once the session is listed under a Workspace (for status output). */
  get attached() {
    return this.workspaceId !== undefined
  }

  async #mountPreset(agentCtx) {
    const presets = serviceOf(this.ctx, 'agentPresets')
    if (!presets?.resolve || !presets?.mount) return undefined
    try {
      const resolved = await presets.resolve(this.preset || undefined)
      await presets.mount(agentCtx, resolved.id)
      return resolved.id
    } catch (error) {
      this.logger?.warn?.(`[delta-chat] ${this.sessionPrefix} preset mount failed: ${error?.message || error}`)
      return undefined
    }
  }

  #pinPermissions(agent) {
    const name = this.permissions
    try {
      const presets = serviceOf(this.ctx, 'permissionPresets')
      if (!presets?.set || !agent?.session) throw new Error('permissionPresets service unavailable')
      presets.set(agent.session, name)
      const actual = presets.current?.(agent.session)
      if (actual !== undefined && actual !== name) throw new Error(`session reports preset "${actual}"`)
    } catch (error) {
      const message = error?.message || String(error)
      this.logger?.warn?.(`[delta-chat] ${this.sessionPrefix} permissions: ${message}`)
      // Fail closed: a friend session that cannot be pinned to read-only must
      // not run with broader sandbox or approval rights.
      if (name !== 'danger-full-access') throw new Error(`无法把会话权限锁定为 ${name}：${message}`)
    }
  }

  async ensure() {
    if (this.agent) {
      const fresh = this.#systemText()
      // Edited prompt file, or a session that has answered too many times:
      // start a fresh agent instead of letting context pile up.
      if (this.turns >= this.sessionTurns || fresh !== this.systemTextSnapshot) await this.dispose()
      else return this.agent
    }
    const agents = serviceOf(this.ctx, 'agents')
    if (!agents?.create) throw new Error('DSH agents 服务不可用，无法创建聊天子智能体')

    const selection = this.#selection()
    const sessionId = `${this.sessionPrefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
    const agentOptions = {
      ...(selection.provider ? { provider: selection.provider } : {}),
      ...(selection.model ? { model: selection.model } : {}),
      reasoningEffort: selection.reasoningEffort || 'high',
      ...(this.maxTokens ? { maxTokens: this.maxTokens } : {}),
    }
    const systemText = this.#systemText()
    this.systemTextSnapshot = systemText
    this.turns = 0
    const meta = { cwd: this.cwd }
    const presets = serviceOf(this.ctx, 'agentPresets')
    // Resolve up front so the session header records the mounted preset.
    if (presets?.resolve) {
      try {
        const resolved = await presets.resolve(this.preset || undefined)
        meta.agentPreset = resolved.id
      } catch (error) {
        this.logger?.warn?.(`[delta-chat] ${this.sessionPrefix} preset resolve failed: ${error?.message || error}`)
      }
    }
    const handle = await agents.create({
      sessionId,
      meta,
      agentOptions,
      setup: async (agentCtx, agent) => {
        await this.#mountPreset(agentCtx)
        const systemPrompt = serviceOf(agentCtx, 'systemPrompt')
        if (systemText && systemPrompt?.section) {
          systemPrompt.section({
            name: 'delta-chat:persona',
            order: 0,
            text: systemText,
          })
        }
        this.#pinPermissions(agent)
        await this.setup?.(agentCtx, agent)
      },
    })
    this.handle = handle
    this.agent = handle.agent
    this.sessionId = handle.agent.id
    await this.#attachWorkspace()
    try { this.onSession?.(this.sessionId) } catch {}
    this.unsubscribe = this.ctx.on('session/event', (session, event) => {
      if (!this.agent || session?.id !== this.sessionId) return
      if (event.type === 'tool/call') {
        this.toolCalls.push({
          name: event.data?.name || '?',
          arguments: String(event.data?.arguments || '').slice(0, 500),
        })
        if (this.toolCalls.length > 20) this.toolCalls.shift()
      } else if (event.type === 'assistant/message') {
        const text = textBlocks(event.data?.message)
        if (!text) return
        this.lastText = text
        // Speak it right now. The final reply path de-duplicates the case
        // where this turns out to be the last message of the turn, so nothing
        // is ever repeated and nothing waits for the turn to end.
        try {
          this.onMidText?.(text)
          this.midDelivered += 1
        } catch {}
      }
    })
    this.logger?.info?.(`[delta-chat] ${this.sessionPrefix} agent ready: ${sessionId}`)
    return this.agent
  }

  /**
   * Push new input into the turn that is running right now.
   *
   * `followup` always starts a *separate* turn; `steer` is the only way to
   * reach the current one (the driver claims it at its next step boundary).
   * Returns false when there is no running turn to steer, so callers can fall
   * back to queuing.
   */
  steer(prompt) {
    const agent = this.agent
    if (!agent || !this.busy || agent.status !== 'running') return false
    try {
      agent.steer(userMessage(prompt))
      return true
    } catch (error) {
      this.logger?.warn?.(`[delta-chat] ${this.sessionPrefix} steer failed: ${error?.message || error}`)
      return false
    }
  }

  async ask(prompt, { signal, timeoutMs } = {}) {
    await this.ensure()
    if (!this.attached) await this.#attachWorkspace()
    const agent = this.agent
    this.lastText = ''
    this.toolCalls = []
    let timer = null
    let onAbort = null
    const aborted = new Promise((_, reject) => {
      if (!signal) return
      if (signal.aborted) {
        reject(new Error('aborted'))
        return
      }
      onAbort = () => {
        try { agent.cancel?.({ kind: 'user' }) } catch {}
        reject(new Error('aborted'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { agent.cancel?.({ kind: 'user' }) } catch {}
        reject(new Error('聊天子智能体超时'))
      }, Math.max(30_000, Number(timeoutMs) || this.timeoutMs))
    })
    try {
      this.busy = true
      agent.followup(userMessage(prompt))
      await Promise.race([agent.whenIdle(), timedOut, aborted])
    } finally {
      this.busy = false
      if (timer) clearTimeout(timer)
      if (onAbort) signal?.removeEventListener('abort', onAbort)
      this.turns += 1
    }
    return { text: this.lastText.trim(), tools: this.toolCalls.slice() }
  }

  async dispose() {
    try { this.unsubscribe?.() } catch {}
    this.unsubscribe = null
    const handle = this.handle
    const sessionId = this.sessionId
    this.handle = null
    this.agent = null
    this.sessionId = null
    if (handle) {
      await handle.dispose().catch((error) => {
        this.logger?.warn?.(`[delta-chat] ${this.sessionPrefix} agent dispose: ${error?.message || error}`)
      })
    }
    await this.#archiveSession(sessionId)
  }

  /**
   * Hide a finished session from the GUI's session list. Each reply uses a
   * throwaway session, so without this every message leaves another entry
   * under 未分组.
   */
  async #archiveSession(sessionId) {
    if (!sessionId) return
    const registry = serviceOf(this.ctx, 'workspaceRegistry')
    if (!registry?.archiveSession) return
    try {
      await registry.archiveSession(sessionId, { stopActivity: true })
      this.archived += 1
    } catch (error) {
      // Already archived or already gone is fine; anything else is worth a
      // line in the log but must never break disposal.
      this.logger?.debug?.(`[delta-chat] ${this.sessionPrefix} archive ${sessionId}: ${error?.message || error}`)
    }
  }
}
