import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** The prompts shipped with the plugin. A deployment may override the directory. */
export const DEFAULT_PROMPT_DIR = path.resolve(HERE, '..', 'prompts')

/**
 * Reads the editable prompt files (style/persona wording) that live outside
 * the hardcoded system scaffold. Files are re-read when their mtime or size
 * changes, so editing a prompt takes effect on the next message without a
 * plugin restart.
 */
export class PromptFiles {
  constructor(options = {}) {
    const dir = options.dir && String(options.dir).trim() ? String(options.dir).trim() : ''
    this.dir = dir ? path.resolve(dir) : DEFAULT_PROMPT_DIR
    this.logger = options.logger
    this.cache = new Map()
  }

  /** Read one prompt file; missing files read as an empty string. */
  read(name) {
    const file = path.join(this.dir, name)
    let stat
    try {
      stat = fs.statSync(file)
    } catch {
      this.cache.delete(name)
      return ''
    }
    const key = `${stat.mtimeMs}:${stat.size}`
    const cached = this.cache.get(name)
    if (cached && cached.key === key) return cached.text
    try {
      const text = fs.readFileSync(file, 'utf8').trim()
      this.cache.set(name, { key, text })
      return text
    } catch (error) {
      this.logger?.warn?.(`[delta-chat] 读取提示词 ${file} 失败：${error?.message || error}`)
      return cached?.text || ''
    }
  }

  /** The persona/style wording shared by friend chats and the owner assistant. */
  style() {
    return this.read('persona.md')
  }

  /** Stable fingerprint of the style file (mtime+size), without the clock. */
  signature(name = 'persona.md') {
    try {
      const stat = fs.statSync(path.join(this.dir, name))
      return `${stat.mtimeMs}:${stat.size}`
    } catch {
      return ''
    }
  }

  paths() {
    return {
      dir: this.dir,
      persona: path.join(this.dir, 'persona.md'),
    }
  }
}
