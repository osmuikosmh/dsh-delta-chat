import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const ENGLISH_FILE = 'persona.en.md'
const LIMITS_ENGLISH_FILE = 'limits.en.md'

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

  /** The persona the model actually reads: English cache first, Chinese source otherwise. */
  style() {
    return this.english() || this.rawStyle()
  }

  /** The Chinese source the user edits. */
  rawStyle() {
    return this.read('persona.md')
  }

  english() {
    const text = this.read(ENGLISH_FILE)
    return text.replace(/^<!--[^>]*-->\s*/, '').trim()
  }

  /** English translation is missing or older than persona.md. */
  needsEnglish() {
    if (!this.english()) return true
    return this.#englishSource() !== this.sourceStamp()
  }

  /** mtime+size of persona.md only: the English cache depends on this alone. */
  sourceStamp() {
    try {
      const stat = fs.statSync(path.join(this.dir, 'persona.md'))
      return `${stat.mtimeMs}:${stat.size}`
    } catch {
      return ''
    }
  }

  #englishSource() {
    const text = this.read(ENGLISH_FILE)
    const match = /^<!--\s*source:([^>]*)-->/.exec(text)
    return match ? match[1].trim() : ''
  }

  saveEnglish(text, source) {
    const body = String(text || '').trim()
    const file = path.join(this.dir, ENGLISH_FILE)
    fs.writeFileSync(file, `<!-- source:${source} -->\n${body}\n`, 'utf8')
    this.cache.delete(ENGLISH_FILE)
    return file
  }

  /** The user's hard limits in English (cached translation first). */
  limits() {
    return this.limitsEnglish() || this.rawLimits()
  }

  /** The Chinese source of limits.md the user edits. */
  rawLimits() {
    return this.read('limits.md')
  }

  limitsEnglish() {
    const text = this.read(LIMITS_ENGLISH_FILE)
    return text.replace(/^<!--[^>]*-->\s*/, '').trim()
  }

  limitsSourceStamp() {
    try {
      const stat = fs.statSync(path.join(this.dir, 'limits.md'))
      return `${stat.mtimeMs}:${stat.size}`
    } catch {
      return ''
    }
  }

  needsLimitsEnglish() {
    const source = this.rawLimits()
    if (!source) return false
    if (!this.limitsEnglish()) return true
    const text = this.read(LIMITS_ENGLISH_FILE)
    const match = /^<!--\s*source:([^>]*)-->/.exec(text)
    return (match ? match[1].trim() : '') !== this.limitsSourceStamp()
  }

  saveLimitsEnglish(text, source) {
    const body = String(text || '').trim()
    const file = path.join(this.dir, LIMITS_ENGLISH_FILE)
    fs.writeFileSync(file, `<!-- source:${source} -->\n${body}\n`, 'utf8')
    this.cache.delete(LIMITS_ENGLISH_FILE)
    return file
  }

  /** Stable fingerprint of the style files (mtime+size), without the clock. */
  signature(name = 'persona.md') {
    const stamp = (file) => {
      try {
        const stat = fs.statSync(path.join(this.dir, file))
        return `${stat.mtimeMs}:${stat.size}`
      } catch {
        return ''
      }
    }
    if (name !== 'persona.md') return stamp(name)
    return `${stamp('persona.md')}|${stamp('limits.md')}|${stamp(ENGLISH_FILE)}|${stamp(LIMITS_ENGLISH_FILE)}`
  }

  paths() {
    return {
      dir: this.dir,
      persona: path.join(this.dir, 'persona.md'),
      english: path.join(this.dir, ENGLISH_FILE),
      limits: path.join(this.dir, 'limits.md'),
      limitsEnglish: path.join(this.dir, LIMITS_ENGLISH_FILE),
    }
  }
}
