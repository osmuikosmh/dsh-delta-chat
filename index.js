import { DeltaChatService } from './lib/service.js'
import { loadConfig, sanitizeUserConfig, saveLimits, savePersona, saveUserConfig, snapshot, userConfigPath } from './lib/config-store.js'
import { formatTranscript } from './lib/persona.js'

export const name = 'dsh-delta-chat'
export const inject = ['tools', 'commands', 'agentDefaultModel', 'agents']

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'text'],
  properties: {
    ok: { type: 'boolean' },
    text: { type: 'string' },
    running: { type: 'boolean' },
    addr: { type: 'string' },
    invite: { type: 'string' },
    error: { type: 'string' },
  },
}

function render(_args, value) {
  return [{ type: 'text', text: String(value?.text || (value?.ok ? '完成' : '失败')) }]
}

function pickStatus(status) {
  const value = { ok: true, text: '' }
  if (typeof status?.running === 'boolean') value.running = status.running
  if (status?.addr) value.addr = String(status.addr)
  if (status?.invite) value.invite = String(status.invite)
  return value
}

function errorResult(prefix, error) {
  const message = String(error?.message || error || 'unknown')
  return { ok: false, text: `${prefix}：${message}`, error: message }
}

/**
 * The session that starts the service decides how every chat agent runs:
 * same working directory, same agent preset, same model + reasoning effort.
 * `agent.options` only carries provider/model, so the effort is read from the
 * session's most recent request header.
 */
function startupSession(exec) {
  const agent = exec?.agent
  const header = agent?.session?.header
  if (!header) return null
  const events = agent?.session?.eventsSnapshot || []
  let selection = null
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    const config = event?.type === 'request/header' ? event?.data?.header?.config : null
    if (config?.model) {
      selection = {
        ...(config.provider ? { provider: config.provider } : {}),
        model: config.model,
        ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
      }
      break
    }
  }
  return {
    cwd: header.cwd || null,
    agentPreset: header.agentPreset || null,
    selection,
  }
}

export function apply(ctx, rawConfig = {}) {
  const config = loadConfig(rawConfig)
  const service = new DeltaChatService(ctx, config, ctx.logger)
  const disposers = []

  const start = async (_args = {}, exec = {}) => {
    try {
      const session = startupSession(exec)
      const status = await service.start({ session })
      const value = pickStatus(status)
      const lines = [
        '大肥鱼上线了，Delta Chat 服务已经跑起来。',
        `账号：${status.addr || '（刚创建，地址还没读到）'}`,
        `昵称：${status.displayName || '大肥鱼'}`,
      ]
      const workspace = status.workspace || status.session?.cwd
      if (workspace) lines.push(`工作区：${workspace}（主人会话固定在这里）`)
      lines.push(service.modelLine())
      if (status.invite) {
        lines.push('', '邀请链接（发给朋友，对方在 Delta Chat 里打开就能加你）：', status.invite)
      }
      if (status.ownerAddr || status.ownerFingerprint) {
        const who = status.ownerFingerprint ? `指纹 ${status.ownerFingerprint}` : String(status.ownerAddr || '')
        lines.push('', `主人：${who}${status.ownerAddr && status.ownerFingerprint ? `（地址 ${status.ownerAddr}）` : ''}（主人私聊可调用全部 DSH 工具，命令无条件执行）`)
      } else {
        lines.push('', '主人还没绑定，所有人目前只能普通聊天（可以自己联网搜索，不能碰系统命令和文件）。')
        if (status.pairCode) lines.push(`用主人的 Delta Chat 账号发 /pair ${status.pairCode} 即可绑定。`)
        lines.push('也可以调用 delta_chat_owner 直接填主人邮箱。')
      }
      lines.push(
        '',
        '聊天由后台子智能体负责：每个会话一个，需要查资料时它自己调 web_search / web_fetch，',
        '非主人的命令会先自审、再被硬性拦下系统读写；服务停止时子智能体会全部销毁。',
        '风格提示词在 prompts/persona.md，改了不用重启服务。',
        '',
        '接下来有人发消息我就回；要停就发 delta_chat_stop。',
      )
      value.text = lines.join('\n')
      return value
    } catch (error) {
      return errorResult('启动失败', error)
    }
  }

  const stop = async () => {
    try {
      const status = await service.stop()
      const value = pickStatus(status)
      value.running = false
      value.text = [
        '大肥鱼下线了，Delta Chat 服务已停止。',
        `这次一共回了 ${status.stats?.replies || 0} 次，子智能体联网 ${status.stats?.searches || 0} 次，聊天子智能体已销毁。`,
        status.lastError ? `最近一次错误：${status.lastError}` : '',
      ].filter(Boolean).join('\n')
      return value
    } catch (error) {
      return errorResult('停止失败', error)
    }
  }

  const statusTool = async () => {
    try {
      const status = service.status()
      const value = pickStatus(status)
      value.text = service.statusText()
      return value
    } catch (error) {
      return errorResult('读取状态失败', error)
    }
  }

  const rpcTool = async (args = {}, exec) => {
    try {
      const method = String(args.method || '').trim()
      if (!method) return errorResult('缺少 method')
      const params = Array.isArray(args.params) ? args.params : []
      // Which conversation asked: friends may only touch their own data.
      const sessionId = exec?.agent?.session?.id || exec?.agent?.id
      const target = sessionId ? service.sayTargetFor(sessionId) : null
      // Only friend agents are registered here; anything else (the owner's
      // agent, or DSH itself calling the tool) is trusted.
      const scope = target === undefined || target === null || target === 'owner'
        ? { owner: true }
        : { owner: false, chatId: Number(target) }
      const result = await service.rpcRequest(method, params, scope)
      const text = JSON.stringify(result === undefined ? null : result)
      return { ok: true, text: text.length > 20_000 ? `${text.slice(0, 20_000)}\n…（已截断）` : text }
    } catch (error) {
      return errorResult(`调用 ${args.method} 失败`, error)
    }
  }

  const ownerTool = async (args = {}) => {
    try {
      const address = typeof args.address === 'string' ? args.address : ''
      const fingerprint = typeof args.fingerprint === 'string' ? args.fingerprint : ''
      const status = fingerprint
        ? service.setOwnerFingerprint(fingerprint)
        : service.setOwner(address, Boolean(args.clear))
      const value = pickStatus(status)
      value.text = service.statusText()
      return value
    } catch (error) {
      return errorResult('设置主人失败', error)
    }
  }

  const promptTool = async (args = {}) => {
    try {
      const kind = args.kind === 'owner' ? 'owner' : 'friend'
      const system = service.systemPromptFor(kind)
      const style = service.prompts.style()
      const lines = [
        `子智能体类型：${kind === 'owner' ? '主人助理（完整工具）' : '朋友聊天（受限工具 + 独立工作区）'}`,
        `最近记录的心情：${service.store.state.mood?.text || '（还没有）'}`,
        `风格文件：${service.prompts.paths().persona}（${style.length} 字）`,
        '',
        '【子智能体收到的系统提示词】',
        system,
      ]
      if (args.chatId !== undefined && args.chatId !== null && args.chatId !== '') {
        const raw = service.store.chat(Number(args.chatId))
        const chat = service.chatView(raw)
        const linked = chat !== raw
        const recent = formatTranscript(chat, service.memory.keep)
        lines.push('', `【此刻的心情】${service.moodText(chat)}`)
        lines.push('', `【该会话的压缩记忆】${chat.longMemory || '（还没有压缩过记忆）'}`)
        lines.push('', `【最近几条原文${linked ? '（已合并同步账号的记录）' : ''}】`, recent)
      }
      return { ok: true, text: lines.join('\n') }
    } catch (error) {
      return errorResult('读取提示词失败', error)
    }
  }

  disposers.push(ctx.tools.register({
    name: 'delta_chat_start',
    description:
      'Start the "Big Fatty Fish" Delta Chat service. The first run requests a chatmail account, builds an invite link, and then chats with friends on Delta Chat like a person. Each chat gets its own background subagent (created on demand after start, destroyed on stop); it looks things up with web_search / web_fetch by itself instead of guessing from the prompt. Once an owner is bound, private commands from the owner run unconditionally with the full DSH toolset; everyone else gets a workspace folder (`~/.dsh/delta-chat/users/<address>/`) where they may read, write and pack files, with commands filtered by a denylist (interpreters, network, download, device info, process tools) and out-of-workspace paths refused. Starting can take 1-4 minutes and returns the account and invite link.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render },
    execute: start,
    timeoutMs: 300_000,
  }))

  disposers.push(ctx.tools.register({
    name: 'delta_chat_stop',
    description: 'Stop the "Big Fatty Fish" Delta Chat service: disconnect the Delta Chat core and stop sending or receiving messages.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render },
    execute: stop,
    timeoutMs: 30_000,
  }))

  const archiveSessionsTool = async () => {
    try {
      const { candidates, archived } = await service.archiveSessions()
      return {
        ok: true,
        text: candidates
          ? `已把 ${archived} 个用完的临时会话从“未分组”收进归档（共检查 ${candidates} 个）。`
          : '没有需要归档的会话。',
      }
    } catch (error) {
      return errorResult('归档会话失败', error)
    }
  }

  disposers.push(ctx.tools.register({
    name: 'delta_chat_archive_sessions',
    description: 'Archive the throwaway DSH sessions left by Big Fatty Fish thinking, so they leave the "Ungrouped" list (the ones still in use are skipped).',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render },
    execute: async () => archiveSessionsTool(),
    timeoutMs: 60_000,
  }))

  disposers.push(ctx.tools.register({
    name: 'delta_chat_workspaces',
    description: 'Debug: show which workspace each subagent session of this run is attached to.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: OUTPUT_SCHEMA, render },
    execute: async () => {
      const report = service.workspaceReport()
      return { ok: true, text: JSON.stringify(report, null, 2) }
    },
    timeoutMs: 15_000,
  }))

  disposers.push(ctx.tools.register({
    name: 'delta_chat_status',
    description: 'Show the Big Fatty Fish service status: account address, invite link, owner binding code, chat statistics and the last error.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render },
    execute: statusTool,
    timeoutMs: 15_000,
  }))

  disposers.push(ctx.tools.register({
    name: 'delta_chat_rpc',
    description:
      'Call a Delta Chat core JSON-RPC method directly (for anything the plugin does not wrap). method is the core method name (e.g. get_contact, send_reaction), params is the argument array. The owner may call anything; friends are limited to their own chats and contacts, while read-only queries are unrestricted.',
    parameters: {
      type: 'object',
      properties: {
        method: { type: 'string', description: 'Delta Chat core JSON-RPC method name, e.g. get_config, get_contacts' },
        params: { type: 'array', description: 'Argument array in the order the core expects; omit it when there are no arguments', items: {} },
      },
      required: ['method'],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render },
    execute: rpcTool,
    timeoutMs: 130_000,
  }))

  disposers.push(ctx.tools.register({
    name: 'delta_chat_note',
    description:
      'Record Big Fatty Fish\'s own mood or a memory about the other person. This replaces the old [mood]/[memory] text markers, so the message body contains only what should be said.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['mood', 'memory'], description: 'mood = how it feels right now; memory = something worth remembering long-term' },
        text: { type: 'string', description: 'Content: for mood, 10-25 words including the reason; for memory, one sentence' },
        chatId: { type: 'number', description: 'Optional: which chat; defaults to the current one' },
      },
      required: ['kind', 'text'],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render },
    execute: async (args = {}, exec) => {
      try {
        const sessionId = exec?.agent?.session?.id || exec?.agent?.id || ''
        const target = args.chatId !== undefined ? Number(args.chatId) : service.sayTargetFor(sessionId)
        const result = await service.note(args.kind, args.text, { chatId: target })
        return { ok: true, text: result.kind === 'mood' ? 'Mood recorded.' : 'Added to long-term memory.' }
      } catch (error) {
        return { ok: false, text: `Could not record it: ${error?.message || error}`, error: String(error?.message || error) }
      }
    },
    timeoutMs: 15_000,
  }))

  disposers.push(ctx.tools.register({
    name: 'delta_chat_prompt',
    description:
      'Show the system prompt a chat subagent actually receives: the hardcoded rules plus the style file prompts/persona.md, and optionally the compressed memory and last few messages of a chat. Use it to verify a prompt change instead of asking the model.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['friend', 'owner'], description: 'Whether to show the friend prompt or the owner prompt; defaults to friend' },
        chatId: { type: 'number', description: 'Optional: also show this chat\'s memory and recent messages' },
      },
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render },
    execute: promptTool,
    timeoutMs: 15_000,
  }))

  disposers.push(ctx.tools.register({
    name: 'delta_chat_say',
    description:
      'Send one line through the Big Fatty Fish account before the current turn ends (progress, or answering something that arrived mid-turn). The chat subagent calls it when it wants to speak while working; the message goes out immediately and the final reply is still sent separately.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The line to send right away' },
        chatId: { type: 'number', description: 'Optional: target chat; a chat subagent defaults to its own chat' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render },
    execute: async (args = {}, exec) => {
      try {
        const sessionId = exec?.agent?.session?.id || exec?.agent?.id || ''
        const target = args.chatId !== undefined ? Number(args.chatId) : service.sayTargetFor(sessionId)
        const result = await service.say(args.text, { chatId: target })
        return { ok: true, text: `Sent to chat ${result.chatId}.` }
      } catch (error) {
        return { ok: false, text: `Could not send mid-turn: ${error?.message || error}`, error: String(error?.message || error) }
      }
    },
    timeoutMs: 120_000,
  }))

  disposers.push(ctx.tools.register({
    name: 'delta_chat_relay',
    description:
      'Manage the relays of the Big Fatty Fish Delta Chat account: one account can have several addresses on different chatmail relays, and it receives on any of them. Use it when the owner wants another relay, a different server, or a backup address. action=list shows them, add requests one (target is a domain such as nine.testrun.org), login attaches an existing mailbox, set chooses the address new friends enter through, remove deletes one. Owner only.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'remove', 'login', 'set'], description: 'list = show, add = request a new address on a relay, login = attach an existing mailbox, set = choose the address new friends enter through, remove = delete' },
        target: { type: 'string', description: 'Relay domain or existing address for add/remove; the mailbox address for login, e.g. abc@chatmail.uk' },
        password: { type: 'string', description: 'Password of that mailbox for login' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render },
    execute: async (args = {}, exec) => {
      try {
        const sessionId = exec?.agent?.session?.id || exec?.agent?.id || ''
        const chatId = service.sayTargetFor(sessionId)
        // Friends may not touch the account's relays; the owner may.
        if (chatId !== null && !service.chatIsOwner(chatId)) {
          return { ok: false, text: 'Relays belong to the account; only the owner can change them.', error: 'not-owner' }
        }
        const action = String(args.action || 'list')
        if (action === 'list') {
          const list = await service.relayList()
          if (!list.length) return { ok: true, text: '还读不到中转站列表。' }
          return { ok: true, text: list.map((item) => `${item.addr}${item.current ? '（当前对外地址）' : ''}`).join('\n') }
        }
        if (action === 'add') {
          const res = await service.addRelay(args.target, { via: 'tool' })
          return { ok: true, text: `Added on ${res.host}: ${res.addr || '(address unknown)'}; ${res.transports.length} relays in total.` }
        }
        if (action === 'login') {
          const res = await service.addRelayLogin(args.target, args.password, { via: 'tool' })
          return { ok: true, text: `Attached ${res.addr}; ${res.transports.length} relays in total.` }
        }
        if (action === 'set') {
          const addr = await service.setRelayAddress(String(args.target || ''), { via: 'tool' })
          return { ok: true, text: `New friends will reach it at ${addr}.` }
        }
        if (action === 'remove') {
          const res = await service.removeRelay(args.target, { via: 'tool' })
          return { ok: true, text: `Removed ${res.removed}; ${res.transports.length} relays left.` }
        }
        return { ok: false, text: `不认识的 action：${action}`, error: 'bad-action' }
      } catch (error) {
        return { ok: false, text: `中转站操作失败：${error?.message || error}`, error: String(error?.message || error) }
      }
    },
    timeoutMs: 260_000,
  }))

  disposers.push(ctx.tools.register({
    name: 'delta_chat_send_file',
    description:
      'Send an image or file from this machine through the Big Fatty Fish account. Defaults to the owner chat that last gave an instruction; chatId overrides it.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the file to send, e.g. /sdcard/DCIM/cat.png' },
        caption: { type: 'string', description: 'Optional caption sent with the attachment' },
        chatId: { type: 'number', description: 'Optional: target chat id; defaults to the last owner chat' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render },
    execute: async (args = {}) => {
      try {
        const result = await service.sendFile(String(args.path || '').trim(), {
          caption: args.caption,
          chatId: args.chatId,
        })
        if (!result.messageId) return { ok: false, text: 'The file did not go out; check attachment.error in the audit log' }
        return { ok: true, text: `Sent ${args.path} to chat ${result.chatId}` }
      } catch (error) {
        return { ok: false, text: `发送失败：${error?.message || error}`, error: String(error?.message || error) }
      }
    },
    timeoutMs: 180_000,
  }))

  disposers.push(ctx.tools.register({
    name: 'delta_chat_schedule',
    description:
      'Give Big Fatty Fish a moment to wake up and think later: when due, it reads the situation then and decides what to say - possibly nothing. Use this for "remind me in X minutes", "tell me in half an hour", "wake me at nine every day" instead of writing plugins or background processes.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The reason: what it should recall and roughly say when due (not sent verbatim - it rephrases in context, and may decide to stay silent)' },
        afterSeconds: { type: 'number', description: 'Seconds from now' },
        atIso: { type: 'string', description: 'Absolute time in ISO format, e.g. 2026-10-31T09:00:00+08:00' },
        everySeconds: { type: 'number', description: 'Optional: repeat every N seconds (at least 30)' },
        chatId: { type: 'number', description: 'Optional: target chat; defaults to the one being talked to' },
        note: { type: 'string', description: 'Optional: a note so you can recognise it later' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render },
    execute: async (args = {}) => {
      try {
        const at = args.atIso ? Date.parse(String(args.atIso)) : 0
        if (args.atIso && !Number.isFinite(at)) throw new Error(`看不懂这个时间：${args.atIso}`)
        const result = service.scheduleMessage({
          text: args.text,
          chatId: args.chatId,
          at,
          afterSeconds: Number(args.afterSeconds) || 0,
          everySeconds: Number(args.everySeconds) || 0,
          note: args.note,
        })
        const when = new Date(result.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
        return {
          ok: true,
          text: `排好了（${result.id}）：${result.everyMs ? '每 ' + result.everyMs / 1000 + ' 秒' : when} 到会话 ${result.chatId} 醒来想想，由头是「${String(args.text).slice(0, 60)}」；到时候它自己决定说不说。`,
        }
      } catch (error) {
        return { ok: false, text: `没排上：${error?.message || error}`, error: String(error?.message || error) }
      }
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'delta_chat_schedules',
    description: 'List the timed messages Big Fatty Fish has queued (owner only).',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: OUTPUT_SCHEMA, render },
    execute: async () => {
      try {
        const jobs = service.listSchedules()
        if (!jobs.length) return { ok: true, text: '现在没有排着的定时消息。' }
        const lines = jobs.map((job) => {
          const when = new Date(job.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
          return `${job.id} · ${job.everyMs ? `每 ${job.everyMs / 1000}s` : when} · 会话 ${job.chatId} · ${job.text}`
        })
        return { ok: true, text: lines.join('\n') }
      } catch (error) {
        return { ok: false, text: `列不出来：${error?.message || error}`, error: String(error?.message || error) }
      }
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'delta_chat_schedule_cancel',
    description: 'Cancel a queued timed message of Big Fatty Fish (owner only); the id may be a prefix.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Timed message id, or a prefix of it' } },
      required: ['id'],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render },
    execute: async (args = {}) => {
      try {
        const job = service.cancelSchedule(args.id)
        return { ok: true, text: `取消了：${job.id}（会话 ${job.chatId}）` }
      } catch (error) {
        return { ok: false, text: `没取消成：${error?.message || error}`, error: String(error?.message || error) }
      }
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'delta_chat_owner',
    description:
      'Show or set the owner of Big Fatty Fish (address or public-key fingerprint). Only private messages from the owner account unlock the full DSH assistant mode with unconditional commands (bash, file access, search); everyone else gets ordinary chat, where the subagent vets every step and system access is blocked. Pass address to bind, or clear/empty to unbind.',
    parameters: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Owner\'s Delta Chat address, e.g. someone@chatmail.cc; leave empty to unbind' },
        fingerprint: { type: 'string', description: 'Owner\'s Autocrypt fingerprint (40 hex chars, may be space-grouped). The address is filled in from known contacts when only the fingerprint is given' },
        clear: { type: 'boolean', description: 'Set to true to unbind the current owner' },
      },
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render },
    execute: ownerTool,
    timeoutMs: 15_000,
  }))

  const commands = [
    { name: 'delta_chat_start', description: 'Start the Big Fatty Fish Delta Chat service', run: start },
    { name: 'delta_chat_stop', description: 'Stop the Big Fatty Fish Delta Chat service', run: stop },
    { name: 'delta_chat_status', description: 'Show the Big Fatty Fish service status', run: statusTool },
  ]
  for (const command of commands) {
    disposers.push(ctx.commands.register({
      name: command.name,
      description: command.description,
      handler: async () => {
        const result = await command.run()
        return result.ok
          ? { kind: 'success', text: result.text }
          : { kind: 'error', text: result.text }
      },
    }))
  }

  // Cordis ignores a plugin function's return value; teardown must be an
  // effect. This stops the chat service (and kills the RPC kernel) before the
  // fiber unloads, so a plugin reload never leaves an orphan holding
  // accounts.lock.
  ctx.effect(() => () => {
    for (const dispose of disposers.reverse()) {
      try { dispose?.() } catch (error) { ctx.logger?.warn?.(`[delta-chat] dispose: ${error.message || error}`) }
    }
    return service.stop({ explicit: false }).catch(() => {})
  }, 'delta-chat:teardown')

  // ---- Web GUI settings page backing (see lib/client.js) ------------------
  // webServer may come up after this plugin during boot; wait for it so the
  // settings route exists on a fresh start, not only after a hot reload.
  const registerSettingsApi = (webServer) => {
    if (!webServer || typeof webServer.register !== 'function') return
    const readBody = (req, limit = 512 * 1024) => new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          reject(new Error('请求体太大'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
    const reply = (res, code, value) => {
      res.statusCode = code
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.end(JSON.stringify(value))
    }
    const forbidden = (req) => {
      try {
        const fence = typeof ctx.get === 'function' ? ctx.get('connection') : null
        if (!fence || typeof fence.requestRejection !== 'function') return 0
        const code = fence.requestRejection(req)
        if (!code) return 0
        // A same-origin fetch from the GUI page carries the session cookie the
        // page itself was authenticated with; the Host fence can still reject
        // exotic access paths (reverse proxy, alternate hostname), so accept
        // same-origin calls here instead of leaving the settings card blank.
        if (String(req.headers?.['sec-fetch-site'] || '') === 'same-origin') return 0
        service.store.audit('settings.api_reject', {
          code: Number(code) || 403,
          host: String(req.headers?.host || ''),
          site: String(req.headers?.['sec-fetch-site'] || ''),
        })
        return Number(code) || 403
      } catch { return 403 }
    }
    const selectionOf = () => {
      const current = service.pickedSelection?.() || null
      if (current) return current
      try {
        const defaults = ctx.get?.('agentDefaultModel')
        const sel = defaults?.currentSelection?.()
        if (sel?.provider) return { provider: sel.provider, model: sel.model, ...(sel.reasoningEffort ? { reasoningEffort: sel.reasoningEffort } : {}) }
      } catch {}
      return { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' }
    }

    service.store.audit('settings.route', { ts: Date.now() })
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/dsh-delta-chat/api',
      handler: async (req, res) => {
        if (forbidden(req)) return reply(res, 403, { ok: false, error: 'forbidden' })
        try {
          const origin = new URL(req.url || '/dsh-delta-chat/api', 'http://x')
          service.store.audit('settings.request', { method: req.method, search: origin.search.slice(0, 80) })
          if (req.method === 'GET') {
            // GET-with-query saves: some proxies only let GET reach a plugin route.
            if (origin.searchParams.get('statusOnly') !== null) {
              return reply(res, 200, { ok: true, personaEnglish: service.personaStatus() })
            }
            const queryConfig = origin.searchParams.get('saveConfig')
            const queryPersona = origin.searchParams.get('savePersona')
            const queryLimits = origin.searchParams.get('saveLimits')
            const queryTranslate = origin.searchParams.get('translatePersona')
            if (queryTranslate !== null) {
              const done = await service.translatePersona({ force: true }).catch((error) => error)
              return reply(res, 200, {
                ok: done === true,
                translated: done === true,
                error: done instanceof Error ? String(done.message || done) : null,
                snapshot: snapshot(config),
              })
            }
            if (queryConfig !== null || queryPersona !== null || queryLimits !== null) {
              if (queryConfig !== null) {
                await saveSettings(JSON.parse(queryConfig))
              }
              if (queryPersona !== null) { savePersona(config, queryPersona); service.translatePersona().catch(() => {}) }
              if (queryLimits !== null) saveLimits(config, queryLimits)
              const s = service.status()
              return reply(res, 200, {
                ok: true,
                running: Boolean(s.running),
                ownerAddr: s.ownerAddr || null,
                snapshot: snapshot(config),
                status: service.statusText(),
              })
            }
            const wantFp = origin.searchParams.get('fingerprintOf')
            if (wantFp) {
              const fingerprint = await service.fingerprintOf(wantFp)
              const s2 = service.status()
              return reply(res, 200, { ok: Boolean(fingerprint), fingerprint, ownerAddr: s2.ownerAddr || null, ownerFingerprint: s2.ownerFingerprint || null })
            }
            const snap = snapshot(config)
            const status = service.status()
            return reply(res, 200, {
              ok: true,
              running: Boolean(status.running),
              addr: status.addr || null,
              ownerAddr: status.ownerAddr || null,
              ownerFingerprint: status.ownerFingerprint || null,
              model: selectionOf(),
              personaEnglish: service.personaStatus(),
              catalog: await service.modelCatalog(),
              snapshot: snap,
              configFile: userConfigPath(config),
              status: service.statusText(),
            })
          }
          if (req.method === 'POST') {
            const body = JSON.parse((await readBody(req)) || '{}')
            const action = String(body?.action || '')
            if (action === 'translatePersona') {
              // Runs for minutes; answer immediately and let the page poll.
              service.translatePersona({ force: Boolean(body?.force) })
                .then(() => service.store.audit('settings.translate_done', {}))
                .catch((error) => service.store.audit('settings.translate_failed', { error: String(error?.message || error) }))
              return reply(res, 200, { ok: true, started: true, personaEnglish: service.personaStatus() })
            }
            if (action === 'start' || action === 'stop') {
              try {
                const s = action === 'start'
                  ? await service.start({ session: service.session || null })
                  : await service.stop()
                service.store.audit('settings.action', { action })
                return reply(res, 200, {
                  ok: true,
                  running: Boolean(s.running),
                  ownerAddr: s.ownerAddr || null,
                  snapshot: snapshot(config),
                  status: service.statusText(),
                })
              } catch (error) {
                return reply(res, 200, { ok: false, error: String(error?.message || error) })
              }
            }
            if (body?.ownerFingerprint) {
              try {
                service.setOwnerFingerprint(String(body.ownerFingerprint))
                return reply(res, 200, { ok: true, running: Boolean(service.status().running), ownerAddr: service.status().ownerAddr || null, ownerFingerprint: service.status().ownerFingerprint || null, snapshot: snapshot(config), status: service.statusText() })
              } catch (error) {
                return reply(res, 400, { ok: false, error: String(error?.message || error) })
              }
            }
            if (body?.model && typeof body.model === 'object') {
              try {
                await service.setSelection(body.model)
                saveUserConfig(config, {
                  provider: String(body.model.provider || ''),
                  model: String(body.model.model || ''),
                  reasoningEffort: String(body.model.reasoningEffort || ''),
                })
                Object.assign(config, loadConfig(rawConfig))
                service.store.audit('settings.model', { model: String(body.model.model || '') })
                const s = service.status()
                return reply(res, 200, {
                  ok: true,
                  running: Boolean(s.running),
                  ownerAddr: s.ownerAddr || null,
                  model: selectionOf(),
                  catalog: await service.modelCatalog(),
                  snapshot: snapshot(config),
                  status: service.statusText(),
                })
              } catch (error) {
                return reply(res, 200, { ok: false, error: String(error?.message || error) })
              }
            }
            const patch = body?.config && typeof body.config === 'object' ? body.config : null
            const s = patch ? await saveSettings(patch) : service.status()
            if (typeof body?.persona === 'string') {
              savePersona(config, body.persona)
              service.translatePersona().catch(() => {})
            }
            if (typeof body?.limits === 'string') {
              saveLimits(config, body.limits)
            }
            return reply(res, 200, {
              ok: true,
              running: Boolean(s.running),
              ownerAddr: s.ownerAddr || null,
              ownerFingerprint: s.ownerFingerprint || null,
              snapshot: snapshot(config),
              status: service.statusText(),
            })
          }
          return reply(res, 405, { ok: false, error: 'method not allowed' })
        } catch (error) {
          service.store.audit('settings.api_error', { message: String(error?.message || error) })
          return reply(res, 400, { ok: false, error: String(error?.message || error) })
        }
      },
    }))
  }

  /**
   * The owner is stored in exactly one place: state.json (see
   * DeltaChatService.setOwner). The settings page shows and edits that value
   * directly, so `ownerAddr` is pulled out before the rest is written to the
   * config file — config files never carry a second copy that could go stale.
   */
  const saveSettings = async (input) => {
    const patch = sanitizeUserConfig(input || {})
    const owner = typeof input?.ownerAddr === 'string' ? input.ownerAddr : undefined
    if (owner !== undefined) {
      const current = String(service.status().ownerAddr || '').trim().toLowerCase()
      if (String(owner).trim().toLowerCase() !== current) service.setOwner(owner)
    }
    const fp = typeof input?.ownerFingerprint === 'string' ? input.ownerFingerprint.replace(/[^0-9a-fA-F]/g, '') : ''
    if (fp.length === 40 && fp.toUpperCase() !== String(service.status().ownerFingerprint || '')) {
      service.setOwnerFingerprint(fp)
    }
    if (Object.keys(patch).length) {
      saveUserConfig(config, patch)
      Object.assign(config, loadConfig(rawConfig))
      await service.applyConfig(config)
    }
    return service.status()
  }

  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (webCtx) => {
        registerSettingsApi(webCtx.webServer || webCtx.get('webServer'))
      })
    } catch (error) {
      ctx.logger?.warn?.(`[delta-chat] settings api inject: ${error?.message || error}`)
    }
  } else {
    registerSettingsApi(typeof ctx.get === 'function' ? ctx.get('webServer') : null)
  }

  // If the bot was running when DSH last shut down, bring it back up. This
  // also covers abnormal exits: resume() retries immediately, then every
  // `retryEveryMinutes` up to `retryMax` times.
  setTimeout(() => {
    service.resume().catch((error) => ctx.logger?.warn?.(`[delta-chat] resume: ${error?.message || error}`))
  }, 1200)
}

// reload 1793363343

