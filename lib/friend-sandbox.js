/**
 * Sandbox policy for friend conversations.
 *
 * On Android/Termux DSH has no OS-level sandbox backend (no bubblewrap, no
 * Landlock launcher), so `workspace-write` refuses to run at all. Friends
 * therefore get a real shell plus this deterministic policy layer:
 *
 *  - the agent's cwd is the friend's own workspace;
 *  - **every path must stay inside the workspace** (or be one of the /dev
 *    null/stdio streams), for shell commands and for the file tools alike;
 *  - only a short deny-list is hard-blocked: interpreters and remote-code
 *    loaders (they would walk straight through the path checks), network
 *    clients, device/identity introspection, process and mount control.
 *
 * Everything else is left to the model's judgement, by design: the point of
 * the deny-list is to close the holes that make path checking meaningless, not
 * to enumerate allowed tools. The hardcoded system prompt still tells the bot
 * to self-check ("do I need to look at the machine?") before acting.
 *
 * This is a soft boundary: it stops the model and casual prompt injection, not
 * a determined attacker with code execution inside the workspace.
 */
import { isInside } from './workspace.js'

/**
 * Hard-blocked commands, grouped by the reason handed back to the model.
 * `sh`/`python`/`node`… bypass every text-based path check, so they stay out.
 */
export const FRIEND_DENY = Object.freeze([
  {
    why: '命令解释器和远程代码加载器不能跑，它们会绕过工作区限制',
    names: [
      'sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'csh', 'tcsh',
      'python', 'python2', 'python3', 'perl', 'ruby', 'node', 'nodejs',
      'deno', 'bun', 'php', 'lua', 'luajit', 'tclsh', 'awk', 'gawk', 'mawk',
      'sed', 'eval', 'exec', 'source',
    ],
  },
  {
    why: '联网下载要用 web_search / web_fetch 工具，shell 里不开网络客户端',
    names: [
      'curl', 'wget', 'nc', 'ncat', 'netcat', 'telnet', 'ssh', 'scp', 'sftp',
      'rsync', 'ftp', 'aria2c', 'yt-dlp', 'pip', 'pip3', 'npm', 'pnpm', 'yarn',
      'apt', 'pkg',
    ],
  },
  {
    why: '设备与网络身份信息不在朋友会话的范围内（IP / MAC / 主机名 / 设备型号）',
    names: [
      'ip', 'ifconfig', 'iwconfig', 'iw', 'nmcli', 'nmtui', 'netstat', 'ss',
      'arp', 'hostname', 'hostnamectl', 'uname', 'getprop', 'setprop',
      'dumpsys', 'settings', 'service', 'logcat', 'termux-wifi-connectioninfo',
      'termux-wifi-scaninfo', 'termux-wifi-enable', 'termux-battery-status',
      'termux-usb', 'termux-sensor', 'termux-location',
    ],
  },
  {
    why: '进程、挂载和系统服务不归朋友会话管',
    names: [
      'ps', 'top', 'htop', 'kill', 'pkill', 'killall', 'nice', 'renice',
      'ionice', 'nohup', 'setsid', 'mount', 'umount', 'insmod', 'rmmod',
      'reboot', 'shutdown', 'halt', 'su', 'sudo', 'doas', 'crontab', 'at',
      'screen', 'tmux', 'disown',
    ],
  },
])

const DENY_REASON = new Map()
for (const group of FRIEND_DENY) {
  for (const name of group.names) DENY_REASON.set(name, group.why)
}

/** Words that only wrap another command (`env FOO=1 python3 …`). */
const WRAPPERS = new Set([
  'env', 'nice', 'ionice', 'stdbuf', 'timeout', 'time', 'command', 'builtin',
  'xargs', 'nohup', 'setsid',
])

/** Absolute paths that are never a file read: harmless device streams. */
const DEV_STREAMS = new Set(['/dev/null', '/dev/stdin', '/dev/stdout', '/dev/stderr', '/dev/tty'])

/** Flags that hand execution back to an arbitrary program. */
const FORBIDDEN_FLAGS = [
  '-exec', '-execdir', '-ok', '-okdir',
  '--to-command', '--use-compress-program', '--checkpoint-action',
  '--symbolic-link', '--link', '-P', '--absolute-names',
]

/** Commands that unpack an archive (and may therefore create symlinks). */
const EXTRACTORS = new Set(['unzip', 'gunzip', 'bunzip2', 'unxz'])

function deny(reason, onDeny) {
  try {
    onDeny?.(reason)
  } catch {}
  return reason
}

function bare(word) {
  return String(word || '').trim().replace(/^['"]|['"]$/g, '')
}

/**
 * Effective command words of one segment: skip `VAR=value` prefixes and
 * wrapper commands, then look at the word they wrap (so `env python3 x` and
 * `xargs sh` are caught). The first entry is the command that actually runs.
 */
function effectiveWords(segment) {
  const list = segment.trim().split(/\s+/).filter(Boolean)
  const found = []
  let index = 0
  while (index < list.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(list[index])) index += 1
  while (index < list.length && WRAPPERS.has(bare(list[index]))) {
    index += 1
    while (index < list.length && (list[index].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(list[index]))) index += 1
    if (index < list.length) found.push(bare(list[index]))
  }
  if (index < list.length && !found.length) found.push(bare(list[index]))
  return found
}

/**
 * Check one bash command against the friend policy.
 * @returns {string|undefined} a denial reason, or undefined when allowed.
 */
export function checkFriendCommand(command, workspace, options = {}) {
  const text = String(command ?? '')
  if (!text.trim()) return deny('空命令。', options.onDeny)
  if (!workspace) return deny('工作区没有准备好，先别执行命令。', options.onDeny)

  const expanded = text.replace(/\$\(/g, ' ; ').replace(/`/g, ' ; ')
  const segments = expanded.split(/[;&|\n()]+/).filter((segment) => segment.trim())
  let extracts = false

  for (const segment of segments) {
    const effective = effectiveWords(segment)
    if (!effective.length) continue
    for (const word of effective) {
      const reason = DENY_REASON.get(word)
      if (reason) return deny(`${word}：${reason}。`, options.onDeny)
      // Running a file by path (`./tool`, `/data/.../x`) is arbitrary code.
      if (word.includes('/')) {
        return deny(`不能直接执行文件「${word}」：朋友会话只跑普通命令，不跑程序或脚本。`, options.onDeny)
      }
    }
    const head = effective[0]
    if (EXTRACTORS.has(head) || (head === 'tar' && /(?:^|\s)-[a-z]*x/i.test(segment))) extracts = true
  }

  const lower = text.toLowerCase()
  if (lower.includes('$home') || lower.includes('${home}')) {
    return deny('不能读取家目录之外的东西：只允许在自己的工作区里操作。', options.onDeny)
  }

  const flag = FORBIDDEN_FLAGS.find((item) => (item === '-P' ? /(?:^|\s)-P(?:\s|$)/.test(text) : lower.includes(item)))
  if (flag) {
    return deny(`不能使用 ${flag}：它能把命令交给别的程序执行，或让归档写到工作区外面。`, options.onDeny)
  }

  if (/(?:^|[/\s'"=:])\.\.(?:[/\s'"`;|&<>)]|$)/.test(text)) {
    return deny('不能使用 ../ 往上跳：只能在当前工作区里操作。', options.onDeny)
  }

  if (/(?:^|[\s'"=:>])~(?:\/|$|[\s'"`;|&<>])/.test(text)) {
    return deny('不能用 ~ 或家目录路径：只能在自己的工作区里操作。', options.onDeny)
  }

  const pathPattern = /(?:^|[\s'"=<>|;&(:])(\/[^\s'"`;|&<>()]*)/g
  let match
  while ((match = pathPattern.exec(text)) !== null) {
    const candidate = match[1].replace(/[),.]+$/, '')
    if (!candidate || candidate === '/') {
      return deny('不能访问根目录：只能在自己的工作区里操作。', options.onDeny)
    }
    if (DEV_STREAMS.has(candidate)) continue
    if (!isInside(workspace, candidate)) {
      return deny(`不能访问工作区外面的路径：${candidate}`, options.onDeny)
    }
  }

  // Unpacking can create symlinks, and a symlink is a hole through any
  // path-text check. Keep it as its own command so the plugin's symlink sweep
  // (run before every tool call) gets a chance to remove them first.
  if (extracts && segments.length > 1) {
    return deny('解压请单独发一条命令（不要和别的命令连在一起），解压完再处理里面的文件。', options.onDeny)
  }

  return undefined
}

/**
 * Check one path argument of a file tool (`file_path`, `path`, `workdir`).
 * Relative paths are resolved against the friend workspace.
 */
export function checkFriendPath(target, workspace, options = {}) {
  const value = String(target ?? '').trim()
  if (!value) return deny('路径不能为空。', options.onDeny)
  if (!workspace) return deny('工作区没有准备好，先别动文件。', options.onDeny)
  if (value.startsWith('~')) {
    return deny('不能用 ~ 或家目录路径：只能在自己的工作区里操作。', options.onDeny)
  }
  if (!isInside(workspace, value)) {
    return deny(`不能访问工作区外面的路径：${value}`, options.onDeny)
  }
  return undefined
}
