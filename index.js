import { DeltaChatService } from './lib/service.js'

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

export function apply(ctx, rawConfig = {}) {
  const config = { ...rawConfig }
  const service = new DeltaChatService(ctx, config, ctx.logger)
  const disposers = []

  const start = async () => {
    try {
      const status = await service.start()
      const value = pickStatus(status)
      const lines = [
        '大肥鱼上线了，Delta Chat 服务已经跑起来。',
        `账号：${status.addr || '（刚创建，地址还没读到）'}`,
        `昵称：${status.displayName || '大肥鱼'}`,
      ]
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
        '接下来有人发消息，我会按真人节奏回；要停就发 delta_chat_stop。',
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
