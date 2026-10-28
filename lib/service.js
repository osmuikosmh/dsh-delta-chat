import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DeltaRpc } from './rpc.js'
import { ChatStore } from './store.js'
import { LlmClient, SearchClient } from './llm.js'
import { fallbackMessages, nowParts } from './persona.js'

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
  replyTimingScale: 1,
  maxReplyDelaySeconds: 90,
  fallbackOnError: true,
  proactive: true,
  proactiveMinIdleHours: 12,
  proactiveCooldownHours: 24,
  quietStart: 23,
  quietEnd: 8,
  maxBacklogHours: 72,
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

function resolveBinary(config) {
  if (config.binary && String(config.binary).trim()) {
    return path.resolve(String(config.binary).trim())
  }
  const bundled = path.join(PACKAGE_ROOT, 'bin', 'deltachat-rpc-server')
  if (fs.existsSync(bundled)) return bundled
  try {
    return fileURLToPath(import.meta.resolve('@deltachat/stdio-rpc-server-android-arm64/deltachat-rpc-server'))
  } catch {
    return bundled
  }
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

function cleanError(error) {
  const text = String(error?.message || error || 'unknown')
  return text.replace(/\s+/g, ' ').slice(0, 600)
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
    this.llm = new LlmClient(ctx, {
      logger,
      model: this.config.model || null,
      reasoningEffort: this.config.reasoningEffort || 'high',
    })
    this.search = new SearchClient(ctx, { logger })
    this.rpc = null
    this.running = false
    this.starting = null
    this.abort = null
    this.pollTask = null
    this.proactiveTimer = null
    this.pending = new Map()
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
    const binary = resolveBinary(this.config)
    if (!fs.existsSync(binary)) {
      throw new Error(`找不到 deltachat-rpc-server：${binary}`)
    }
    this.rpc = new DeltaRpc(binary, this.store.rpcDir)
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
    const needsTransport = !accounts.length || !info || info.kind !== 'Configured'
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
    }

    await this.rpc.call(
      'batch_set_config',
      [id, { displayname: this.config.displayName || '大肥鱼', selfstatus: this.config.selfStatus || '' }],
      { timeoutMs: 20_000 },
    )

    let addr = null
    try { addr = await this.rpc.call('get_config', [id, 'addr'], { timeoutMs: 15_000 }) } catch {}
    if (!addr || typeof addr !== 'string') {
      try {
        const transports = transportList(await this.rpc.call('list_transports', [id], { timeoutMs: 20_000 }))
        addr = transports[0]?.addr || null
      } catch {}
    }
    try { info = await this.rpc.call('get_account_info', [id], { timeoutMs: 20_000 }) } catch {}
    if (!addr && info?.addr) addr = info.addr
    if (!addr) throw new Error('Delta Chat 账号已创建，但读不到邮箱地址（transport 未就绪）')

    let invite = null
    try {
      invite = await this.rpc.call('get_chat_securejoin_qr_code', [id, null], { timeoutMs: 30_000 })
    } catch (error) {
      this.logger?.warn?.(`[delta-chat] 生成邀请链接失败：${cleanError(error)}`)
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
    // sender address reliably identifies our own outgoing messages.
    if (message.sender?.address && message.sender.address === this.store.state.addr) {
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
    const text = this.#describeMessage(message)
    if (!text) {
      this.store.markSeen(messageId)
      return
    }
    const isGroup = fullChat?.chatType === 'Group' || (Array.isArray(fullChat?.contactIds) && fullChat.contactIds.length > 1)
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
    this.store.state.stats.incoming += 1
    this.store.save()
    this.store.audit('message.in', { chatId, messageId, name: chat.name, text: text.slice(0, 300), ageHours: Math.round(ageHours) })

    if (ageHours > (Number(this.config.maxBacklogHours) || 72)) {
      this.store.audit('message.backlog_skip', { chatId, messageId, ageHours: Math.round(ageHours) })
      return
    }
    this.#queueReply(chatId, { id: messageId, text, ts: Number(message.timestamp) || Math.floor(Date.now() / 1000) })
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
  }

  #enqueue(task) {
    this.work = this.work.then(task).catch((error) => {
      if (!/aborted/.test(String(error?.message || error))) this.#setError(`回复失败：${cleanError(error)}`)
    })
    return this.work
  }

  async #respond(chatId) {
    if (!this.running) return
    const entry = this.pending.get(chatId)
    if (!entry) return
    this.pending.delete(chatId)
    if (entry.timer) clearTimeout(entry.timer)
    const items = entry.items.slice(-4)
    if (!items.length) return
    const chat = this.store.chat(chatId)
    const signal = this.abort?.signal
    const now = nowParts()
    const scale = Math.max(0.02, Math.min(2, Number(this.config.replyTimingScale) || 1))

    let plan
    try {
      plan = await this.llm.plan(chat, now)
    } catch (error) {
      this.store.audit('plan.error', { chatId, error: cleanError(error) })
      plan = { need_search: false, query: '', reason: '先接话', vibe: '', angle: '' }
    }
    this.store.state.lastThought = [plan.vibe, plan.angle].filter(Boolean).join(' / ').slice(0, 300)
    this.store.audit('plan', {
      chatId,
      needSearch: plan.need_search,
      query: plan.query,
      vibe: plan.vibe,
      angle: plan.angle,
    })

    let results = []
    if (plan.need_search && plan.query) {
      try {
        results = await this.search.search(plan.query, signal)
        this.store.state.stats.searches += 1
        this.store.audit('search', { chatId, query: plan.query, results: results.length })
      } catch (error) {
        this.store.audit('search.error', { chatId, query: plan.query, error: cleanError(error) })
      }
    }

    let reply
    try {
      reply = await this.llm.reply(chat, plan, results, now)
    } catch (error) {
      this.store.audit('reply.error', { chatId, error: cleanError(error) })
      if (!this.config.fallbackOnError) {
        this.#setError(`生成回复失败：${cleanError(error)}`)
        return
      }
      reply = {
        messages: fallbackMessages(chat),
        delaySeconds: 8,
        readSeconds: 2,
        memory: '',
        mood: '',
      }
    }
    if (!reply.messages?.length) {
      this.store.audit('reply.skip', { chatId })
      this.store.save()
      return
    }

    const maxDelay = Math.max(3, Math.min(180, Number(this.config.maxReplyDelaySeconds) || 90))
    const readMs = Math.min(8000, Math.max(0, Number(reply.readSeconds) || 2) * 1000)
    const delayMs = Math.min(maxDelay, Math.max(3, Number(reply.delaySeconds) || 8)) * 1000
    await sleep((readMs + delayMs) * scale, signal)

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
        if (index < reply.messages.length - 1) {
          await sleep((700 + Math.random() * 1600) * Math.max(0.15, scale), signal)
        }
      } catch (error) {
        this.store.audit('send.error', { chatId, text: text.slice(0, 200), error: cleanError(error) })
        this.#setError(`发送失败：${cleanError(error)}`)
        break
      }
    }
    if (sent.length) {
      this.store.state.stats.replies += 1
      if (reply.memory) chat.memory = String(reply.memory).slice(0, 240)
      chat.lastReplyAt = Date.now()
      this.store.state.lastError = null
      this.store.save()
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
        reply = await this.llm.proactive(chat, nowParts(), idleHours)
      } catch (error) {
        this.store.audit('proactive.error', { chatId: chat.chatId, error: cleanError(error) })
        return
      }
      if (reply.skip || !reply.messages?.length) return
      await sleep(Math.min(60, Math.max(4, Number(reply.delaySeconds) || 15)) * 1000, this.abort?.signal)
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
          if (index < reply.messages.length - 1) await sleep(1200, this.abort?.signal)
        } catch (error) {
          this.store.audit('proactive.send_error', { chatId: chat.chatId, error: cleanError(error) })
          break
        }
      }
      if (sent.length) {
        chat.lastProactiveAt = Date.now()
        this.store.state.proactiveLastAt = Date.now()
        this.store.state.stats.proactive += 1
        if (reply.memory) chat.memory = String(reply.memory).slice(0, 240)
        this.store.save()
        this.store.audit('proactive.sent', { chatId: chat.chatId, count: sent.length })
      }
    })
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
    const rpc = this.rpc
    this.rpc = null
    if (rpc) {
      try { await rpc.call('stop_io_for_all_accounts', [], { timeoutMs: 8000 }) } catch {}
      await rpc.stop().catch(() => {})
    }
    this.account = null
    this.startedAt = null
    return this.status()
  }

  status() {
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
    }
  }

  statusText() {
    const status = this.status()
    const lines = [
      `大肥鱼 Delta Chat：${status.running ? '运行中' : '未运行'}`,
      `账号：${status.addr || '尚未创建（启动时自动申请 chatmail 账号）'}`,
      `昵称：${status.displayName}`,
      `好友会话：${status.chats} 个，共 ${status.messages} 条记录`,
      `已回复 ${status.stats.replies} 次，联网搜索 ${status.stats.searches} 次，主动搭话 ${status.stats.proactive} 次`,
    ]
    if (status.invite) lines.push(`邀请链接：${status.invite}`)
    if (status.lastThought) lines.push(`刚才在想：${status.lastThought}`)
    if (status.lastError) lines.push(`最近错误：${status.lastError}`)
    lines.push(status.running ? '直接把这个链接发给朋友，对方在 Delta Chat 里打开就能加你。' : '发送 delta_chat_start 启动服务。')
    return lines.join('\n')
  }
}
