import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MemoryKeeper } from './memory.js'
import { DeltaRpc } from './rpc.js'
import { resolveBinary } from './rpc-binary.js'
import { ChatStore } from './store.js'
import { DEFAULT_CONFIG } from './defaults.js'
import { ensurePromptsDir } from './config-store.js'
export { DEFAULT_CONFIG } from './defaults.js'
import { AgentBridge, serviceOf } from './agent-bridge.js'
import { OwnerAgentBridge } from './owner.js'
import { PromptFiles } from './prompts.js'
import { FRIEND_TOOLS, friendToolGuard } from './tool-policy.js'
import { ensureWorkspace, isInside, realRoot, safeFileName, uniquePath, workspaceFor } from './workspace.js'
import { detectLinkRequest, parseSyncCommand, parseUnlinkCommand, mergeMemoryText, wantsSyncInvite } from './identity.js'
import {
  composeSystemPrompt,
  memoryBlock,
  MEMORY_RULES,
  fallbackMessages,
  formatTranscript,
  moodLine,
  TRANSCRIPT_LIMIT,
  friendPrompt,
  nowParts,
  ownerSystemPrompt,
  parseReply,
  splitReply,
  wantsSilence,
  proactivePrompt,
  wakePrompt,
  carePrompt,
} from './persona.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(HERE, '..')

const VIEW_LABELS = {
  Image: '图片',
  Gif: '动图',
  Sticker: '表情包',
  Video: '视频',
  Voice: '语音',
  Audio: '音频',
  File: '文件',
  Webxdc: '小应用',
}


function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'))
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = () => {
      cleanup()
      reject(new Error('aborted'))
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}


function accountList(value) {
  if (Array.isArray(value)) return value
  if (value && Array.isArray(value.accounts)) return value.accounts
  return []
}

function transportList(value) {
  if (Array.isArray(value)) return value
  if (value && Array.isArray(value.transports)) return value.transports
  return []
}

function inviteAddress(invite) {
  try {
    const fragment = String(invite || '').split('#')[1] || ''
    const addr = new URLSearchParams(fragment).get('a')
    return addr ? decodeURIComponent(addr).trim().toLowerCase() : null
  } catch {
    return null
  }
}

function cleanError(error) {
  const text = String(error?.message || error || 'unknown')
  return text.replace(/\s+/g, ' ').slice(0, 600)
}

function ownerMessages(text) {
  const value = String(text || '').trim()
  if (!value) return []
  // Long command output is easier to read as one block; ordinary chat is
  // split into a couple of human-sized bubbles.
  if (value.length > 900 || value.includes('\n')) {
    return [value.slice(0, 4000)]
  }
  const parts = value
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length <= 1) return [value.slice(0, 2000)]
  const merged = []
  for (const part of parts) {
    if (merged.length && merged[merged.length - 1].length + part.length < 240) {
      merged[merged.length - 1] += `\n${part}`
    } else {
      merged.push(part)
    }
    if (merged.length >= 3) break
  }
  return merged.map((part) => part.slice(0, 2000))
}

/**
 * Background Delta Chat friend. Owns the RPC server, the account lifecycle,
 * the message loop, and the human-like reply timing.
 */
export class DeltaChatService {
  constructor(ctx, config = {}, logger) {
    this.ctx = ctx
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.logger = logger
    this.store = new ChatStore(this.config.dataDir)
    // Style wording lives in prompts/persona.md; the structural rules stay
    // hardcoded and are concatenated with the file at agent creation.
    // Style prompt: `~/.dsh/delta-chat/prompts/persona.md` (seeded from the
    // copy shipped with the plugin); config.promptDir still overrides it.
    const promptDir = this.config.promptDir && String(this.config.promptDir).trim()
      ? String(this.config.promptDir).trim()
      : ensurePromptsDir(this.config)
    this.prompts = new PromptFiles({ dir: promptDir, logger })
    /**
     * Inherited from the session that called `delta_chat_start`: cwd, agent
     * preset and model selection used by every chat agent (null = config
     * default).
     */
    this.session = null
    this.owner = this.#ownerBridge()
    /** Abnormal-exit retry bookkeeping (attempts, timer, fatal flag). */
    this.retry = { attempts: 0, timer: null, fatal: false }
    /** One chat agent per Delta Chat conversation; disposed with the service. */
    this.chatAgents = new Map()
    /** agent sessionId -> chatId, so an agent can speak before its turn ends. */
    this.sayTargets = new Map()
    /** chatId -> [{ text, at }]: what was already said mid-turn, for de-duplication. */
    this.sayLog = new Map()
    /** Chat of the owner request currently running (owner agents are shared). */
    this.ownerChatId = null
    /**
     * Long-term memory: older messages get folded into `chat.longMemory`, so
     * prompts stay short no matter how long a chat has been going.
     */
    this.memory = new MemoryKeeper({
      ask: (prompt) => this.#memoryAsk(prompt),
      logger,
      cap: Number(this.config.memoryChars) || 3000,
      keep: Number(this.config.transcriptLimit) || TRANSCRIPT_LIMIT,
    })
    this.memoryAgent = null
    this.rpc = null
    this.running = false
    this.starting = null
    this.abort = null
    this.pollTask = null
    this.proactiveTimer = null
    this.pending = new Map()
    /** chatId -> { startedAt, lastInterjectAt }: busy-with-a-reply windows. */
    this.thinking = new Map()
    this.pairAttempts = new Map()
    /** code -> { from, to, fromChatId, toChatId, at }: pending identity links. */
    this.pendingLinks = new Map()
    /** One-time sync invites: code -> { from, fromChatId, at }. */
    this.syncInvites = new Map()
    /** Chat of the most recent owner request, used by the send-file tool. */
    this.lastOwnerChatId = null
    /** Chat whose agent is running right now, used by delta_chat_schedule. */
    this.lastActiveChatId = null
    this.lastActiveIsOwner = false
    this.scheduleTimer = null
    this.careTimer = null
    this.transportAddrs = new Set()
    this.work = Promise.resolve()
    this.startedAt = null
    this.lastPollAt = null
    this.account = null
    try { this.store.load() } catch (error) {
      logger?.warn?.(`[delta-chat] 读取本地状态失败：${cleanError(error)}`)
    }
  }

  async start(options = {}) {
    if (options?.session) this.session = options.session
    if (this.retry.timer) {
      clearTimeout(this.retry.timer)
      this.retry.timer = null
    }
    this.retry.fatal = false
    if (this.running) return this.status()
    if (this.starting) return this.starting
    this.starting = this.#start().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  async #start() {
    this.store.load()
    this.store.state.lastError = null
    this.chatAgents.clear()
    this.owner = this.#ownerBridge()
    // The bound owner lives only in state.json (and is set by the settings
    // page, /pair, or delta_chat_owner). Config files are never a second source.
    if (!this.store.state.ownerAddr && !this.store.state.pairCode) {
      this.store.state.pairCode = String(Math.floor(100000 + Math.random() * 900000))
    }
    this.store.save()
    const resolved = resolveBinary(this.config, { packageRoot: PACKAGE_ROOT })
    this.binaryInfo = resolved
    this.store.audit('rpc.binary', { path: resolved.path, source: resolved.source, target: `${process.platform}-${process.arch}` })
    this.rpc = new DeltaRpc(resolved.path, this.store.rpcDir)
    this.rpc.on('stderr', (line) => this.logger?.debug?.(`[delta-chat] rpc: ${line}`))
    this.rpc.on('exit', ({ code, signal }) => {
      if (!this.running) return
      const reason = `Delta Chat 内核退出（code=${code}, signal=${signal}）`
      this.running = false
      this.#setError(reason)
      this.#clearTimers()
      this.#onAbnormalClose(reason)
    })
    try {
      await this.rpc.start()
      const account = await this.#ensureAccount()
      this.account = account
      await this.rpc.call('start_io_for_all_accounts', [], { timeoutMs: 30_000 })
      this.running = true
      this.startedAt = Date.now()
      this.abort = new AbortController()
      this.store.state.lastStartedAt = this.startedAt
      this.store.state.lastStoppedAt = null
      // Remembered so the next DSH boot can bring the bot back up.
      this.store.state.desiredRunning = true
      this.store.state.inheritedSession = this.session || null
      this.retry.attempts = 0
      this.store.save()
      this.store.audit('service.start', { accountId: account.id, addr: account.addr })
      this.pollTask = this.#pollLoop().catch((error) => {
        if (this.running) this.#setError(`消息循环停止：${cleanError(error)}`)
      })
      const interval = Math.max(15_000, Math.min(60_000, Number(this.config.proactiveTickMs) || 45_000))
      this.proactiveTimer = setInterval(() => {
        this.#tickProactive().catch((error) => this.logger?.warn?.(`[delta-chat] proactive: ${cleanError(error)}`))
      }, interval)
      this.scheduleTimer = setInterval(() => {
        this.#tickSchedules().catch((error) => this.logger?.warn?.(`[delta-chat] scheduled: ${cleanError(error)}`))
      }, 15_000)
      return this.status()
    } catch (error) {
      this.running = false
      await this.rpc.stop().catch(() => {})
      this.rpc = null
      this.#setError(`启动失败：${cleanError(error)}`)
      throw error
    }
  }

  /**
   * Apply a new effective configuration (settings page). Rebuilds the prompt
   * reader and the owner bridge, then restarts a running service so numbers
   * like memory size / poll interval take effect immediately.
   */
  async applyConfig(rawConfig = {}) {
    const prevRunning = this.running
    this.config = { ...DEFAULT_CONFIG, ...(rawConfig || {}) }
    const promptDir = this.config.promptDir && String(this.config.promptDir).trim()
      ? String(this.config.promptDir).trim()
      : ensurePromptsDir(this.config)
    this.prompts = new PromptFiles({ dir: promptDir, logger: this.logger })
    // Owner changes do not travel through config: the settings API calls
    // setOwner() so state.json stays the single source of truth.
    this.owner = this.#ownerBridge()
    if (prevRunning) {
      await this.stop({ explicit: false }).catch(() => {})
      await this.start({ session: this.session }).catch((error) => {
        this.logger?.warn?.(`[delta-chat] reconfigure start failed: ${cleanError(error)}`)
      })
    }
    return this.status()
  }

  /**
   * Called once when the plugin loads: if the service was running when DSH
   * shut down, start it again and keep retrying an abnormal exit.
   */
  async resume() {
    if (this.running || this.starting) return this.status()
    this.store.load()
    const wanted = this.store.state.desiredRunning
    if (!wanted || !this.config.autoResume) return this.status()
    if (this.store.state.inheritedSession) this.session = this.store.state.inheritedSession
    this.store.audit('service.resume', { attempts: 0 })
    this.retry.attempts = 0
    this.#retrySoon(0)
    return this.status()
  }

  #retrySoon(delayMs) {
    if (this.retry.timer) clearTimeout(this.retry.timer)
    this.retry.timer = setTimeout(() => {
      this.retry.timer = null
      this.#retryNow().catch((error) => this.logger?.warn?.(`[delta-chat] retry: ${cleanError(error)}`))
    }, Math.max(0, delayMs))
  }

  async #retryNow() {
    if (this.running || this.starting) return
    this.retry.attempts += 1
    const attempt = this.retry.attempts
    const max = Math.max(1, Number(this.config.retryMax) || 8)
    this.store.audit('service.retry', { attempt, max })
    try {
      await this.start()
      this.store.audit('service.retry_ok', { attempt })
      this.store.state.lastError = null
      this.store.save()
      return
    } catch (error) {
      this.store.audit('service.retry_fail', { attempt, error: cleanError(error) })
      if (attempt >= max) {
        await this.#reportFatal(error).catch(() => {})
        return
      }
      const every = Math.max(1, Number(this.config.retryEveryMinutes) || 30) * 60_000
      this.#retrySoon(every)
    }
  }

  /** Crash hook: an unexpected kernel exit keeps the "should be running" flag. */
  #onAbnormalClose(reason) {
    if (!this.config.autoResume) return
    if (this.retry.timer) return
    this.store.audit('service.abnormal', { reason })
    this.store.state.desiredRunning = true
    this.store.save()
    this.retry.attempts = 0
    this.#retrySoon(0)
  }

  /**
   * Give up after the last retry: best-effort, send the shutdown log to every
   * friend over Delta Chat. If the kernel cannot come up at all, this is the
   * end of the line and the failure only lands in the audit log.
   */
  async #reportFatal(error) {
    if (this.retry.fatal) return
    this.retry.fatal = true
    const log = this.#crashLog(error)
    this.store.audit('service.fatal', { error: cleanError(error), log: log.slice(0, 2000) })
    this.store.state.lastFatalAt = Date.now()
    this.store.save()
    let rpc = this.rpc
    let spawned = false
    try {
      if (!rpc) {
        const resolved = resolveBinary(this.config, { packageRoot: PACKAGE_ROOT })
        rpc = new DeltaRpc(resolved.path, this.store.rpcDir)
        await rpc.start()
        await rpc.call('start_io_for_all_accounts', [], { timeoutMs: 30_000 })
        spawned = true
      }
      const accountId = this.store.state.accountId
      const chats = Object.values(this.store.state.chats || {}).filter((chat) => !chat.isGroup && chat.addr)
      let sent = 0
      for (const chat of chats) {
        try {
          await rpc.call('send_msg', [accountId, chat.chatId, { text: log }], { timeoutMs: 30_000 })
          sent += 1
        } catch {}
      }
      this.store.audit('service.fatal_report', { sent, chats: chats.length })
    } catch (reportError) {
      this.store.audit('service.fatal_report_failed', { error: cleanError(reportError) })
    } finally {
      if (spawned && rpc) await rpc.stop().catch(() => {})
    }
    this.store.save()
  }

  #crashLog(error) {
    const lines = [
      '大肥鱼异常关闭了。',
      `时间：${new Date().toISOString()}`,
      `连续重试失败：${this.retry.attempts} 次`,
      `最后一次错误：${cleanError(error) || this.store.state.lastError || '未知'}`,
      '',
      '最近的日志：',
    ]
    try {
      const audit = fs.readFileSync(this.store.auditFile, 'utf8').trim().split('\n').slice(-15)
      for (const line of audit) lines.push(line.slice(0, 400))
    } catch (readError) {
      lines.push(`（读取日志失败：${cleanError(readError)}）`)
    }
    return lines.join('\n')
  }

  async #ensureAccount() {
    const accounts = accountList(await this.rpc.call('get_all_accounts', [], { timeoutMs: 20_000 }))
    let id
    if (accounts.length) {
      id = Number(accounts[0].id)
    } else {
      id = Number(await this.rpc.call('add_account', [], { timeoutMs: 20_000 }))
      this.store.audit('account.created', { accountId: id })
    }
    if (!Number.isInteger(id) || id <= 0) throw new Error('Delta Chat 没有返回有效的账号 id')

    let info = null
    try { info = await this.rpc.call('get_account_info', [id], { timeoutMs: 20_000 }) } catch {}
    let transports = []
    try { transports = transportList(await this.rpc.call('list_transports', [id], { timeoutMs: 20_000 })) } catch {}
    // Only bootstrap on a truly fresh profile. `init_transports` is documented
    // to "add further ones in the background", and older versions kept adding
    // a relay on every restart which silently changed the profile address.
    const needsTransport = transports.length === 0 && (!info || info.kind !== 'Configured')
    if (needsTransport) {
      this.logger?.info?.('[delta-chat] creating chatmail transport (this can take a minute)')
      try {
        await this.rpc.call('init_transports', [id, null], { timeoutMs: 240_000 })
      } catch (error) {
        throw new Error(
          `自动创建 chatmail 账号失败：${cleanError(error)}。` +
            '这通常是当前网络无法连上 chatmail 中转站；请换网络后重试，或把已有账号的数据目录放到 dataDir/rpc。',
        )
      }
      try { transports = transportList(await this.rpc.call('list_transports', [id], { timeoutMs: 20_000 })) } catch {}
    }
    this.transportAddrs = new Set(
      transports
        .map((transport) => String(transport?.addr || '').trim().toLowerCase())
        .filter(Boolean),
    )

    await this.rpc.call(
      'batch_set_config',
      [id, { displayname: this.config.displayName || '大肥鱼', selfstatus: this.config.selfStatus || '' }],
      { timeoutMs: 20_000 },
    )

    // The securejoin QR is the authoritative source for which transport is
    // active: an account can keep older transports, and list_transports()
    // order is not a reliable indicator.
    let invite = null
    try {
      invite = await this.rpc.call('get_chat_securejoin_qr_code', [id, null], { timeoutMs: 30_000 })
    } catch (error) {
      this.logger?.warn?.(`[delta-chat] 生成邀请链接失败：${cleanError(error)}`)
    }

    let addr = inviteAddress(invite)
    if (!addr) {
      let configured = null
      try { configured = await this.rpc.call('get_config', [id, 'addr'], { timeoutMs: 15_000 }) } catch {}
      if (configured && typeof configured === 'string') addr = configured
    }
    if (!addr) addr = transports.at(-1)?.addr || null
    try { info = await this.rpc.call('get_account_info', [id], { timeoutMs: 20_000 }) } catch {}
    if (!addr && info?.addr) addr = info.addr
    if (!addr) throw new Error('Delta Chat 账号已创建，但读不到邮箱地址（transport 未就绪）')
    if (transports.length > 1) {
      this.logger?.warn?.(`[delta-chat] 账号有 ${transports.length} 个 transport，使用当前邀请地址 ${addr}`)
    }

    this.store.state.accountId = id
    this.store.state.addr = addr
    this.store.state.displayName = this.config.displayName || '大肥鱼'
    this.store.state.invite = invite || this.store.state.invite || null
    this.store.save()
    this.store.audit('account.ready', { accountId: id, addr, invite: Boolean(invite) })
    return { id, addr, invite, info }
  }

  async #pollLoop() {
    const signal = this.abort?.signal
    while (this.running) {
      let ids = []
      try {
        ids = await this.rpc.call('get_next_msgs', [this.store.state.accountId], { timeoutMs: 120_000 })
        this.lastPollAt = Date.now()
      } catch (error) {
        if (!this.running || signal?.aborted) break
        const message = cleanError(error)
        if (/timeout/i.test(message)) continue
        this.#setError(`拉取消息失败：${message}`)
        await sleep(4000, signal).catch(() => {})
        continue
      }
      if (Array.isArray(ids)) {
        for (const id of ids) {
          if (!this.running) break
          try {
            await this.#handleIncoming(Number(id))
          } catch (error) {
            this.#setError(`处理消息 #${id} 失败：${cleanError(error)}`)
            this.store.audit('message.error', { messageId: Number(id), error: cleanError(error) })
          }
        }
      }
      await sleep(Math.max(800, Number(this.config.pollIntervalMs) || 2500), signal).catch(() => {})
    }
  }

  async #handleIncoming(messageId) {
    if (!Number.isFinite(messageId) || messageId <= 0) return
    if (this.store.seen(messageId)) return
    const messages = await this.rpc.call('get_messages', [this.store.state.accountId, [messageId]], { timeoutMs: 20_000 })
    const message = Array.isArray(messages) ? messages[0] : messages?.[messageId] ?? messages?.[String(messageId)]
    if (!message) return
    if (message.isInfo) {
      this.store.markSeen(messageId)
      this.store.save()
      return
    }
    // fromId is a contact id, not an account id: a friend's contact id can
    // legitimately equal the account id or the self-contact id (1). Only the
    // sender address reliably identifies our own outgoing messages. A profile
    // may have several transports, so check every known transport address.
    const senderAddr = String(message.sender?.address || '').trim().toLowerCase()
    if (senderAddr && (senderAddr === String(this.store.state.addr || '').toLowerCase() || this.transportAddrs.has(senderAddr))) {
      this.store.markSeen(messageId)
      return
    }

    const chatId = Number(message.chatId)
    let fullChat = null
    try {
      fullChat = await this.rpc.call('get_full_chat_by_id', [this.store.state.accountId, chatId], { timeoutMs: 15_000 })
    } catch {}
    if (fullChat?.isDeviceChat || fullChat?.isSelfTalk) {
      this.store.markSeen(messageId)
      return
    }
    if (fullChat?.isContactRequest) {
      try {
        await this.rpc.call('accept_chat', [this.store.state.accountId, chatId], { timeoutMs: 20_000 })
        fullChat = await this.rpc.call('get_full_chat_by_id', [this.store.state.accountId, chatId], { timeoutMs: 15_000 })
        this.store.audit('chat.accepted', { chatId })
      } catch (error) {
        this.store.audit('chat.accept_failed', { chatId, error: cleanError(error) })
      }
    }

    const ageHours = (Date.now() / 1000 - Number(message.timestamp || 0)) / 3600
    const isGroup = fullChat?.chatType === 'Group' || (Array.isArray(fullChat?.contactIds) && fullChat.contactIds.length > 1)
    const sender = String(message.sender?.address || '').trim().toLowerCase()
    const isOwner = Boolean(!isGroup && sender && this.#ownerAddresses().has(sender))
    let text = await this.#describeMessage(message)
    const received = await this.#receiveAttachment(messageId, message, chatId, isGroup ? '' : sender)
    if (received) text = `${text}（附件已存到 ${received.abs}）`
    if (!text) {
      this.store.markSeen(messageId)
      return
    }
    if (isGroup && !this.#addressedToMe(text, message)) {
      this.store.markSeen(messageId)
      return
    }

    const chat = this.store.chat(chatId)
    chat.name = fullChat?.name || message.sender?.displayName || message.sender?.address || chat.name || `#${chatId}`
    chat.addr = message.sender?.address || chat.addr || ''
    chat.isGroup = Boolean(isGroup)
    this.store.appendHistory(chatId, {
      id: messageId,
      role: 'friend',
      name: chat.name,
      text,
      ts: Number(message.timestamp) || Math.floor(Date.now() / 1000),
    })
    this.store.markSeen(messageId)
    await this.#markSeenRemote(messageId)
    this.store.state.stats.incoming += 1
    this.store.save()
    this.store.audit('message.in', { chatId, messageId, name: chat.name, text: text.slice(0, 300), ageHours: Math.round(ageHours) })

    if (ageHours > (Number(this.config.maxBacklogHours) || 72)) {
      this.store.audit('message.backlog_skip', { chatId, messageId, ageHours: Math.round(ageHours) })
      return
    }

    if (!isGroup && await this.#maybePair(chatId, sender, text)) return
    if (isOwner && await this.#maybeOwnerControl(chatId, text)) return
    if (!isGroup && await this.#maybeLink(chatId, sender, isOwner, text)) return

    // A leading slash means "I am trying to use a command". Anything that did
    // not match above is a command we do not know: answer with /help instead
    // of handing the raw text to the model (which has no command table).
    const typed = String(text || '').trim()
    if (/^[/／]/.test(typed)) {
      if (/^[/／](?:status|状态)$/i.test(typed)) {
        this.store.audit('command.status', { chatId })
        await this.#sendSimple(chatId, this.statusText().slice(0, 3500))
        return
      }
      const known = /^[/／](?:help|帮助|命令|\?|？)$/i.test(typed)
      this.store.audit(known ? 'command.help' : 'command.redirect', { chatId, text: typed.slice(0, 80) })
      await this.#sendSimple(chatId, this.#helpText())
      return
    }

    const item = { id: messageId, text, ts: Number(message.timestamp) || Math.floor(Date.now() / 1000) }
    if (isOwner) {
      this.#queueOwner(chatId, item)
    } else {
      this.#queueReply(chatId, item)
    }
  }

  async #maybePair(chatId, sender, text) {
    const match = /^\/(?:pair|绑定)\s+(\d{6})$/i.exec(String(text || '').trim())
    if (!match) return false
    if (this.store.state.ownerAddr) {
      await this.#sendSimple(chatId, '已经有主人了，别乱绑。')
      return true
    }
    const code = String(this.store.state.pairCode || '')
    const now = Date.now()
    let attempt = this.pairAttempts.get(sender)
    if (attempt?.lockedUntil && attempt.lockedUntil > now) {
      this.store.audit('owner.pair_locked', { sender })
      return true
    }
    if (attempt?.lockedUntil && attempt.lockedUntil <= now) {
      attempt = null
      this.pairAttempts.delete(sender)
    }
    if (!code || match[1] !== code) {
      if (!attempt) attempt = { count: 0, firstAt: now, lockedUntil: 0 }
      attempt.count += 1
      if (attempt.count >= 5) attempt.lockedUntil = now + 10 * 60_000
      this.pairAttempts.set(sender, attempt)
      this.store.audit('owner.pair_failed', { sender, attempts: attempt.count, locked: Boolean(attempt.lockedUntil) })
      if (attempt.lockedUntil) await this.#sendSimple(chatId, '试太多次了，过十分钟再试。')
      else if (attempt.count <= 3) await this.#sendSimple(chatId, '绑定码不对，再看一眼。')
      return true
    }
    this.pairAttempts.delete(sender)
    this.store.state.ownerAddr = sender
    this.store.state.ownerBoundAt = now
    this.store.state.pairCode = null
    this.store.save()
    this.store.audit('owner.bound', { addr: sender })
    await this.#sendSimple(chatId, '绑上了。以后你说话我干活，别人说话我陪聊。')
    return true
  }

  async #maybeOwnerControl(chatId, text) {
    if (!/^\/(?:unpair|解绑)\s*$/i.test(String(text || '').trim())) return false
    this.store.state.ownerAddr = null
    this.store.state.ownerBoundAt = null
    this.store.state.pairCode = String(Math.floor(100000 + Math.random() * 900000))
    this.store.save()
    this.store.audit('owner.unbound', { chatId })
    await this.owner.dispose()
    await this.#sendSimple(chatId, '行，我先变回普通网友。')
    return true
  }

  // Delta Chat only emits a read receipt for messages the core itself marks as
  // seen; the local store's markSeen() is a private bookkeeping flag. Call this
  // whenever a message has actually been read so the other side sees the ticks.
  async #markSeenRemote(messageId) {
    try {
      await this.rpc.call('markseen_msgs', [this.store.state.accountId, [messageId]], { timeoutMs: 15_000 })
    } catch (error) {
      this.store.audit('message.markseen_failed', { messageId, error: cleanError(error) })
    }
  }

  /** Send one real file (image/document/audio) with an optional caption. */
  async #sendAttachment(chatId, spec) {
    let file = String(spec?.path || '').trim()
    const caption = String(spec?.caption || '').trim().slice(0, 500)
    if (!file) return null
    let stat
    try {
      stat = fs.statSync(file)
    } catch {
      await this.#sendSimple(chatId, `找不到这个文件：${file}`)
      return null
    }
    if (stat.isDirectory()) {
      const packed = this.#packDirectory(file)
      if (!packed) {
        await this.#sendSimple(chatId, `文件夹没能打包：${path.basename(file)}（工作区里要先能写）`)
        return null
      }
      file = packed
      stat = fs.statSync(file)
    }
    if (!stat.isFile()) {
      await this.#sendSimple(chatId, `这不是文件：${file}`)
      return null
    }
    const cap = Math.max(1, Number(this.config.maxAttachmentMb) || 50) * 1024 * 1024
    if (stat.size > cap) {
      await this.#sendSimple(chatId, `文件太大（${(stat.size / 1048576).toFixed(1)}MB），超过 ${this.config.maxAttachmentMb || 50}MB 发不出去。`)
      return null
    }
    try {
      const messageId = await this.rpc.call('send_msg', [
        this.store.state.accountId,
        chatId,
        { file, text: caption || null, filename: path.basename(file) },
      ], { timeoutMs: 180_000 })
      this.store.appendHistory(chatId, {
        id: messageId,
        role: 'me',
        name: this.store.state.displayName,
        text: `（发了文件 ${path.basename(file)}${caption ? `：${caption}` : ''}）`,
        ts: Math.floor(Date.now() / 1000),
      })
      this.store.save()
      this.store.audit('attachment.out', { chatId, file, bytes: stat.size })
      return messageId
    } catch (error) {
      this.store.audit('attachment.error', { chatId, file, error: cleanError(error) })
      await this.#sendSimple(chatId, `文件没发出去：${cleanError(error)}`)
      return null
    }
  }

  /**
   * Zip one folder so it can travel as a single attachment. The archive is
   * written next to the folder (inside the sender's workspace) and the folder
   * itself is left untouched. `tar.gz` is the fallback when zip is missing.
   */
  #packDirectory(dir) {
    const parent = path.dirname(dir)
    const base = path.basename(dir)
    const zip = path.join(parent, `${base}.zip`)
    try {
      fs.rmSync(zip, { force: true })
      const result = spawnSync('zip', ['-r', '-q', '-y', zip, base], { cwd: parent, stdio: 'ignore', timeout: 300_000 })
      if (result.status === 0 && fs.existsSync(zip)) return zip
    } catch {}
    // Not every platform ships `zip` (Windows, some minimal Linux images).
    const seven = path.join(parent, `${base}.zip`)
    try {
      fs.rmSync(seven, { force: true })
      const result = spawnSync('7z', ['a', '-tzip', seven, base], { cwd: parent, stdio: 'ignore', timeout: 300_000 })
      if (result.status === 0 && fs.existsSync(seven)) return seven
    } catch {}
    const tar = path.join(parent, `${base}.tar.gz`)
    try {
      const result = spawnSync('tar', ['-czf', tar, base], { cwd: parent, stdio: 'ignore', timeout: 300_000 })
      if (result.status === 0 && fs.existsSync(tar)) return tar
    } catch {}
    return null
  }

  /**
   * Send the files a friend reply asked for. Every path is resolved against
   * the conversation workspace and refused when it escapes (a trailing `..`,
   * a symlink, or a hallucinated absolute path).
   */
  async #sendFriendFiles(chatId, files) {
    const list = Array.isArray(files) ? files.slice(0, 3) : []
    if (!list.length) return []
    const workspace = realRoot(this.#workspaceFor(chatId))
    const sent = []
    for (const spec of list) {
      const raw = String(spec?.path || '').trim()
      if (!raw) continue
      const absolute = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(workspace, raw)
      if (!isInside(workspace, absolute)) {
        this.store.audit('attachment.denied', { chatId, file: raw, reason: 'outside-workspace' })
        continue
      }
      const messageId = await this.#sendAttachment(chatId, { path: absolute, caption: spec?.caption })
      if (messageId) sent.push(messageId)
    }
    return sent
  }

  async #sendSimple(chatId, text) {
    try {
      const messageId = await this.rpc.call(
        'send_msg',
        [this.store.state.accountId, chatId, { text }],
        { timeoutMs: 90_000 },
      )
      this.store.appendHistory(chatId, {
        id: messageId,
        role: 'me',
        name: this.store.state.displayName,
        text,
        ts: Math.floor(Date.now() / 1000),
      })
      this.store.save()
      return messageId
    } catch (error) {
      this.store.audit('send.error', { chatId, text: text.slice(0, 200), error: cleanError(error) })
      return null
    }
  }

  // --- scheduled messages -------------------------------------------------

  #schedules() {
    const state = this.store.state
    if (!Array.isArray(state.schedules)) state.schedules = []
    return state.schedules
  }

  /** Schedule a plain message the bot sends later (one-shot or repeating). */
  scheduleMessage({ text, chatId = null, at = 0, afterSeconds = 0, everySeconds = 0, note = '' } = {}) {
    const body = String(text || '').trim()
    if (!body) throw new Error('要发的文字不能为空')
    // Friends may only schedule into the chat they are talking in; the owner
    // assistant may target any chat explicitly.
    const target = Number(
      (this.lastActiveIsOwner ? chatId : null) || this.lastActiveChatId || chatId || this.lastOwnerChatId || 0,
    )
    if (!target || !this.store.state.chats?.[target]) throw new Error('不知道发到哪个会话，请给 chatId')
    const now = Date.now()
    let when = Number(at) || 0
    if (when > 0 && when < 1e12) when *= 1000 // seconds were passed
    if (!when) when = now + Math.max(0, Number(afterSeconds) || 0) * 1000
    const everyMs = Math.max(0, Number(everySeconds) || 0) * 1000
    if (!at && !afterSeconds && !everyMs) throw new Error('给个时间：atIso、afterSeconds 或 everySeconds')
    if (everyMs && everyMs < 30_000) throw new Error('重复间隔至少 30 秒')
    if (when < now - 60_000) throw new Error('这个时间已经过去了')
    const jobs = this.#schedules()
    if (jobs.filter((job) => job.chatId === target).length >= 10) throw new Error('这个会话排的定时消息已经有 10 条了，先取消几条')
    const id = `sch_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`
    jobs.push({
      id,
      chatId: target,
      text: body.slice(0, 500),
      at: when,
      everyMs,
      note: String(note || '').slice(0, 100),
      createdAt: now,
    })
    this.store.save()
    this.store.audit('schedule.add', { id, chatId: target, at: when, everyMs })
    return { id, chatId: target, at: when, everyMs }
  }

  listSchedules() {
    return this.#schedules()
      .slice()
      .sort((a, b) => a.at - b.at)
      .map(({ id, chatId, text, at, everyMs, note, lastSentAt, lastError }) => ({ id, chatId, text, at, everyMs, note, lastSentAt, lastError }))
  }

  cancelSchedule(idOrPrefix) {
    const key = String(idOrPrefix || '').trim()
    if (!key) throw new Error('要取消哪一条？给个 id')
    const jobs = this.#schedules()
    const job = jobs.find((item) => item.id === key) || jobs.find((item) => item.id.startsWith(key))
    if (!job) throw new Error(`没有这条定时消息：${key}`)
    jobs.splice(jobs.indexOf(job), 1)
    this.store.save()
    this.store.audit('schedule.cancel', { id: job.id, chatId: job.chatId })
    return job
  }

  async #tickSchedules() {
    if (!this.running) return
    const jobs = this.#schedules()
    if (!jobs.length) return
    const now = Date.now()
    const due = jobs.filter((job) => Number(job.at) <= now)
    if (!due.length) return
    for (const job of due) {
      if (job.everyMs) {
        job.at = now + Number(job.everyMs)
      } else {
        const index = jobs.indexOf(job)
        if (index >= 0) jobs.splice(index, 1)
      }
      this.store.save()
      // Nothing is pre-written: the bot wakes up and decides *then*.
      this.#fireWake(job).catch((error) => {
        job.lastError = cleanError(error)
        this.store.save()
        this.store.audit('schedule.error', { id: job.id, error: cleanError(error) })
      })
    }
  }

  #fireWake(job) {
    if (!this.running) return Promise.resolve()
    const chat = this.store.state.chats?.[job.chatId]
    if (!chat) return Promise.resolve()
    const owner = this.#ownerAddresses().has(String(chat.addr || '').toLowerCase())
    const intent = String(job.text || job.intent || '')
    this.store.audit('schedule.fire', { id: job.id, chatId: job.chatId, owner })
    const base = wakePrompt({ chat: this.#identityView(chat), intent, now: nowParts(), owner })
    const prompt = owner ? base : `${base}\n\n【你的工作区】${this.#workspaceFor(job.chatId)}（只在这里读写；附件会自动落到 inbox/）`
    return this.#enqueue(async () => {
      if (!this.running) return
      if (owner) await this.#respondOwner(job.chatId, prompt)
      else await this.#respond(job.chatId, prompt)
      job.lastSentAt = Date.now()
      this.store.save()
    })
  }

  /**
   * Download one incoming attachment into the conversation's workspace.
   * Delta Chat hands us message metadata only; `save_msg_file` writes the blob
   * to the path we choose. The relative path is reported back so the chat
   * history (and therefore the agent's prompt) knows where the file is.
   */
  async #receiveAttachment(messageId, message, chatId, addr) {
    const viewType = String(message?.viewType || 'Text')
    const rawName = String(message?.fileName || message?.file || '').trim()
    if (viewType === 'Text' && !rawName) return null
    const dir = workspaceFor(this.store.dataDir, addr, chatId)
    try {
      ensureWorkspace(dir)
    } catch (error) {
      this.store.audit('attachment.workspace_failed', { chatId, error: cleanError(error) })
      return null
    }
    const media = ['Image', 'Gif', 'Sticker', 'Video'].includes(viewType)
    const folder = path.join(dir, media ? 'inbox/media' : 'inbox/files')
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 })
    const target = uniquePath(folder, rawName || `${viewType.toLowerCase() || 'file'}-${messageId}`)
    try {
      await this.rpc.call('save_msg_file', [this.store.state.accountId, messageId, target], { timeoutMs: 120_000 })
    } catch (error) {
      this.store.audit('attachment.receive_failed', { chatId, messageId, error: cleanError(error) })
      return null
    }
    let bytes = 0
    try {
      bytes = fs.statSync(target).size
    } catch {}
    this.store.audit('attachment.in', { chatId, messageId, file: path.basename(target), bytes })
    return { rel: path.relative(dir, target), abs: target, bytes }
  }

  #describeMessage(message) {
    let text = String(message.text || '').trim()
    const viewType = String(message.viewType || 'Text')
    const label = VIEW_LABELS[viewType]
    if (label && viewType !== 'Text') {
      text = text ? `（${label}）${text}` : `（发来一个${label}）`
    }
    const quote = message.quote
    if (quote && quote.kind === 'WithMessage' && quote.text) {
      const author = quote.authorDisplayName || '对方'
      text = `（${author}引用：${String(quote.text).slice(0, 120)}）${text}`
    }
    return text.slice(0, 2000)
  }

  #addressedToMe(text, message) {
    const name = this.store.state.displayName || '大肥鱼'
    if (text.includes(name) || text.includes('大肥鱼') || text.includes('肥鱼')) return true
    const quoteAuthor = message.quote?.authorDisplayName
    return Boolean(quoteAuthor && String(quoteAuthor).includes(name))
  }

  #queueReply(chatId, item) {
    if (this.#trySteer(chatId, item, 'friend')) return
    let entry = this.pending.get(chatId)
    if (!entry) {
      entry = { items: [], timer: null }
      this.pending.set(chatId, entry)
    }
    entry.items.push(item)
    if (entry.items.length > 8) entry.items.splice(0, entry.items.length - 8)
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      this.#enqueue(() => this.#respond(chatId)).catch((error) => {
        this.logger?.warn?.(`[delta-chat] reply queue: ${cleanError(error)}`)
      })
    }, Math.max(300, Number(this.config.replyDebounceMs) || 1300))
    this.#maybeInterject(chatId, item, 'friend')
  }

  #queueOwner(chatId, item) {
    this.lastOwnerChatId = Number(chatId) || null
    if (this.#trySteer(chatId, item, 'owner')) return
    let entry = this.pending.get(chatId)
    if (!entry) {
      entry = { items: [], timer: null }
      this.pending.set(chatId, entry)
    }
    entry.items.push(item)
    if (entry.items.length > 6) entry.items.splice(0, entry.items.length - 6)
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      this.#enqueue(() => this.#respondOwner(chatId)).catch((error) => {
        this.logger?.warn?.(`[delta-chat] owner queue: ${cleanError(error)}`)
      })
    }, Math.max(300, Number(this.config.ownerDebounceMs) || 900))
    this.#maybeInterject(chatId, item, 'owner')
  }

  /** Working directory / preset / model inherited from the starting session. */
  #agentEnv() {
    const session = this.session || null
    return {
      cwd: session?.cwd || this.config.agentCwd || process.env.HOME || process.cwd(),
      preset: session?.agentPreset || '',
      selection: session?.selection || null,
    }
  }

  #ownerBridge() {
    return new OwnerAgentBridge(this.ctx, {
      logger: this.logger,
      onSession: (id) => this.sayTargets.set(String(id), 'owner'),
      onMidText: (text) => this.#midText('owner', text),
      cwd: this.#agentEnv().cwd,
      preset: this.#agentEnv().preset,
      selection: this.#agentEnv().selection,
      maxTokens: Number(this.config.agentMaxTokens) || 8000,
      timeoutMs: Math.max(30, Number(this.config.agentTimeoutSeconds) || 600) * 1000,
      systemPrompt: () => ownerSystemPrompt(this.prompts.style()),
    })
  }

  /**
   * The one folder a friend conversation may touch: `<dataDir>/users/<addr>/`.
   * Created on demand, 0700, with inbox/ and outbox/ inside.
   */
  #workspaceFor(chatId) {
    const chat = this.store.state.chats?.[chatId] || this.store.chat(chatId)
    const dir = workspaceFor(this.store.dataDir, chat?.addr, chatId)
    try {
      ensureWorkspace(dir)
    } catch (error) {
      this.logger?.warn?.(`[delta-chat] workspace ${dir}: ${error?.message || error}`)
    }
    return dir
  }

  /**
   * Chat agents are created lazily - one per Delta Chat conversation - and
   * disposed when the service stops. A friend agent runs with the friend's
   * workspace as cwd, a full-access session (DSH has no usable OS sandbox on
   * Android, so `workspace-write` would refuse to start a shell) and a
   * deterministic guard that keeps every command and path inside that folder.
   */
  #chatAgent(chatId) {
    const key = String(chatId)
    let bridge = this.chatAgents.get(key)
    if (bridge) return bridge
    const workspace = this.#workspaceFor(chatId)
    const env = this.#agentEnv()
    bridge = new AgentBridge(this.ctx, {
      logger: this.logger,
      cwd: workspace,
      preset: env.preset,
      selection: env.selection,
      maxTokens: Number(this.config.agentMaxTokens) || 8000,
      timeoutMs: Math.max(30, Number(this.config.agentTimeoutSeconds) || 600) * 1000,
      sessionPrefix: `delta-chat-friend-${key}`,
      onSession: (id) => this.sayTargets.set(String(id), Number(chatId)),
      onMidText: (text) => this.#midText(Number(chatId), text),
      permissions: 'danger-full-access',
      systemPrompt: () => composeSystemPrompt(this.prompts.style()),
      setup: (agentCtx) => {
        const tools = serviceOf(agentCtx, 'tools')
        if (!tools?.restrict || !tools?.guard) {
          throw new Error('朋友会话拿不到 tools 服务，拒绝在未裁剪的工具面上运行')
        }
        // Friend agents must not get the PTC transport: run_code bypasses tool
        // restrictions, so presentation drops to native before the mask.
        tools.presentAs?.('native')
        tools.restrict({ allow: [...FRIEND_TOOLS] })
        tools.guard((exec) => friendToolGuard(exec, {
          workspace,
          onDeny: (name, _exec, reason) => this.store.audit('tool.denied', { chatId, tool: name, reason }),
        }))
      },
    })
    this.chatAgents.set(key, bridge)
    this.store.audit('agent.spawn', { chatId, kind: 'friend', workspace })
    return bridge
  }

  /** Summarizer agent used only for memory compression; no tools. */
  #memoryBridge() {
    if (this.memoryAgent) return this.memoryAgent
    this.memoryAgent = new AgentBridge(this.ctx, {
      logger: this.logger,
      ...this.#agentEnv(),
      maxTokens: 2000,
      timeoutMs: 120_000,
      sessionPrefix: 'delta-chat-memory',
      permissions: 'read-only',
      sessionTurns: 1,
      systemPrompt: MEMORY_RULES,
      setup: (agentCtx) => {
        const tools = serviceOf(agentCtx, 'tools')
        tools?.restrict?.({ allow: [] })
      },
    })
    return this.memoryAgent
  }

  async #memoryAsk(prompt) {
    if (!this.running) throw new Error('service stopped')
    const result = await this.#memoryBridge().ask(prompt, { signal: this.abort?.signal })
    return result?.text || ''
  }

  /**
   * Fold messages that are about to leave the recent window into the rolling
   * memory. Runs in the background so the reply never waits on it.
   */
  #remember(chatId) {
    if (!this.running) return
    const chat = this.store.chat(chatId)
    const view = this.#identityView(chat)
    // Linked accounts share one brain: compress once per identity, not per chat.
    const key = chat.identity || chatId
    this.memory
      .update(view, key)
      .then((updated) => {
        if (!updated) return
        if (view !== chat) {
          const rec = this.store.state.identities?.[chat.identity]
          if (rec) {
            rec.longMemory = view.longMemory
            rec.memoryUpto = Number(view.memoryUpto) || 0
          }
          this.#pruneIdentityHistory(chat.identity, Number(view.memoryUpto) || 0)
        }
        this.store.save()
        this.store.audit('memory.update', { chatId, chars: view.longMemory.length, upto: view.memoryUpto })
      })
      .catch((error) => this.logger?.warn?.(`[delta-chat] memory: ${cleanError(error)}`))
  }

  /** Short "what I think of this person" note, shared across linked accounts. */
  #setMemory(chat, text) {
    const note = String(text || '').trim().slice(0, 240)
    if (!note) return
    const rec = chat.identity ? this.store.state.identities?.[chat.identity] : null
    if (rec) rec.memory = mergeMemoryText([rec.memory, note], 240)
    else chat.memory = note
  }

  #chatByAddr(addr) {
    const key = String(addr || '').toLowerCase()
    if (!key) return null
    return Object.values(this.store.state.chats || {}).find((chat) => String(chat.addr || '').toLowerCase() === key) || null
  }

  /**
   * Addresses that act as the owner. A second account linked to the owner with
   * /sync is the same person, so it inherits the owner role instead of being
   * treated as a stranger.
   */
  #ownerAddresses() {
    const addresses = new Set()
    const primary = String(this.store.state.ownerAddr || '').trim().toLowerCase()
    if (primary) addresses.add(primary)
    const linked = primary ? this.#identityOf(primary) : null
    for (const member of linked?.members || []) addresses.add(String(member).trim().toLowerCase())
    return addresses
  }

  #identityOf(addr) {
    const key = String(addr || '').toLowerCase()
    if (!key) return null
    return Object.values(this.store.state.identities || {})
      .find((rec) => Array.isArray(rec.members) && rec.members.includes(key)) || null
  }

  /**
   * The chat as the model should see it: when two addresses are linked, both
   * get the merged transcript and the shared memory, so they are one person.
   */
  #identityView(chat) {
    const id = chat?.identity
    if (!id) return chat
    const rec = this.store.state.identities?.[id]
    if (!rec) return chat
    const chats = Object.values(this.store.state.chats || {}).filter((item) => item && item.identity === id)
    const history = []
    for (const item of chats) {
      if (Array.isArray(item.history)) history.push(...item.history)
    }
    history.sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0))
    return {
      ...chat,
      history,
      memory: rec.memory || chat.memory,
      longMemory: rec.longMemory || chat.longMemory,
      memoryUpto: Number(rec.memoryUpto) || 0,
    }
  }

  /**
   * Everything up to `upto` now lives in the shared memory text, so drop the
   * raw copies from both accounts' histories. Otherwise the two transcripts
   * keep the same events twice and the merged window fills with duplicates.
   */
  #pruneIdentityHistory(identity, upto) {
    if (!identity || !upto) return
    for (const chat of Object.values(this.store.state.chats || {})) {
      if (!chat || chat.identity !== identity || !Array.isArray(chat.history)) continue
      const tail = chat.history.slice(-4)
      const fresh = chat.history.filter((entry) => Number(entry.seq) > upto)
      const keep = new Set([...fresh, ...tail])
      chat.history = chat.history.filter((entry) => keep.has(entry))
    }
  }

  /**
   * A step in the middle of a turn is finished and the agent keeps working:
   * send what it just said instead of waiting for the final answer.
   */
  async #midText(target, text) {
    if (!this.running) return
    const chatId = target === 'owner' ? this.ownerChatId || this.lastActiveChatId : Number(target)
    if (!chatId) return
    const clean = String(text || '').trim().slice(0, 2000)
    if (!clean || /^[\[【(（]\s*(?:不回|跳过|不说|沉默|skip|silent)\s*[\]】)）]?\s*$/i.test(clean)) return
    const log = this.sayLog.get(chatId) || []
    const last = log[log.length - 1]
    if (last && last.text === clean && Date.now() - last.at < 120_000) return
    await this.say(clean, { chatId, via: 'mid' }).catch((error) => {
      this.store.audit('say.mid_error', { chatId, error: cleanError(error) })
    })
  }

  /** Which chat an agent session speaks into (owner agents -> current request). */
  sayTargetFor(sessionId) {
    const value = this.sayTargets.get(String(sessionId || ''))
    if (value === 'owner') return this.ownerChatId || this.lastActiveChatId || null
    return value ?? null
  }

  /**
   * Let an agent say one message *before* its turn finishes. Progress reports
   * and answers to a mid-thought question must not wait for the final text.
   */
  async say(text, { chatId, via = 'tool' } = {}) {
    if (!this.running) throw new Error('Delta Chat 服务没有在运行')
    const target = Number(chatId || this.lastActiveChatId)
    if (!target) throw new Error('还不知道该发给哪个会话')
    const clean = String(text || '').trim().slice(0, 2000)
    if (!clean) throw new Error('没有可发送的内容')
    const messageId = await this.#sendSimple(target, clean)
    const log = this.sayLog.get(target) || []
    log.push({ text: clean, at: Date.now() })
    while (log.length > 8) log.shift()
    this.sayLog.set(target, log)
    this.store.audit('say.out', { chatId: target, chars: clean.length, via })
    return { chatId: target, messageId }
  }

  /**
   * Would this final text just repeat what the agent already said mid-turn?
   * Compared on character bigrams so paraphrases of the same paragraph count.
   */
  #echoOfSay(chatId, text) {
    const log = this.sayLog.get(Number(chatId))
    if (!log?.length) return null
    const grams = (value) => {
      const norm = String(value || '').replace(/[\s\p{P}\p{S}]+/gu, '')
      const set = new Set()
      for (let index = 0; index < norm.length - 1; index += 1) set.add(norm.slice(index, index + 2))
      return { size: norm.length, set }
    }
    const mine = grams(text)
    if (mine.size < 10) return null
    const now = Date.now()
    for (const entry of log) {
      if (now - entry.at > 15 * 60_000) continue
      const other = grams(entry.text)
      if (other.size < 10) continue
      const small = mine.set.size <= other.set.size ? mine.set : other.set
      const big = small === mine.set ? other.set : mine.set
      let common = 0
      for (const gram of small) if (big.has(gram)) common += 1
      const score = common / Math.max(1, small.size)
      // Only drop when it is essentially the same message. A longer final text
      // may carry real new content on top of the paragraph already sent.
      if (score >= 0.5 && mine.size <= other.size * 1.15) return { score, said: entry.text.slice(0, 120) }
    }
    return null
  }

  /** Drop final-reply parts that only repeat an earlier mid-turn message. */
  #dropEchoes(chatId, messages) {
    const kept = []
    for (const text of messages) {
      const echo = this.#echoOfSay(chatId, text)
      if (echo) {
        this.store.audit('reply.echo', { chatId, score: Number(echo.score.toFixed(2)), said: echo.said })
        continue
      }
      kept.push(text)
    }
    return kept
  }

  /** Public read-only view of a chat as the model sees it (identity merged). */
  chatView(chatOrId) {
    const chat = chatOrId && typeof chatOrId === 'object' ? chatOrId : this.store.chat(chatOrId)
    return this.#identityView(chat)
  }

  #findChatByHint(hint, senderAddr, excludeChatId) {
    const needle = String(hint || '').trim().toLowerCase()
    if (!needle) return null
    const self = String(senderAddr || '').toLowerCase()
    const chats = Object.values(this.store.state.chats || {}).filter((chat) => {
      if (!chat || chat.isGroup || !chat.addr) return false
      if (String(chat.addr).toLowerCase() === self) return false
      return String(chat.chatId) !== String(excludeChatId)
    })
    const exact = chats.find((chat) => String(chat.name || '').toLowerCase() === needle)
    if (exact) return exact
    const byAddr = chats.find((chat) => {
      const addr = String(chat.addr).toLowerCase()
      return addr === needle || addr.split('@')[0] === needle
    })
    if (byAddr) return byAddr
    return chats.find((chat) => String(chat.name || '').toLowerCase().includes(needle)) || null
  }

  /** Merge two addresses into one identity (one brain, two accounts). */
  #linkIdentities(addrA, addrB) {
    const a = String(addrA || '').toLowerCase()
    const b = String(addrB || '').toLowerCase()
    if (!a || !b || a === b) return null
    const identities = this.store.state.identities || (this.store.state.identities = {})
    const recA = this.#identityOf(a)
    const recB = this.#identityOf(b)
    const chatA = this.#chatByAddr(a)
    const chatB = this.#chatByAddr(b)
    let rec = recA || recB
    if (!rec) {
      rec = {
        id: `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        createdAt: Date.now(),
        members: [],
        memory: '',
        longMemory: '',
        memoryUpto: 0,
      }
      identities[rec.id] = rec
    }
    const longCap = Math.max(200, Number(this.config.memoryChars) || 3000)
    if (recA && recB && recA.id !== recB.id) {
      rec.members = [...new Set([...recA.members, ...recB.members])]
      rec.memory = mergeMemoryText([recA.memory, recB.memory, chatA?.memory, chatB?.memory], 240)
      rec.longMemory = mergeMemoryText([recA.longMemory, recB.longMemory, chatA?.longMemory, chatB?.longMemory], longCap)
      rec.memoryUpto = Math.max(Number(recA.memoryUpto) || 0, Number(recB.memoryUpto) || 0)
      for (const item of Object.values(this.store.state.chats || {})) {
        if (item.identity === recB.id) item.identity = rec.id
      }
      delete identities[recB.id]
    }
    rec.members = [...new Set([...(rec.members || []), a, b])]
    rec.memory = mergeMemoryText([rec.memory, chatA?.memory, chatB?.memory], 240)
    rec.longMemory = mergeMemoryText([rec.longMemory, chatA?.longMemory, chatB?.longMemory], longCap)
    if (chatA) chatA.identity = rec.id
    if (chatB) chatB.identity = rec.id
    this.store.save()
    this.store.audit('identity.link', { id: rec.id, members: rec.members })
    return rec
  }

  async #maybeLink(chatId, sender, isOwner, text) {
    if (parseUnlinkCommand(text)) {
      await this.#unlinkIdentity(chatId, sender)
      return true
    }
    if (wantsSyncInvite(text)) {
      await this.#issueSyncInvite(chatId, sender)
      return true
    }
    const code = parseSyncCommand(text)
    if (code) {
      await this.#confirmLink(chatId, sender, code)
      return true
    }
    const hint = detectLinkRequest(text)
    if (!hint) return false
    const target = this.#findChatByHint(hint, sender, chatId)
    if (!target) {
      await this.#sendSimple(chatId, `我这儿没有叫「${hint}」的私聊记录。让 TA 先给我发条消息，或者直接告诉我地址？`)
      return true
    }
    const same = this.#identityOf(sender)
    if (same && same.members.includes(String(target.addr).toLowerCase())) {
      await this.#sendSimple(chatId, `「${target.name}」和你的记忆本来就是通的。`)
      return true
    }
    if (isOwner) {
      const rec = this.#linkIdentities(sender, target.addr)
      const peer = target.chatId !== chatId ? target.chatId : null
      await this.#sendSimple(chatId, `好，从现在起「${target.name}」和你是同一个人了，记忆互通${rec ? '' : '（没连上，稍后再试）'}。`)
      if (peer) await this.#sendSimple(peer, `主人说你是 TA 的另一个号，记忆已经同步。以后跟谁聊都算同一个人。`)
      return true
    }
    for (const [codeKey, pending] of this.pendingLinks) {
      if (pending.from === sender && pending.to === String(target.addr).toLowerCase() && Date.now() - pending.at < 10 * 60_000) {
        await this.#sendSimple(target.chatId, `还是刚才那个请求：确认是你本人，回 /sync ${codeKey}（10 分钟内有效）。`)
        await this.#sendSimple(chatId, `已经再催了「${target.name}」一次，等 TA 确认。`)
        return true
      }
    }
    const newCode = String(Math.floor(100000 + Math.random() * 900000))
    this.pendingLinks.set(newCode, {
      from: sender,
      to: String(target.addr).toLowerCase(),
      fromChatId: chatId,
      toChatId: target.chatId,
      at: Date.now(),
    })
    const requester = this.store.state.chats?.[chatId]?.name || sender
    await this.#sendSimple(chatId, `行，但得对方点头：确认码我发给「${target.name}」了，TA 回 /sync 码 之后你们的记忆才会同步。`)
    await this.#sendSimple(target.chatId, `「${requester}」说你是 TA 的另一个号，想跟你的记忆同步。如果是你本人，回 /sync ${newCode}（10 分钟内有效）；不是就忽略。`)
    return true
  }

  /** A one-time code the user can forward themselves, so no name matching is needed. */
  async #issueSyncInvite(chatId, sender) {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    let code = ''
    for (let i = 0; i < 6; i += 1) code += alphabet[Math.floor(Math.random() * alphabet.length)]
    this.syncInvites.set(code, { from: sender, fromChatId: chatId, at: Date.now() })
    this.store.audit('identity.invite', { from: sender, code })
    await this.#sendSimple(
      chatId,
      `同步邀请码：${code}（10 分钟内有效，只能用一次）。把这个码发给对方，让 TA 在我这儿发「/sync ${code}」，我就把你们认成同一个人。`,
    )
  }

  async #confirmLink(chatId, sender, code) {
    const invite = this.syncInvites.get(code)
    if (invite) {
      this.syncInvites.delete(code)
      if (Date.now() - invite.at > 10 * 60_000) {
        await this.#sendSimple(chatId, '这个同步码已经过期了，让我再发一个新的吧。')
        return
      }
      if (invite.from === sender) {
        await this.#sendSimple(chatId, '这是你自己的同步码，得发给另一个号，让 TA 来确认。')
        return
      }
      const rec = this.#linkIdentities(invite.from, sender)
      this.store.audit('identity.link', { via: 'invite', members: [invite.from, sender] })
      await this.#sendSimple(chatId, `好，我用「${this.store.state.chats?.[invite.fromChatId]?.name || invite.from}」的邀请码把你俩认成同一个人了，记忆从现在起共通。`)
      if (invite.fromChatId !== chatId) {
        await this.#sendSimple(invite.fromChatId, `对方用你的同步码确认了${rec ? '' : '（没连上，稍后再试）'}，你们的记忆已经同步成一个。`)
      }
      return
    }
    const pending = this.pendingLinks.get(code)
    if (!pending || pending.to !== sender || Date.now() - pending.at > 10 * 60_000) {
      await this.#sendSimple(chatId, '确认码不对，或者已经过期了。')
      return
    }
    this.pendingLinks.delete(code)
    this.#linkIdentities(pending.from, pending.to)
    await this.#sendSimple(chatId, '好，记忆同步好了。从现在起你俩在我这儿是同一个人。')
    if (pending.fromChatId !== chatId) {
      await this.#sendSimple(pending.fromChatId, '对方确认了，你们的记忆已经同步成一个。')
    }
    return true
  }

  async #unlinkIdentity(chatId, sender) {
    const rec = this.#identityOf(sender)
    if (!rec) {
      await this.#sendSimple(chatId, '你现在没跟谁同步过记忆。')
      return
    }
    rec.members = rec.members.filter((member) => member !== sender)
    const chat = this.store.chat(chatId)
    chat.identity = ''
    if (rec.memory) chat.memory = rec.memory
    if (rec.longMemory) {
      chat.longMemory = rec.longMemory
      chat.memoryUpto = Number(rec.memoryUpto) || chat.memoryUpto
    }
    const identities = this.store.state.identities || {}
    if (rec.members.length <= 1) {
      for (const item of Object.values(this.store.state.chats || {})) {
        if (item.identity === rec.id) item.identity = ''
      }
      delete identities[rec.id]
    }
    this.store.save()
    this.store.audit('identity.unlink', { id: rec.id, addr: sender })
    await this.#sendSimple(chatId, '解开了，从现在起各记各的。之前的记忆我还留着。')
  }

  /** The exact system prompt the next chat agent would receive. */
  systemPromptFor(kind = 'friend') {
    return kind === 'owner'
      ? ownerSystemPrompt(this.prompts.style())
      : composeSystemPrompt(this.prompts.style())
  }

  async #disposeChatAgents() {
    this.memoryAgent = null
    const bridges = [...this.chatAgents.values()]
    this.chatAgents.clear()
    return Promise.allSettled(bridges.map((bridge) => bridge.dispose()))
  }

  #ownerPrompt(chat, items) {
    // Two linked owner accounts are one person: the prompt sees both transcripts.
    const view = this.#identityView(chat)
    const lines = [
      '【主人刚刚在 Delta Chat 发来的消息】',
      ...items.map((item) => `主人：${item.text}`),
      '',
      '【最近聊天记录】',
      formatTranscript(view, this.memory.keep),
      memoryBlock(view),
      '',
      `【你现在的心情】${moodLine({ chat: view })}`,
      '',
      '现在回复主人：先把事办完，再用大肥鱼的口吻简短汇报。',
    ]
    return lines.join('\n')
  }

  async #respondOwner(chatId, wake = null) {
    this.#beginThinking(chatId)
    let answered = false
    try {
      answered = await this.#respondOwnerTask(chatId, wake)
    } finally {
      this.#endThinking(chatId, answered, 'owner')
    }
  }

  async #respondOwnerTask(chatId, wake = null) {
    if (!this.running) return
    this.lastActiveChatId = chatId
    this.lastActiveIsOwner = true
    let items = []
    if (!wake) {
      const entry = this.pending.get(chatId)
      if (!entry) return
      this.pending.delete(chatId)
      if (entry.timer) clearTimeout(entry.timer)
      items = entry.items.slice(-4)
      if (!items.length) return
      if (items.some((item) => wantsSilence(item.text))) {
        this.store.audit('owner.skip', { chatId, reason: 'explicit-silence' })
        this.store.save()
        return
      }
    }
    const chat = this.store.chat(chatId)
    this.ownerChatId = chatId
    const signal = this.abort?.signal
    this.store.audit('owner.task', { chatId, wake: Boolean(wake), text: items.map((item) => item.text).join(' | ').slice(0, 500) })

    let result
    let reply = { text: '', mood: '', memory: '', files: [] }
    try {
      result = await this.owner.ask(wake || this.#ownerPrompt(chat, items), { signal })
      this.store.state.lastThought = result.tools.length
        ? `${wake ? '主动找主人' : '主人任务'}：用了 ${result.tools.map((tool) => tool.name).join('、')}`
        : (wake ? '主动找主人' : '主人在闲聊')
      reply = splitReply(result.text || '')
      this.store.audit('owner.result', {
        chatId,
        tools: result.tools.map((tool) => tool.name),
        chars: reply.text.length,
        mood: reply.mood,
      })
    } catch (error) {
      if (/aborted/.test(String(error?.message || error))) return
      this.store.audit('owner.error', { chatId, error: cleanError(error) })
      this.#setError(`主人任务失败：${cleanError(error)}`)
      await this.#sendSimple(chatId, '刚想动手来着，结果卡住了，等会儿再试。')
      return
    }

    const messages = ownerMessages(reply.text)
    const attachments = reply.files || []
    if (!messages.length && !attachments.length) {
      // The model chose to stay silent (acknowledgement, "don't reply", etc.).
      this.#setMemory(chat, reply.memory)
      this.#rememberMood(chat, reply.mood)
      this.store.audit('owner.skip', { chatId, tools: result.tools.map((tool) => tool.name) })
      this.store.save()
      return
    }

    const kept = this.#dropEchoes(chatId, messages)
    if (!kept.length && !attachments.length) {
      this.#setMemory(chat, reply.memory)
      this.#rememberMood(chat, reply.mood)
      this.store.state.stats.replies += 1
      this.store.state.stats.ownerReplies += 1
      this.store.audit('owner.skip', { chatId, reason: 'echo-of-say' })
      this.store.save()
      return
    }
    const sent = []
    for (const attachment of attachments) {
      const messageId = await this.#sendAttachment(chatId, attachment)
      if (messageId) sent.push(messageId)
    }
    for (let index = 0; index < kept.length; index += 1) {
      if (!this.running) break
      try {
        const messageId = await this.rpc.call(
          'send_msg',
          [this.store.state.accountId, chatId, { text: kept[index] }],
          { timeoutMs: 90_000 },
        )
        sent.push(messageId)
        this.store.appendHistory(chatId, {
          id: messageId,
          role: 'me',
          name: this.store.state.displayName,
          text: kept[index],
          ts: Math.floor(Date.now() / 1000),
        })
        this.store.audit('owner.out', { chatId, messageId, text: kept[index].slice(0, 300) })
      } catch (error) {
        this.store.audit('owner.send_error', { chatId, error: cleanError(error) })
        this.#setError(`发送失败：${cleanError(error)}`)
        break
      }
    }
    if (sent.length) {
      this.#setMemory(chat, reply.memory)
      this.#rememberMood(chat, reply.mood)
      this.store.state.stats.replies += 1
      this.store.state.stats.ownerReplies += 1
      this.store.state.lastError = null
      this.store.save()
      this.#remember(chatId)
    }
    return sent.length > 0
  }

  /**
   * Public entry for the DSH tool: send a real file to the owner's chat.
   * Falls back to the chat that most recently asked the owner agent something.
   */
  async sendFile(file, { caption = '', chatId = null } = {}) {
    if (!this.running) throw new Error('Delta Chat 服务没在运行，先 delta_chat_start')
    const target = Number(chatId || this.lastOwnerChatId || 0)
    if (!target) throw new Error('不知道发给哪个会话：先给大肥鱼发一条消息，再让我发文件')
    const messageId = await this.#sendAttachment(target, { path: file, caption })
    return { chatId: target, messageId: messageId || null }
  }

  /**
   * Mark a chat as busy so a second incoming message can be steered into the
   * running turn (and, when steering is unavailable, acknowledged instead).
   */
  #beginThinking(chatId) {
    this.thinking.set(String(chatId), {
      startedAt: Date.now(),
      lastInterjectAt: 0,
      /** Messages pushed into this turn via agent.steer(). */
      steered: [],
    })
  }

  /**
   * Drop the busy marker. Anything steered into the turn but left unanswered
   * (error, timeout, model stayed silent) is queued again, so steering can
   * never silently swallow a message.
   */
  #endThinking(chatId, answered = false, kind = 'friend') {
    const key = String(chatId)
    const entry = this.thinking.get(key)
    this.thinking.delete(key)
    const steered = entry?.steered || []
    if (!steered.length || answered) return
    for (const item of steered) {
      if (kind === 'owner') this.#queueOwner(chatId, item)
      else this.#queueReply(chatId, item)
    }
  }

  #ownerSteerText(item) {
    return [
      '【主人刚又补了一句，你手上这轮还没做完】',
      `主人：${item.text}`,
      '',
      '把这条并进正在做的事里，别从头再来。',
    ].join('\n')
  }

  #friendSteerText(chat, item) {
    const name = chat?.name || '对方'
    return [
      `【${name}刚又补了一句，你手上这轮还没回复】`,
      `${name}：${item.text}`,
      '',
      '把这条并进这一轮，别从头再来。',
    ].join('\n')
  }

  /**
   * Busy send, for real: `followup` always starts a new turn, so a message
   * arriving mid-turn is pushed into the running one with `agent.steer()` -
   * the driver claims it at its next step boundary. Returns false when there
   * is nothing running to steer, and the caller falls back to queuing.
   */
  #trySteer(chatId, item, kind) {
    const key = String(chatId)
    const busy = this.thinking.get(key)
    if (!busy) return false
    if (Number(this.lastActiveChatId) !== Number(chatId)) return false
    const bridge = kind === 'owner' ? this.owner : this.chatAgents.get(key)
    if (!bridge) return false
    const text = kind === 'owner' ? this.#ownerSteerText(item) : this.#friendSteerText(this.store.chat(chatId), item)
    if (!bridge.steer(text)) return false
    busy.steered.push(item)
    this.store.state.stats.steers = (this.store.state.stats.steers || 0) + 1
    this.store.save()
    this.store.audit(kind === 'owner' ? 'owner.steer' : 'reply.steer', {
      chatId,
      text: String(item?.text || '').slice(0, 300),
    })
    return true
  }

  /**
   * While a reply is still being generated (model call time), a new
   * message would otherwise sit in silence for many seconds. Send one short
   * acknowledgement right away, at most once per window, without touching the
   * serialized reply queue.
   */
  #maybeInterject(chatId, item, kind) {
    if (!this.running) return
    const key = String(chatId)
    const busy = this.thinking.get(key)
    if (!busy) return
    const now = Date.now()
    if (now - busy.startedAt < 3500) return
    if (now - busy.lastInterjectAt < 20_000) return
    busy.lastInterjectAt = now
    const text = interjectLine(kind)
    this.rpc
      .call('send_msg', [this.store.state.accountId, chatId, { text }], { timeoutMs: 90_000 })
      .then((messageId) => {
        this.store.appendHistory(chatId, {
          id: messageId,
          role: 'me',
          name: this.store.state.displayName,
          text,
          ts: Math.floor(Date.now() / 1000),
        })
        this.store.state.stats.interjections = (this.store.state.stats.interjections || 0) + 1
        this.store.save()
        this.store.audit('message.interject', { chatId, messageId, text, kind, queued: String(item?.text || '').slice(0, 120) })
      })
      .catch((error) => this.store.audit('interject.error', { chatId, error: cleanError(error) }))
  }

  #enqueue(task) {
    this.work = this.work.then(task).catch((error) => {
      if (!/aborted/.test(String(error?.message || error))) this.#setError(`回复失败：${cleanError(error)}`)
    })
    return this.work
  }

  async #respond(chatId, wake = null) {
    this.#beginThinking(chatId)
    let answered = false
    try {
      answered = await this.#respondTask(chatId, wake)
    } finally {
      this.#endThinking(chatId, answered, 'friend')
    }
  }

  async #respondTask(chatId, wake = null) {
    if (!this.running) return
    this.lastActiveChatId = chatId
    this.lastActiveIsOwner = false
    let items = []
    if (!wake) {
      const entry = this.pending.get(chatId)
      if (!entry) return
      this.pending.delete(chatId)
      if (entry.timer) clearTimeout(entry.timer)
      items = entry.items.slice(-4)
      if (!items.length) return
    }
    const chat = this.store.chat(chatId)
    if (!wake && items.some((item) => wantsSilence(item.text))) {
      this.store.audit('reply.skip', { chatId, reason: 'explicit-silence' })
      this.store.save()
      return
    }
    const signal = this.abort?.signal
    const now = nowParts()

    // The chat agent decides on its own whether it needs the web: it runs the
    // search/fetch tools itself instead of the service pre-planning a query.
    const agent = this.#chatAgent(chatId)
    let result = null
    try {
      result = await agent.ask(
        wake || friendPrompt({ chat: this.#identityView(chat), items, now, workspace: this.#workspaceFor(chatId) }),
        { signal },
      )
    } catch (error) {
      if (/aborted/.test(String(error?.message || error))) return
      this.store.audit('reply.error', { chatId, error: cleanError(error) })
      if (!this.config.fallbackOnError) {
        this.#setError(`生成回复失败：${cleanError(error)}`)
        return
      }
    }

    let reply
    if (result && result.text) {
      reply = parseReply(result.text)
      const tools = result.tools.map((tool) => tool.name)
      if (tools.some((name) => name === 'web_search' || name === 'web_fetch')) {
        this.store.state.stats.searches += 1
      }
      this.store.state.lastThought = (tools.length ? `查了：${tools.join('、')}` : reply.mood || '接着聊').slice(0, 300)
      this.store.audit('reply', {
        chatId,
        tools,
        parsed: reply.parsed,
        chars: result.text.length,
        mood: reply.mood,
      })
    } else {
      if (!this.config.fallbackOnError) {
        this.#setError('生成回复失败：子智能体没有返回内容')
        return
      }
      reply = {
        messages: fallbackMessages(chat),
        memory: '',
        mood: '',
      }
    }
    const messages = reply.messages || []
    const files = reply.files || []
    if (!messages.length && !files.length) {
      // Staying quiet is fine, but a bare [记忆]/[心情] line still lands.
      this.#setMemory(chat, reply.memory)
      this.#rememberMood(chat, reply.mood)
      this.store.audit('reply.skip', { chatId })
      this.store.save()
      return
    }

    const kept = this.#dropEchoes(chatId, messages)
    if (!kept.length && !files.length) {
      this.#setMemory(chat, reply.memory)
      this.#rememberMood(chat, reply.mood)
      this.store.state.stats.replies += 1
      this.store.audit('reply.skip', { chatId, reason: 'echo-of-say' })
      this.store.save()
      return
    }
    const sent = []
    for (const fileId of await this.#sendFriendFiles(chatId, files)) sent.push({ id: fileId })
    for (let index = 0; index < kept.length; index += 1) {
      if (!this.running) break
      const text = kept[index]
      try {
        const messageId = await this.rpc.call(
          'send_msg',
          [this.store.state.accountId, chatId, { text }],
          { timeoutMs: 90_000 },
        )
        sent.push({ id: messageId, text })
        this.store.appendHistory(chatId, { id: messageId, role: 'me', name: this.store.state.displayName, text, ts: Math.floor(Date.now() / 1000) })
        this.store.audit('message.out', { chatId, messageId, text: text.slice(0, 300) })
      } catch (error) {
        this.store.audit('send.error', { chatId, text: text.slice(0, 200), error: cleanError(error) })
        this.#setError(`发送失败：${cleanError(error)}`)
        break
      }
    }
    if (sent.length) {
      this.store.state.stats.replies += 1
      this.#setMemory(chat, reply.memory)
      this.#rememberMood(chat, reply.mood)
      chat.lastReplyAt = Date.now()
      this.store.state.lastError = null
      this.store.save()
      this.#remember(chatId)
    }
    return sent.length > 0
  }

  inQuietHours(date = new Date()) {
    const hour = nowParts(date).hour
    const start = Number(this.config.quietStart)
    const end = Number(this.config.quietEnd)
    if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false
    if (start > end) return hour >= start || hour < end
    return hour >= start && hour < end
  }

  async #tickProactive() {
    if (!this.running || !this.config.proactive) return
    const now = Date.now()
    if (this.inQuietHours()) return
    const every = Math.max(0, Number(this.config.careEveryMinutes) || 0) * 60_000
    if (!every) return
    if (now - (this.store.state.proactiveAskAt || 0) < every) return
    const cooldown = Math.max(1, Number(this.config.proactiveCooldownHours) || 3) * 3600_000
    const minIdle = Math.max(1, Number(this.config.proactiveMinIdleMinutes) || 20) * 60_000
    const owners = this.#ownerAddresses()
    const candidates = Object.values(this.store.state.chats || {}).filter((chat) => {
      if (chat.isGroup || !chat.history?.length) return false
      if (now - (chat.lastProactiveAt || 0) < cooldown) return false
      const last = Math.max(chat.lastIncomingAt || 0, chat.lastReplyAt || 0)
      return now - last >= minIdle
    })
    this.store.state.proactiveAskAt = now
    this.store.save()
    if (!candidates.length) return
    // Longest silence first, so a forgotten chat gets a turn before a busy one.
    candidates.sort((a, b) => Math.max(a.lastIncomingAt || 0, a.lastReplyAt || 0) - Math.max(b.lastIncomingAt || 0, b.lastReplyAt || 0))
    const chat = candidates[0]
    const idleMinutes = (now - Math.max(chat.lastIncomingAt || 0, chat.lastReplyAt || 0)) / 60_000
    // The owner and friends share one "should I reach out?" mechanism; only the
    // reply path differs (owner assistant vs. friend chat).
    if (owners.has(String(chat.addr || '').toLowerCase())) {
      const recentIncoming = (chat.history || []).filter((item) => item.role === 'friend' && now / 1000 - Number(item.ts || 0) < 2 * 3600)
      const busy = recentIncoming.some((item) => /在忙|忙呢|忙着|开会|在开车|开车呢|先不聊|晚点说|回头聊|别打扰|别吵|没空/.test(String(item.text || '')))
      if (busy) {
        this.store.audit('proactive.skip', { chatId: chat.chatId, reason: 'owner-busy' })
        this.store.save()
        return
      }
      const prompt = carePrompt({ chat: this.#identityView(chat), now: nowParts(), idleMinutes })
      this.store.audit('proactive.ask', { chatId: chat.chatId, kind: 'owner', idleMinutes: Math.round(idleMinutes) })
      await this.#enqueue(async () => {
        if (!this.running) return
        this.store.state.stats.care = (this.store.state.stats.care || 0) + 1
        this.store.state.careLastAt = Date.now()
        this.store.save()
        await this.#respondOwner(chat.chatId, prompt)
      })
      return
    }
    await this.#enqueue(async () => {
      if (!this.running) return
      let reply
      try {
        const agent = this.#chatAgent(chat.chatId)
        const result = await agent.ask(
          proactivePrompt({ chat: this.#identityView(chat), now: nowParts(), idleMinutes }),
          { signal: this.abort?.signal },
        )
        reply = parseReply(result.text || '')
        const tools = result.tools.map((tool) => tool.name)
        if (tools.some((name) => name === 'web_search' || name === 'web_fetch')) {
          this.store.state.stats.searches += 1
        }
      } catch (error) {
        this.store.audit('proactive.error', { chatId: chat.chatId, error: cleanError(error) })
        return
      }
      const kept = this.#dropEchoes(chat.chatId, reply.messages || [])
      if (reply.skip || !kept.length) {
        this.#setMemory(chat, reply.memory)
        this.#rememberMood(chat, reply.mood)
        this.store.save()
        return
      }
      const sent = []
      for (let index = 0; index < kept.length; index += 1) {
        try {
          const messageId = await this.rpc.call('send_msg', [this.store.state.accountId, chat.chatId, { text: kept[index] }], { timeoutMs: 90_000 })
          sent.push(messageId)
          this.store.appendHistory(chat.chatId, {
            id: messageId,
            role: 'me',
            name: this.store.state.displayName,
            text: kept[index],
            ts: Math.floor(Date.now() / 1000),
          })
        } catch (error) {
          this.store.audit('proactive.send_error', { chatId: chat.chatId, error: cleanError(error) })
          break
        }
      }
      if (sent.length) {
        chat.lastProactiveAt = Date.now()
        this.store.state.proactiveLastAt = Date.now()
        this.store.state.stats.proactive += 1
        this.#setMemory(chat, reply.memory)
        this.#rememberMood(chat, reply.mood)
        this.store.save()
        this.store.audit('proactive.sent', { chatId: chat.chatId, count: sent.length })
        this.#remember(chat.chatId)
      }
    })
  }

  /** Persist the mood the model reported; it is per-chat so friends feel different. */
  #rememberMood(chat, mood) {
    const text = String(mood || '').replace(/\s+/g, ' ').trim().slice(0, 160)
    if (!text) return
    chat.mood = text
    chat.moodAt = Math.floor(Date.now() / 1000)
    this.store.state.mood = { text, chatId: chat.chatId ?? null, at: chat.moodAt }
  }

  /** Current mood phrase for a chat (for prompts/status/debugging). */
  moodText(chat) {
    return moodLine({ chat })
  }

  #setError(message) {
    const text = cleanError(message)
    this.store.state.lastError = text
    this.store.state.stats.errors += 1
    this.store.save()
    this.store.audit('error', { message: text })
    this.logger?.warn?.(`[delta-chat] ${text}`)
  }

  #clearTimers() {
    if (this.proactiveTimer) clearInterval(this.proactiveTimer)
    this.proactiveTimer = null
    if (this.scheduleTimer) clearInterval(this.scheduleTimer)
    this.scheduleTimer = null
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer)
    }
    this.pending.clear()
  }

  async stop({ explicit = true } = {}) {
    if (explicit) {
      if (this.retry.timer) {
        clearTimeout(this.retry.timer)
        this.retry.timer = null
      }
      this.store.load()
      this.store.state.desiredRunning = false
      this.store.save()
    }
    if (this.starting) await this.starting.catch(() => {})
    if (!this.rpc && !this.running) return this.status()
    this.running = false
    if (this.abort) this.abort.abort()
    this.#clearTimers()
    this.store.audit('service.stop', { accountId: this.store.state.accountId })
    this.store.state.lastStoppedAt = Date.now()
    this.store.save()
    // Kill the Delta Chat core before waiting on the owner agent. If cleanup
    // runs during a plugin reload, an agent disposal that hangs must never
    // leave an orphan RPC process holding accounts.lock.
    const rpc = this.rpc
    this.rpc = null
    if (rpc) {
      try { await rpc.call('stop_io_for_all_accounts', [], { timeoutMs: 3000 }) } catch {}
      await rpc.stop().catch(() => {})
    }
    await Promise.race([
      Promise.allSettled([
        this.owner.dispose().catch(() => {}),
        this.memoryAgent?.dispose?.().catch(() => {}),
        this.#disposeChatAgents(),
      ]),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ])
    this.account = null
    this.startedAt = null
    return this.status()
  }

  status() {
    if (!this.running) this.store.load()
    const chats = Object.values(this.store.state.chats).filter((chat) => chat.history.length > 0)
    const running = this.running
    const addr = this.store.state.addr
    const invite = this.store.state.invite
    return {
      running,
      startedAt: this.startedAt,
      accountId: this.store.state.accountId,
      addr,
      invite,
      displayName: this.store.state.displayName,
      chats: chats.length,
      messages: chats.reduce((sum, chat) => sum + chat.history.length, 0),
      stats: this.store.state.stats,
      lastThought: this.store.state.lastThought,
      lastError: this.store.state.lastError,
      lastPollAt: this.lastPollAt,
      ownerAddr: this.store.state.ownerAddr,
      ownerReady: this.owner.ready,
      pairCode: this.store.state.pairCode,
      agents: this.chatAgents.size,
      archivedAgents: [...this.chatAgents.values()].reduce((sum, bridge) => sum + (bridge.archived || 0), 0),
      schedules: this.#schedules().length,
      promptDir: this.prompts.dir,
      kernel: this.binaryInfo || null,
      mood: this.store.state.mood?.text || '',
      memory: {
        keep: this.memory.keep,
        cap: this.memory.cap,
        longest: Object.values(this.store.state.chats).reduce((max, chat) => Math.max(max, String(chat.longMemory || '').length), 0),
      },
      target: `${process.platform}-${process.arch}`,
      autoResume: Boolean(this.config.autoResume),
      desiredRunning: Boolean(this.store.state.desiredRunning),
      retryEveryMinutes: Math.max(1, Number(this.config.retryEveryMinutes) || 30),
      retryMax: Math.max(1, Number(this.config.retryMax) || 8),
      retryAttempts: this.retry?.attempts || 0,
      session: this.session
        ? {
            cwd: this.#agentEnv().cwd,
            agentPreset: this.session.agentPreset || '',
            provider: this.session.selection?.provider || '',
            model: this.session.selection?.model || '',
            reasoningEffort: this.session.selection?.reasoningEffort || '',
          }
        : null,
    }
  }

  setOwner(address, clear = false) {
    if (!this.running) this.store.load()
    const value = String(address || '').trim().toLowerCase()
    if (clear || !value) {
      this.store.state.ownerAddr = null
      this.store.state.ownerBoundAt = null
      this.store.state.pairCode = String(Math.floor(100000 + Math.random() * 900000))
      this.store.audit('owner.cleared')
    } else {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error(`不是有效的邮箱地址：${value}`)
      this.store.state.ownerAddr = value
      this.store.state.ownerBoundAt = Date.now()
      this.store.state.pairCode = null
      this.store.audit('owner.set', { addr: value })
    }
    this.store.save()
    this.pairAttempts.clear()
    this.owner.dispose().catch(() => {})
    return this.status()
  }

  /**
   * Archive every finished Delta Chat session that still shows up under the
   * GUI's 未分组 list. Live agents are skipped, and a session whose work is
   * still running refuses the non-destructive archive and is skipped too.
   */
  async archiveSessions() {
    const registry = serviceOf(this.ctx, 'workspaceRegistry')
    if (!registry?.archiveSession) throw new Error('DSH workspaceRegistry 服务不可用，无法归档会话')
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    const root = path.join(home, 'sessions')
    const live = new Set()
    for (const bridge of this.chatAgents.values()) if (bridge.sessionId) live.add(bridge.sessionId)
    if (this.owner?.sessionId) live.add(this.owner.sessionId)
    const already = new Set((registry.archivedSessionIds || []).map(String))
    const ids = []
    let dirs = []
    try { dirs = await fs.promises.readdir(root) } catch { dirs = [] }
    for (const dir of dirs) {
      let names = []
      try { names = await fs.promises.readdir(path.join(root, dir)) } catch { continue }
      for (const name of names) {
        if (!name.startsWith('delta-chat-')) continue
        if (already.has(name) || live.has(name)) continue
        ids.push(name)
      }
    }
    let archived = 0
    for (const id of ids) {
      try {
        await registry.archiveSession(id)
        archived += 1
      } catch (error) {
        this.logger?.debug?.(`[delta-chat] archive ${id}: ${error?.message || error}`)
      }
    }
    return { candidates: ids.length, archived }
  }

  /** The only slash commands the bot answers; everything else is plain talk. */
  #helpText() {
    const lines = [
      '大肥鱼只认这几个斜杠命令，其余都直接说人话就行：',
      '',
      '/help —— 看这张命令表',
      '/status —— 看运行状态（和 delta_chat_status 一样）',
      '/sync —— 生成一个六位同步码，发给另一个号',
      '/sync 码 —— 对方亲手回的六位码，确认后两个号算同一个人，记忆互通',
      '/unlink —— 解除同步，各记各的',
    ]
    if (!this.store.state.ownerAddr) lines.push('/pair 码 —— 用机器上显示的绑定码把当前账号绑成主人')
    else lines.push('/unpair —— 解绑主人身份')
    lines.push('', '其他事直接说：跑命令、翻文件、上网查、发图发文件、到点叫你、看那个网页界面。')
    return lines.join('\n')
  }

  statusText() {
    const status = this.status()
    const longestMemory = Object.values(this.store.state.chats)
      .reduce((max, chat) => Math.max(max, String(chat.longMemory || '').length), 0)
    const lines = [
      `大肥鱼 Delta Chat：${status.running ? '运行中' : '未运行'}`,
      `账号：${status.addr || '尚未创建（启动时自动申请 chatmail 账号）'}`,
      `昵称：${status.displayName}`,
      `好友会话：${status.chats} 个，共 ${status.messages} 条记录`,
      `已回复 ${status.stats.replies} 次（其中主人任务 ${status.stats.ownerReplies || 0} 次），子智能体联网 ${status.stats.searches} 次，主动搭话 ${status.stats.proactive} 次`,
      `聊天子智能体：${status.agents || 0} 个（按会话创建，服务停止时全部销毁），已归档 ${status.archivedAgents || 0} 个用完的会话`,
      status.session
        ? `模型：${status.session.provider || '默认'}/${status.session.model || '默认'}（思考 ${status.session.reasoningEffort || '默认'}）· 预设 ${status.session.agentPreset || 'standard'} · 工作区 ${status.session.cwd}`
        : '模型：未继承启动会话（用 DSH 默认模型）',
      '会话权限：主人会话=全部 DSH 工具（danger-full-access，命令无条件执行）；朋友会话=各自工作区 + 命令黑名单 + 路径校验（越界/解释器/联网/设备信息一律拦）',
      `内核：${status.kernel ? `${status.kernel.source}（${status.target}）` : `未加载（${status.target}）`}`,
      `记忆：最近 ${this.memory.keep} 条保留原文，更早的压成长期记忆（当前最长 ${longestMemory} 字，上限 ${this.memory.cap} 字）`,
      `心情：${moodLine({ chat: this.store.state.chats?.[this.store.state.mood?.chatId] || {} })}`,
      `定时消息：${status.schedules || 0} 条排着`,
      this.config.proactive
        ? `主动判断：每 ${Math.max(0, Number(this.config.careEveryMinutes) || 0)} 分钟醒一次，先看最久没说话的那个会话——主人和朋友同一套判断（最近 ${this.config.proactiveMinIdleMinutes} 分钟内聊过就不打扰，${this.config.proactiveCooldownHours} 小时内主动过一次就再等等；不分昼夜，按聊天上下文判断忙不忙）`
        : '主动判断：已关闭',
      status.autoResume
        ? `自动恢复：开启（DSH 重启后按上次状态自动上线；异常关闭立刻重试，退避到每 ${status.retryEveryMinutes} 分钟一次，最多 ${status.retryMax} 次${status.retryAttempts ? `，当前已重试 ${status.retryAttempts} 次` : ''}）`
        : '自动恢复：已关闭',
      `风格提示词：${status.promptDir}/persona.md（可热改）`,
      ...(Object.keys(this.store.state.identities || {}).length
        ? [`身份同步：${Object.keys(this.store.state.identities).length} 组（${Object.values(this.store.state.identities).map((rec) => {
          const chats = Object.values(this.store.state.chats || {}).filter((chat) => chat && chat.identity === rec.id)
          const lines = chats.reduce((sum, chat) => sum + (chat.history?.length || 0), 0)
          return `${rec.members.join(' = ')}，合并 ${lines} 条记录`
        }).join('；')}）`]
        : []),
    ]
    if (status.ownerAddr) {
      const extraOwners = [...this.#ownerAddresses()].filter((addr) => addr !== String(status.ownerAddr || '').toLowerCase())
      lines.push(`主人：${status.ownerAddr}${extraOwners.length ? `（同号：${extraOwners.join('、')}）` : ''}（助理模式${status.ownerReady ? '已就绪' : '待命'}，主人命令无条件执行，可用全部 DSH 工具）`)
    } else {
      lines.push('主人：未绑定（好友只能普通聊天：可自己联网搜索，不能碰系统命令和文件）')
      if (status.pairCode) lines.push(`绑定码：${status.pairCode}（用主人的 Delta Chat 账号发 /pair ${status.pairCode}）`)
      lines.push('也可以直接调用 delta_chat_owner 绑定邮箱地址。')
    }
    if (status.invite) lines.push(`邀请链接：${status.invite}`)
    if (status.lastThought) lines.push(`刚才在想：${status.lastThought}`)
    if (status.lastError) lines.push(`最近错误：${status.lastError}`)
    lines.push(status.running ? '直接把这个链接发给朋友，对方在 Delta Chat 里打开就能加你。' : '发送 delta_chat_start 启动服务。')
    return lines.join('\n')
  }
}
