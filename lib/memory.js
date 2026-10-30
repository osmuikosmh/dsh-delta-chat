import { memoryPrompt } from './persona.js'

/**
 * Keeps each conversation's long-term memory compressed.
 *
 * The raw transcript stays in `state.json` for local history/audit, but the
 * prompts only ever carry the last few messages plus this rolling memory, so
 * the model context never grows with the length of the friendship. Like a
 * human, important things stay precise, small talk fades into a vague line.
 */
export class MemoryKeeper {
  constructor(options = {}) {
    /** Summarizer: (prompt) => Promise<string>. */
    this.ask = options.ask || null
    this.logger = options.logger
    this.cap = Math.max(200, Number(options.cap) || 1200)
    /** Recent messages kept verbatim in prompts. */
    this.keep = Math.max(2, Number(options.keep) || 8)
    /** Don't bother summarizing fewer than this many messages. */
    this.minAbsorb = Math.max(2, Number(options.minAbsorb) || 6)
    this.busy = new Set()
  }

  /**
   * Messages that are old enough to be absorbed: everything before the recent
   * window that the memory does not cover yet. `seq` survives history trimming.
   */
  plan(chat) {
    const history = Array.isArray(chat?.history) ? chat.history : []
    const upto = Number(chat?.memoryUpto) || 0
    const cutoff = Math.max(0, history.length - this.keep)
    const older = history.slice(0, cutoff).filter((entry) => Number(entry.seq) > upto)
    const last = older[older.length - 1]
    return { older, upto: last ? Number(last.seq) : upto }
  }

  async update(chat, chatId) {
    if (!chat || !this.ask) return false
    const key = String(chatId ?? chat.chatId ?? '')
    if (this.busy.has(key)) return false
    const { older, upto } = this.plan(chat)
    if (older.length < this.minAbsorb) return false
    if (upto <= (Number(chat.memoryUpto) || 0)) return false

    this.busy.add(key)
    try {
      const lines = older
        .map((entry) => `${entry.role === 'me' ? '我' : entry.name || '对方'}：${String(entry.text || '').slice(0, 300)}`)
        .join('\n')
      const text = await this.ask(memoryPrompt({ old: chat.longMemory || '', lines, cap: this.cap }))
      const summary = String(text || '').trim()
      if (summary.length < 4) return false
      chat.longMemory = summary.slice(0, this.cap)
      chat.memoryUpto = upto
      return true
    } catch (error) {
      this.logger?.warn?.(`[delta-chat] 记忆压缩失败：${error?.message || error}`)
      return false
    } finally {
      this.busy.delete(key)
    }
  }
}
