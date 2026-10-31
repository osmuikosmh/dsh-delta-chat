import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_CONFIG } from './defaults.js'
import { resolveDataDir } from './store.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** Configuration shipped with the plugin; the bottom layer of every lookup. */
export const DEFAULT_CONFIG_FILE = path.resolve(HERE, '..', 'config.json')

/** Prompt files shipped with the plugin (copied into the data dir on first run). */
export const DEFAULT_PROMPT_DIR = path.resolve(HERE, '..', 'prompts')

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** Effective data directory (config.dataDir → DSH_DELTA_CHAT_DIR → $DSH_HOME/delta-chat). */
export function dataDirOf(config = {}) {
  return resolveDataDir(config.dataDir)
}

export function userConfigPath(config = {}) {
  return path.join(dataDirOf(config), 'config.json')
}

export function userPromptsDir(config = {}) {
  return path.join(dataDirOf(config), 'prompts')
}

/**
 * Layered configuration: plugin defaults (config.json in the repo) < profile
 * patch config < user overrides (~/.dsh/delta-chat/config.json). The user file
 * is what the settings page writes, so it wins over a stale patch entry.
 */
export function loadConfig(rawConfig = {}) {
  const base = readJson(DEFAULT_CONFIG_FILE)
  const merged = { ...DEFAULT_CONFIG, ...base, ...(rawConfig || {}) }
  const user = readJson(userConfigPath(merged))
  const effective = { ...merged, ...user }
  // The bound owner lives in state.json only; never let a stale config entry
  // look like a second source of truth.
  delete effective.ownerAddr
  return effective
}

const KNOWN_KEYS = Object.keys(DEFAULT_CONFIG)

/** Coerce one user-supplied value to the type its default implies. */
function coerce(key, value) {
  const fallback = DEFAULT_CONFIG[key]
  if (value === null) return typeof fallback === 'string' ? '' : fallback
  if (typeof fallback === 'number') {
    const n = Number(value)
    return Number.isFinite(n) ? n : fallback
  }
  if (typeof fallback === 'boolean') return Boolean(value)
  // string (possibly empty) or a nullable numeric window
  if (fallback === null) {
    if (value === '' || value === undefined) return null
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return String(value ?? '')
}

/** Only the documented keys are accepted from the settings page. */
export function sanitizeUserConfig(input = {}) {
  const out = {}
  for (const [key, value] of Object.entries(input || {})) {
    if (!KNOWN_KEYS.includes(key)) continue
    out[key] = coerce(key, value)
  }
  return out
}

/** Merge a patch into `~/.dsh/delta-chat/config.json` and return the new file content. */
export function saveUserConfig(config, patch = {}) {
  const file = userConfigPath(config)
  const current = readJson(file)
  const next = { ...current, ...sanitizeUserConfig(patch) }
  delete next.ownerAddr
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, file)
  try { fs.chmodSync(file, 0o600) } catch {}
  return next
}

export function readUserConfig(config) {
  return readJson(userConfigPath(config))
}

/**
 * The editable style prompt lives in the data directory so upgrades do not
 * overwrite it. First run seeds it from the copy shipped with the plugin.
 */
export function ensurePromptsDir(config = {}) {
  const dir = userPromptsDir(config)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const persona = path.join(dir, 'persona.md')
  if (!fs.existsSync(persona)) {
    const seed = path.join(DEFAULT_PROMPT_DIR, 'persona.md')
    try {
      fs.copyFileSync(seed, persona)
    } catch {
      fs.writeFileSync(persona, '', { mode: 0o600 })
    }
  }
  return dir
}

export function readPersona(config = {}) {
  const file = path.join(userPromptsDir(config), 'persona.md')
  try { return fs.readFileSync(file, 'utf8') } catch { return '' }
}

export function savePersona(config = {}, text = '') {
  const dir = ensurePromptsDir(config)
  const file = path.join(dir, 'persona.md')
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, String(text ?? ''), { mode: 0o600 })
  fs.renameSync(tmp, file)
  return file
}

/** Everything the settings page needs in one round trip. */
export function snapshot(config = {}) {
  return {
    effective: loadConfig(config),
    user: readUserConfig(config),
    defaults: readJson(DEFAULT_CONFIG_FILE),
    persona: readPersona(config),
    paths: {
      dataDir: dataDirOf(config),
      config: userConfigPath(config),
      persona: path.join(userPromptsDir(config), 'persona.md'),
    },
  }
}
