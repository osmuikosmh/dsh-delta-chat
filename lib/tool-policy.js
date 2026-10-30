/**
 * Tool policy for the Delta Chat agents.
 *
 * The bot "reviews" every command it is about to run: the hardcoded system
 * prompt tells it to self-check before acting, and this deterministic guard is
 * the enforcement backstop. The owner gets everything; friends get read-only
 * web lookups and nothing that can touch the machine.
 */
export const FRIEND_TOOLS = Object.freeze(['web_search', 'web_fetch'])

const FRIEND_TOOL_SET = new Set(FRIEND_TOOLS)

/**
 * A synchronous DSH tool guard (`agentCtx.tools.guard`): returning a string
 * denies the call and hands the reason back to the model.
 */
export function friendToolGuard(exec, options = {}) {
  const name = String(exec?.name || '')
  if (FRIEND_TOOL_SET.has(name)) return undefined
  try {
    options.onDeny?.(name, exec)
  } catch {}
  return (
    `朋友会话里不能执行「${name || '这个动作'}」：只开放联网搜索和抓网页（web_search / web_fetch），` +
    'shell、文件读写、系统命令只有主人助理模式才有。要查资料就用 web_search，需要细节再用 web_fetch。'
  )
}

export function isFriendTool(name) {
  return FRIEND_TOOL_SET.has(String(name || ''))
}
