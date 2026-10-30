import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MemoryKeeper } from './memory.js'
import { DeltaRpc } from './rpc.js'
import { resolveBinary } from './rpc-binary.js'
import { ChatStore } from './store.js'
import { AgentBridge, serviceOf } from './agent-bridge.js'
import { OwnerAgentBridge } from './owner.js'
import { PromptFiles } from './prompts.js'
import { FRIEND_TOOLS, friendToolGuard } from './tool-policy.js'
import { detectLinkRequest, parseSyncCommand, parseUnlinkCommand, mergeMemoryText } from './identity.js'
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
  splitOwnerReply,
  wantsSilence,
  proactivePrompt,
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

export const DEFAULT_CONFIG = {
  displayName: '大肥鱼',
  selfStatus: '一条住在服务器鱼缸里的胖鲸鱼，专业摸鱼',
  dataDir: '',
  binary: '',
  pollIntervalMs: 2500,
  replyDebounceMs: 1300,
  /** Incoming/outgoing attachment size limit, in MB. */
  maxAttachmentMb: 50,
  fallbackOnError: true,
  proactive: true,
  proactiveMinIdleHours: 12,
  proactiveCooldownHours: 24,
  quietStart: 23,
  quietEnd: 8,
  maxBacklogHours: 72,
  ownerAddr: '',
  promptDir: '',
  agentCwd: '',
  agentMaxTokens: 8000,
  agentTimeoutSeconds: 600,
  /** Long-term memory: chars kept per chat, and recent messages kept verbatim. */
  memoryChars: 3000,
  transcriptLimit: 16,
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
    this.prompts = new PromptFiles({ dir: this.config.promptDir, logger })
    this.owner = new OwnerAgentBridge(ctx, {
      logger,
      cwd: this.config.agentCwd || process.env.HOME || process.cwd(),
      maxTokens: Number(this.config.agentMaxTokens) || 8000,
      timeoutMs: Math.max(30, Number(this.config.agentTimeoutSeconds) || 600) * 1000,
      systemPrompt: () => ownerSystemPrompt(this.prompts.style()),
    })
    /** One chat agent per Delta Chat conversation; disposed with the service. */
    this.chatAgents = new Map()
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
    /** Chat of the most recent owner request, used by the send-file tool. */
    this.lastOwnerChatId = null
    this.transportAddrs = new Set()
    this.work = Promise.resolve()
    this.startedAt = null
    this.lastPollAt = null
    this.account = null
    try { this.store.load() } catch (error) {
      logger?.warn?.(`[delta-chat] 读取本地状态失败：${cleanError(error)}`)
    }
  }

  async start() {
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
    if (this.config.ownerAddr && !this.store.state.ownerAddr) {
      this.store.state.ownerAddr = String(this.config.ownerAddr).trim().toLowerCase() || null
      this.store.state.ownerBoundAt = this.store.state.ownerAddr ? Date.now() : null
    }
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
      this.running = false
      this.#setError(`Delta Chat 内核退出（code=${code}, signal=${signal}）`)
      this.#clearTimers()
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
      this.store.save()
      this.store.audit('service.start', { accountId: account.id, addr: account.addr })
      this.pollTask = this.#pollLoop().catch((error) => {
        if (this.running) this.#setError(`消息循环停止：${cleanError(error)}`)
      })
      const interval = Math.max(15_000, Math.min(60_000, Number(this.config.proactiveTickMs) || 45_000))
      this.proactiveTimer = setInterval(() => {
        this.#tickProactive().catch((error) => this.logger?.warn?.(`[delta-chat] proactive: ${cleanError(error)}`))
      }, interval)
      return this.status()
    } catch (error) {
      this.running = false
      await this.rpc.stop().catch(() => {})
      this.rpc = null
      this.#setError(`启动失败：${cleanError(error)}`)
      throw error
    }
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
    const text = await this.#describeMessage(message)
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
    const file = String(spec?.path || '').trim()
    const caption = String(spec?.caption || '').trim().slice(0, 500)
    if (!file) return null
    let stat
    try {
      stat = fs.statSync(file)
    } catch {
      await this.#sendSimple(chatId, `找不到这个文件：${file}`)
      return null
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

  /**
   * Chat agents are created lazily - one per Delta Chat conversation - and
   * disposed when the service stops. Friends get a read-only sandbox plus a
   * tool guard: web lookups only, never shell or file access.
   */
  #chatAgent(chatId) {
    const key = String(chatId)
    let bridge = this.chatAgents.get(key)
    if (bridge) return bridge
    bridge = new AgentBridge(this.ctx, {
      logger: this.logger,
      cwd: this.config.agentCwd || process.env.HOME || process.cwd(),
      maxTokens: Number(this.config.agentMaxTokens) || 8000,
      timeoutMs: Math.max(30, Number(this.config.agentTimeoutSeconds) || 600) * 1000,
      sessionPrefix: `delta-chat-friend-${key}`,
      permissions: 'read-only',
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
          onDeny: (name) => this.store.audit('tool.denied', { chatId, tool: name }),
        }))
      },
    })
    this.chatAgents.set(key, bridge)
    this.store.audit('agent.spawn', { chatId, kind: 'friend' })
    return bridge
  }

  /** Summarizer agent used only for memory compression; no tools. */
  #memoryBridge() {
    if (this.memoryAgent) return this.memoryAgent
    this.memoryAgent = new AgentBridge(this.ctx, {
      logger: this.logger,
      cwd: this.config.agentCwd || process.env.HOME || process.cwd(),
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
    this.memory
      .update(view, chatId)
      .then((updated) => {
        if (!updated) return
        if (view !== chat) {
          const rec = this.store.state.identities?.[chat.identity]
          if (rec) {
            rec.longMemory = view.longMemory
            rec.memoryUpto = Number(view.memoryUpto) || 0
          }
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

  async #confirmLink(chatId, sender, code) {
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
    const lines = [
      '【主人刚刚在 Delta Chat 发来的消息】',
      ...items.map((item) => `主人：${item.text}`),
      '',
      '【最近聊天记录】',
      formatTranscript(chat, this.memory.keep),
      memoryBlock(chat),
      '',
      `【你现在的心情】${moodLine({ chat })}`,
      '',
      '现在回复主人：先把事办完，再用大肥鱼的口吻简短汇报。',
    ]
    return lines.join('\n')
  }

  async #respondOwner(chatId) {
    this.#beginThinking(chatId)
    try {
      await this.#respondOwnerTask(chatId)
    } finally {
      this.#endThinking(chatId)
    }
  }

  async #respondOwnerTask(chatId) {
    if (!this.running) return
    const entry = this.pending.get(chatId)
    if (!entry) return
    this.pending.delete(chatId)
    if (entry.timer) clearTimeout(entry.timer)
    const items = entry.items.slice(-4)
    if (!items.length) return
    const chat = this.store.chat(chatId)
    if (items.some((item) => wantsSilence(item.text))) {
      this.store.audit('owner.skip', { chatId, reason: 'explicit-silence' })
      this.store.save()
      return
    }
    const signal = this.abort?.signal
    this.store.audit('owner.task', { chatId, text: items.map((item) => item.text).join(' | ').slice(0, 500) })

    let result
    try {
      result = await this.owner.ask(this.#ownerPrompt(chat, items), { signal })
      this.store.state.lastThought = result.tools.length
        ? `主人任务：用了 ${result.tools.map((tool) => tool.name).join('、')}`
        : '主人在闲聊'
      const parsed = splitOwnerReply(result.text || '')
      this.store.audit('owner.result', {
        chatId,
        tools: result.tools.map((tool) => tool.name),
        chars: parsed.text.length,
        mood: parsed.mood,
      })
    } catch (error) {
      if (/aborted/.test(String(error?.message || error))) return
      this.store.audit('owner.error', { chatId, error: cleanError(error) })
      this.#setError(`主人任务失败：${cleanError(error)}`)
      await this.#sendSimple(chatId, '刚想动手来着，结果卡住了，等会儿再试。')
      return
    }

    const reply = splitOwnerReply(result.text || '')
    const messages = ownerMessages(reply.text)
    const attachments = reply.files || []
    if (!messages.length && !attachments.length) {
      // The model chose to stay silent (acknowledgement, "don't reply", etc.).
      this.#rememberMood(chat, reply.mood)
      this.store.audit('owner.skip', { chatId, tools: result.tools.map((tool) => tool.name) })
      this.store.save()
      return
    }

    const sent = []
    for (const attachment of attachments) {
      const messageId = await this.#sendAttachment(chatId, attachment)
      if (messageId) sent.push(messageId)
    }
    for (let index = 0; index < messages.length; index += 1) {
      if (!this.running) break
      try {
        const messageId = await this.rpc.call(
          'send_msg',
          [this.store.state.accountId, chatId, { text: messages[index] }],
          { timeoutMs: 90_000 },
        )
        sent.push(messageId)
        this.store.appendHistory(chatId, {
          id: messageId,
          role: 'me',
          name: this.store.state.displayName,
          text: messages[index],
          ts: Math.floor(Date.now() / 1000),
        })
        this.store.audit('owner.out', { chatId, messageId, text: messages[index].slice(0, 300) })
      } catch (error) {
        this.store.audit('owner.send_error', { chatId, error: cleanError(error) })
        this.#setError(`发送失败：${cleanError(error)}`)
        break
      }
    }
    if (sent.length) {
      this.#rememberMood(chat, reply.mood)
      this.store.state.stats.replies += 1
      this.store.state.stats.ownerReplies += 1
      this.store.state.lastError = null
      this.store.save()
      this.#remember(chatId)
    }
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

  /** Mark a chat as busy so a second incoming message can interject. */
  #beginThinking(chatId) {
    this.thinking.set(String(chatId), { startedAt: Date.now(), lastInterjectAt: 0 })
  }

  #endThinking(chatId) {
    this.thinking.delete(String(chatId))
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

  async #respond(chatId) {
    this.#beginThinking(chatId)
    try {
      await this.#respondTask(chatId)
    } finally {
      this.#endThinking(chatId)
    }
  }

  async #respondTask(chatId) {
    if (!this.running) return
    const entry = this.pending.get(chatId)
    if (!entry) return
    this.pending.delete(chatId)
    if (entry.timer) clearTimeout(entry.timer)
    const items = entry.items.slice(-4)
    if (!items.length) return
    const chat = this.store.chat(chatId)
    if (items.some((item) => wantsSilence(item.text))) {
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
      result = await agent.ask(friendPrompt({ chat: this.#identityView(chat), items, now }), { signal })
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
    if (!reply.messages?.length) {
      this.store.audit('reply.skip', { chatId })
      this.store.save()
      return
    }

    const sent = []
    for (let index = 0; index < reply.messages.length; index += 1) {
      if (!this.running) break
      const text = reply.messages[index]
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
    if (!this.running || !this.config.proactive || this.inQuietHours()) return
    const now = Date.now()
    const cooldown = Math.max(1, Number(this.config.proactiveCooldownHours) || 24) * 3600_000
    if (now - (this.store.state.proactiveLastAt || 0) < cooldown) return
    const minIdle = Math.max(1, Number(this.config.proactiveMinIdleHours) || 12) * 3600_000
    const candidates = Object.values(this.store.state.chats).filter((chat) => {
      if (chat.isGroup || !chat.history?.length) return false
      if (now - (chat.lastProactiveAt || 0) < cooldown) return false
      const last = Math.max(chat.lastIncomingAt || 0, chat.lastReplyAt || 0)
      return now - last >= minIdle
    })
    if (!candidates.length) return
    const chat = candidates[Math.floor(Math.random() * candidates.length)]
    const idleHours = (now - Math.max(chat.lastIncomingAt || 0, chat.lastReplyAt || 0)) / 3600_000
    await this.#enqueue(async () => {
      if (!this.running) return
      let reply
      try {
        const agent = this.#chatAgent(chat.chatId)
        const result = await agent.ask(
          proactivePrompt({ chat: this.#identityView(chat), now: nowParts(), idleHours }),
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
      if (reply.skip || !reply.messages?.length) return
      const sent = []
      for (let index = 0; index < reply.messages.length; index += 1) {
        try {
          const messageId = await this.rpc.call('send_msg', [this.store.state.accountId, chat.chatId, { text: reply.messages[index] }], { timeoutMs: 90_000 })
          sent.push(messageId)
          this.store.appendHistory(chat.chatId, {
            id: messageId,
            role: 'me',
            name: this.store.state.displayName,
            text: reply.messages[index],
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
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer)
    }
    this.pending.clear()
  }

  async stop() {
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
      promptDir: this.prompts.dir,
      kernel: this.binaryInfo || null,
      mood: this.store.state.mood?.text || '',
      memory: {
        keep: this.memory.keep,
        cap: this.memory.cap,
        longest: Object.values(this.store.state.chats).reduce((max, chat) => Math.max(max, String(chat.longMemory || '').length), 0),
      },
      target: `${process.platform}-${process.arch}`,
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
      `内核：${status.kernel ? `${status.kernel.source}（${status.target}）` : `未加载（${status.target}）`}`,
      `记忆：最近 ${this.memory.keep} 条保留原文，更早的压成长期记忆（当前最长 ${longestMemory} 字，上限 ${this.memory.cap} 字）`,
      `心情：${moodLine({ chat: this.store.state.chats?.[this.store.state.mood?.chatId] || {} })}`,
      `风格提示词：${status.promptDir}/persona.md（可热改）`,
      ...(Object.keys(this.store.state.identities || {}).length
        ? [`身份同步：${Object.keys(this.store.state.identities).length} 组（${Object.values(this.store.state.identities).map((rec) => rec.members.join(' = ')).join('；')}）`]
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
