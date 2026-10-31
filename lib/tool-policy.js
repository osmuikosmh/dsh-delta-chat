/**
 * Tool policy for the Delta Chat agents.
 *
 * The bot "reviews" every command it is about to run: the hardcoded system
 * prompt tells it to self-check before acting, and this deterministic guard is
 * the enforcement backstop. The owner gets everything; friends get web lookups,
 * a shell that can only work inside their own workspace, and file tools limited
 * to that same folder.
 */
import { checkFriendCommand, checkFriendPath } from './friend-sandbox.js'
import { scrubSymlinks } from './workspace.js'

export const FRIEND_TOOLS = Object.freeze([
  'web_search',
  'web_fetch',
  'delta_chat_schedule',
  'delta_chat_say',
  'bash',
  'read',
  'read_image',
  'write',
  'edit',
  'glob',
  'grep',
])

const FRIEND_TOOL_SET = new Set(FRIEND_TOOLS)

/** Tools that never touch the machine and need no path check. */
const UNRESTRICTED = new Set(['web_search', 'web_fetch', 'delta_chat_schedule', 'delta_chat_say'])

const PATH_KEYS = {
  read: ['file_path'],
  read_image: ['file_path'],
  write: ['file_path'],
  edit: ['file_path'],
  glob: ['path'],
  grep: ['path'],
}

/**
 * A synchronous DSH tool guard (`agentCtx.tools.guard`): returning a string
 * denies the call and hands the reason back to the model.
 *
 * `options.workspace` is the friend's data folder; when it is missing every
 * machine-facing tool is refused (fail closed).
 */
export function friendToolGuard(exec, options = {}) {
  const name = String(exec?.name || '')
  if (UNRESTRICTED.has(name)) return undefined

  const args = exec?.arguments && typeof exec.arguments === 'object' ? exec.arguments : {}

  // A symlink inside the workspace can point anywhere: remove them before any
  // command or path check, so `cat link` cannot become `cat /etc/passwd`.
  if (options.workspace) scrubSymlinks(options.workspace)
  const workspace = options.workspace
  const fail = (reason) => {
    try {
      options.onDeny?.(name, exec, reason)
    } catch {}
    return reason
  }

  // The sandbox helpers report a single reason string; funnel it through fail()
  // so the audit entry always names the tool, never the sentence.
  const checked = { workspace, onDeny: (reason) => fail(reason) }

  if (name === 'bash') {
    const workdir = args.workdir ?? args.cwd
    if (workdir !== undefined && workdir !== null && String(workdir).trim()) {
      const reason = checkFriendPath(workdir, workspace, checked)
      if (reason) return reason
    }
    const reason = checkFriendCommand(args.command, workspace, checked)
    if (reason) return reason
    return undefined
  }

  const keys = PATH_KEYS[name]
  if (keys) {
    for (const key of keys) {
      const value = args[key]
      if (value === undefined || value === null) continue
      const reason = checkFriendPath(value, workspace, checked)
      if (reason) return reason
    }
    if (name === 'glob') {
      const pattern = String(args.pattern || '')
      if (pattern.startsWith('/') || pattern.startsWith('~')) {
        const reason = checkFriendPath(pattern, workspace, checked)
        if (reason) return reason
      }
    }
    return undefined
  }

  return fail(
    `朋友会话里不能执行「${name || '这个动作'}」：只开放联网搜索、抓网页、给自己排定时消息，`
    + '以及在自己工作区里看文件、整理文件（bash / read / write / edit / glob / grep）。'
    + '要查资料就用 web_search，需要细节再用 web_fetch。',
  )
}

export function isFriendTool(name) {
  return FRIEND_TOOL_SET.has(String(name || ''))
}
