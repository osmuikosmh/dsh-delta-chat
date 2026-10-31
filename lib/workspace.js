import fs from 'node:fs'
import path from 'node:path'

/**
 * Per-friend data folders.
 *
 * Every non-owner conversation gets its own directory under
 * `<dataDir>/users/<address>/`. It is the only place a friend agent may read,
 * write or run shell commands in, and it is where incoming attachments land
 * and outgoing ones are read from.
 *
 * The address is normalised instead of hashed so the owner can find a friend's
 * stuff by eye; anything outside `[a-z0-9@._+-]` becomes `_`, and a chat with
 * no address at all falls back to its numeric chat id.
 */
export function safeAddress(addr) {
  return String(addr || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9@._+-]/g, '_')
    .slice(0, 96)
}

export function usersRoot(dataDir) {
  return path.join(String(dataDir), 'users')
}

/** Absolute workspace path for one conversation (not created yet). */
export function workspaceFor(dataDir, addr, chatId) {
  const key = safeAddress(addr) || `chat-${Number(chatId) || 0}`
  return path.join(usersRoot(dataDir), key)
}

/** Create the workspace (and its inbox/outbox) if needed, 0700. */
export function ensureWorkspace(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (const sub of ['inbox', 'outbox']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true, mode: 0o700 })
  }
  return dir
}

function realPathLoose(target) {
  let current = path.resolve(target)
  const tail = []
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const real = fs.realpathSync(current)
      return tail.length ? path.join(real, ...tail) : real
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return path.resolve(target)
      tail.unshift(path.basename(current))
      current = parent
    }
  }
  return path.resolve(target)
}

export function realRoot(root) {
  try {
    return fs.realpathSync(root)
  } catch {
    return path.resolve(root)
  }
}

/**
 * True when `target` (absolute, or relative to `root`) stays inside `root`
 * after resolving `..` and any symlinks that already exist.
 */
export function isInside(root, target) {
  const value = String(target ?? '').trim()
  if (!value) return false
  if (value === '~' || value.startsWith('~/')) return false
  const base = realRoot(root)
  const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(base, value)
  const real = realPathLoose(absolute)
  return real === base || real.startsWith(base + path.sep)
}

/**
 * Delete every symlink under `root`. A symlink is a hole through text-based
 * path checks (`cat link`), so the friend guard sweeps the workspace before
 * each machine-facing tool call. Bounded, best effort, never follows links.
 */
export function scrubSymlinks(root, limit = 4000) {
  let seen = 0
  const stack = [root]
  while (stack.length && seen < limit) {
    const dir = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      seen += 1
      if (seen > limit) break
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        try {
          fs.rmSync(full, { force: true })
        } catch {}
      } else if (entry.isDirectory()) {
        stack.push(full)
      }
    }
  }
}

/** Strip directories and control characters from a received file name. */
export function safeFileName(name) {
  const base = path.basename(String(name || '').replace(/\\/g, '/'))
  const cleaned = base.replace(/[\u0000-\u001f/]/g, '_').trim()
  return cleaned.slice(0, 120) || 'file'
}

/**
 * Pick a free path for a received file: `name`, then `name-2`, `name-3`, ...
 * so two files called `photo.jpg` never overwrite each other.
 */
export function uniquePath(dir, name) {
  const base = safeFileName(name)
  const ext = path.extname(base)
  const stem = base.slice(0, base.length - ext.length) || 'file'
  let candidate = path.join(dir, base)
  for (let index = 2; index < 1000; index += 1) {
    try {
      fs.statSync(candidate)
    } catch {
      return candidate
    }
    candidate = path.join(dir, `${stem}-${index}${ext}`)
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`)
}
