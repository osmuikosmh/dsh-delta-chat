import { randomUUID } from 'node:crypto'

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
    this.maxTokens = options.maxTokens
    this.timeoutMs = options.timeoutMs || 10 * 60_000
    this.sessionPrefix = options.sessionPrefix || 'delta-chat'
    this.permissions = options.permissions || 'danger-full-access'
    /** Agent preset to mount; empty means the deployment default preset. */
    this.preset = options.preset || ''
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
    this.handle = null
    this.agent = null
    this.unsubscribe = null
    this.sessionId = null
    this.lastText = ''
    this.toolCalls = []
  }

  get ready() {
    return Boolean(this.agent)
  }

  #systemText() {
    const value = typeof this.systemPrompt === 'function' ? this.systemPrompt() : this.systemPrompt
    return String(value || '').trim()
  }

  #selection() {
    try {
      const service = this.ctx.agentDefaultModel || this.ctx.get?.('agentDefaultModel')
      const value = service?.currentSelection?.()
      if (value && typeof value === 'object') return value
    } catch {}
    return {}
  }

  /**
   * Look up an optional DSH service without the cordis property guard. Direct
   * `ctx.name` access on a service that the plugin did not `inject` throws
   * "cannot get property ... without inject"; `ctx.get` reads the registry.
   */
  #service(name) {
    try {
      return this.ctx.get?.(name)
    } catch {
      return undefined
    }
  }

  /**
   * Mount an agent preset into the scoped context. Without this the agent has
   * no tool composition and no base instructions — the same thing the Web GUI
   * does through its session controller before publishing an agent.
   */
  async #mountPreset(agentCtx) {
    const presets = this.#service('agentPresets')
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
      const presets = this.#service('permissionPresets')
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
    if (this.agent) return this.agent
    const agents = this.ctx.agents || this.ctx.get?.('agents')
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
    const meta = { cwd: this.cwd }
    const presets = this.#service('agentPresets')
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
        if (systemText && agentCtx?.systemPrompt?.section) {
          agentCtx.systemPrompt.section({
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
        if (text) this.lastText = text
      }
    })
    this.logger?.info?.(`[delta-chat] ${this.sessionPrefix} agent ready: ${sessionId}`)
    return this.agent
  }

  async ask(prompt, { signal, timeoutMs } = {}) {
    await this.ensure()
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
      agent.followup(userMessage(prompt))
      await Promise.race([agent.whenIdle(), timedOut, aborted])
    } finally {
      if (timer) clearTimeout(timer)
      if (onAbort) signal?.removeEventListener('abort', onAbort)
    }
    return { text: this.lastText.trim(), tools: this.toolCalls.slice() }
  }

  async dispose() {
    try { this.unsubscribe?.() } catch {}
    this.unsubscribe = null
    const handle = this.handle
    this.handle = null
    this.agent = null
    this.sessionId = null
    if (handle) {
      await handle.dispose().catch((error) => {
        this.logger?.warn?.(`[delta-chat] ${this.sessionPrefix} agent dispose: ${error?.message || error}`)
      })
    }
  }
}
