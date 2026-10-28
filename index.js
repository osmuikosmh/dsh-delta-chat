import { DeltaChatService } from './lib/service.js'

export const name = 'dsh-delta-chat'
export const inject = ['tools', 'commands', 'llm', 'agentDefaultModel', 'web']

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
      lines.push('', '接下来有人发消息，我会按真人节奏回；要停就发 delta_chat_stop。')
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
        `这次一共回了 ${status.stats?.replies || 0} 次，搜索了 ${status.stats?.searches || 0} 次。`,
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

  disposers.push(ctx.tools.register({
    name: 'delta_chat_start',
    description:
      '启动“大肥鱼”的 Delta Chat 聊天服务：首次运行会自动申请一个 chatmail 账号，生成邀请链接，然后像真人一样在 Delta Chat 里和好友聊天（会深度思考、按需联网搜索、分多条短消息回复）。启动可能需要 1～4 分钟，返回账号和邀请链接。',
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
    description: '查看“大肥鱼” Delta Chat 服务的运行状态、账号地址、邀请链接、聊天统计和最近错误。',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render },
    execute: statusTool,
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

  return async () => {
    for (const dispose of disposers.reverse()) {
      try { dispose?.() } catch (error) { ctx.logger?.warn?.(`[delta-chat] dispose: ${error.message || error}`) }
    }
    await service.stop().catch(() => {})
  }
}
