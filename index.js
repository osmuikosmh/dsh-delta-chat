import { DeltaChatService } from './lib/service.js'
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
  const config = { ...rawConfig }
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
      if (status.session) {
        const parts = []
        if (status.session.cwd) parts.push(`工作区 ${status.session.cwd}`)
        if (status.session.model) {
          const effort = status.session.reasoningEffort ? `（${status.session.reasoningEffort}）` : ''
          parts.push(`模型 ${status.session.model}${effort}`)
        }
        if (status.session.agentPreset) parts.push(`预设 ${status.session.agentPreset}`)
        if (parts.length) lines.push(`继承自启动会话：${parts.join(' · ')}`)
      }
      if (status.invite) {
        lines.push('', '邀请链接（发给朋友，对方在 Delta Chat 里打开就能加你）：', status.invite)
      }
      if (status.ownerAddr) {
        lines.push('', `主人：${status.ownerAddr}（主人私聊可调用全部 DSH 工具，命令无条件执行）`)
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

  const ownerTool = async (args = {}) => {
    try {
      const address = typeof args.address === 'string' ? args.address : ''
      const status = service.setOwner(address, Boolean(args.clear))
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
        `子智能体类型：${kind === 'owner' ? '主人助理（完整工具）' : '朋友聊天（只读工具）'}`,
        `最近记录的心情：${service.store.state.mood?.text || '（还没有）'}`,
        `风格文件：${service.prompts.paths().persona}（${style.length} 字）`,
        '',
        '【子智能体收到的系统提示词】',
        system,
      ]
      if (args.chatId !== undefined && args.chatId !== null && args.chatId !== '') {
        const chat = service.store.chat(Number(args.chatId))
        const recent = formatTranscript(chat, service.memory.keep)
        lines.push('', `【此刻的心情】${service.moodText(chat)}`)
        lines.push('', `【该会话的压缩记忆】${chat.longMemory || '（还没有压缩过记忆）'}`, '', '【该会话最近几条原文】', recent)
      }
      return { ok: true, text: lines.join('\n') }
    } catch (error) {
      return errorResult('读取提示词失败', error)
    }
  }

  disposers.push(ctx.tools.register({
    name: 'delta_chat_start',
    description:
      '启动“大肥鱼”的 Delta Chat 聊天服务：首次运行会自动申请一个 chatmail 账号，生成邀请链接，然后像真人一样在 Delta Chat 里和好友聊天。聊天由后台子智能体完成（每个会话一个，启动服务后按需创建、停止时销毁）：需要外界信息时它会自己调 web_search / web_fetch，不再靠提示词预判搜索。绑定主人后，主人的私聊命令无条件执行、可用完整 DSH 工具；其他人只能联网查资料，系统命令和文件读写一律拦截。启动可能需要 1～4 分钟，返回账号和邀请链接。',
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
    description: '停止“大肥鱼”的 Delta Chat 聊天服务，断开 Delta Chat 内核，不再收发消息。',
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
    description: '把大肥鱼每次思考留下的临时会话从 DSH 的“未分组”列表里归档掉（正在用的会话会跳过）。',
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
    name: 'delta_chat_status',
    description: '查看“大肥鱼” Delta Chat 服务的运行状态、账号地址、邀请链接、主人绑定码、聊天统计和最近错误。',
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
    name: 'delta_chat_prompt',
    description:
      '查看“大肥鱼”聊天子智能体实际收到的系统提示词：风格文件 prompts/persona.md 与硬编码规则拼接后的全文，以及指定会话的压缩记忆和最近几条聊天。改完提示词想确认是否生效时用这个，比问模型可靠。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['friend', 'owner'], description: '查看朋友聊天还是主人助理的提示词，默认 friend' },
        chatId: { type: 'number', description: '可选：同时查看这个 Delta Chat 会话的记忆与最近聊天' },
      },
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render },
    execute: promptTool,
    timeoutMs: 15_000,
  }))

  disposers.push(ctx.tools.register({
    name: 'delta_chat_send_file',
    description:
      '把本机上的一个图片/文件通过“大肥鱼”的 Delta Chat 账号发出去。默认发给最近一次给大肥鱼下指令的主人会话；也可以显式给 chatId。主人让大肥鱼发图、发文件时用这个。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要发送的文件的绝对路径，例如 /sdcard/DCIM/cat.png' },
        caption: { type: 'string', description: '可选的配文，会跟附件一起发' },
        chatId: { type: 'number', description: '可选：目标 Delta Chat 会话 id；默认最近的主人会话' },
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
        if (!result.messageId) return { ok: false, text: '文件没发出去，看审计日志里的 attachment.error' }
        return { ok: true, text: `已把 ${args.path} 发到会话 ${result.chatId}` }
      } catch (error) {
        return { ok: false, text: `发送失败：${error?.message || error}`, error: String(error?.message || error) }
      }
    },
    timeoutMs: 180_000,
  }))

  disposers.push(ctx.tools.register({
    name: 'delta_chat_schedule',
    description:
      '给“大肥鱼”自己定一个“到点醒来想想”的时刻：到点它才读当时的情况、自己想说什么，也可能决定不说。主人说「X 分钟后提醒我」「半小时后再跟我说」「每天九点叫我」时用它，不要自己写插件或开后台进程。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '由头：到点要让它想起什么、打算说什么（不是逐字发送，到点它会结合上下文重新组织，也可能觉得不合适就不说）' },
        afterSeconds: { type: 'number', description: '多少秒之后发' },
        atIso: { type: 'string', description: '绝对时间，ISO 格式，如 2026-10-31T09:00:00+08:00' },
        everySeconds: { type: 'number', description: '可选：每隔多少秒重复一次（至少 30）' },
        chatId: { type: 'number', description: '可选：发给哪个会话，默认当前正在说话的会话' },
        note: { type: 'string', description: '可选：备注，方便以后辨认' },
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
    description: '列出“大肥鱼”排着的定时消息（主人用）。',
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
    description: '取消一条“大肥鱼”排着的定时消息（主人用），id 可以只给前缀。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '定时消息 id，或它的前缀' } },
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
      '查看或设置“大肥鱼”的主人。只有主人账号发来的私聊会启用完整 DSH 助理模式，命令无条件执行（可调用 bash、读写文件、搜索等全部工具）；其他人只能普通聊天，子智能体会自己审核每一步、系统读写一律被拦截。传 address 绑定，传 clear 或空地址解绑。',
    parameters: {
      type: 'object',
      properties: {
        address: { type: 'string', description: '主人的 Delta Chat 邮箱地址，例如 someone@chatmail.cc；留空表示解绑' },
        clear: { type: 'boolean', description: '设为 true 解绑当前主人' },
      },
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render },
    execute: ownerTool,
    timeoutMs: 15_000,
  }))

  const commands = [
    { name: 'delta_chat_start', description: '启动大肥鱼的 Delta Chat 服务', run: start },
    { name: 'delta_chat_stop', description: '停止大肥鱼的 Delta Chat 服务', run: stop },
    { name: 'delta_chat_status', description: '查看大肥鱼 Delta Chat 服务状态', run: statusTool },
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
    return service.stop().catch(() => {})
  }, 'delta-chat:teardown')
}

// reload 1793363343
