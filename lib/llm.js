import { clampInt, normalizeMessages, parseJsonObject, planPrompt, proactivePrompt, replyPrompt } from './persona.js'

function textOf(chunk) {
  if (!chunk || typeof chunk !== 'object') return ''
  if (chunk.type === 'text-delta') return String(chunk.text || '')
  if (chunk.type === 'reasoning-delta') return ''
  if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text') {
    return String(chunk.block.text || '')
  }
  return ''
}

function reasoningOf(chunk) {
  if (!chunk || typeof chunk !== 'object') return ''
  if (chunk.type === 'reasoning-delta') return String(chunk.text || '')
  return ''
}

/** Thin wrapper around the harness LLM service. */
export class LlmClient {
  constructor(ctx, options = {}) {
    this.ctx = ctx
    this.logger = options.logger
    this.override = options.model || null
    this.reasoningEffort = options.reasoningEffort || null
  }

  selection() {
    let current = null
    try {
      const service = this.ctx.agentDefaultModel || this.ctx.get?.('agentDefaultModel')
      current = service?.currentSelection?.()
    } catch {}
    if (!current || typeof current !== 'object') current = {}
    const provider = this.override?.provider || current.provider
    const model = this.override?.model || current.model
    if (!provider || !model) {
      throw new Error('没有可用的默认模型（agentDefaultModel.currentSelection 为空）')
    }
    return {
      provider,
      model,
      reasoningEffort: this.reasoningEffort || this.override?.reasoningEffort || current.reasoningEffort || 'high',
    }
  }

  async complete({ system, prompt, maxTokens = 1200, signal, purpose = 'delta-chat' }) {
    const selection = this.selection()
    const options = {
      provider: selection.provider,
      model: selection.model,
      reasoningEffort: selection.reasoningEffort,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens,
      temperature: 0.95,
      purpose,
      signal,
    }
    let stream
    try {
      stream = this.ctx.llm.stream(options)
    } catch (error) {
      throw new Error(`LLM 调用失败：${error.message || error}`)
    }
    const iterable = stream && typeof stream[Symbol.asyncIterator] === 'function' ? stream : await stream
    let text = ''
    let reasoning = ''
    let finish = null
    const streamedTextBlocks = new Set()
    for await (const chunk of iterable) {
      if (!chunk) continue
      if (chunk.type === 'text-delta') {
        text += textOf(chunk)
        streamedTextBlocks.add(chunk.index)
      } else if (chunk.type === 'reasoning-delta') {
        reasoning += reasoningOf(chunk)
      } else if (chunk.type === 'block-end' && chunk.block?.type === 'text' && !streamedTextBlocks.has(chunk.index)) {
        // Some providers only send the assembled block; others stream deltas and
        // repeat the full text at block-end. Never count both.
        text += textOf(chunk)
      } else if (chunk.type === 'finish') {
        finish = chunk.reason || chunk
      }
    }
    if (finish && finish.kind && finish.kind !== 'stop') {
      if (finish.kind === 'aborted') throw new Error('LLM 调用被中止')
      if (finish.kind === 'error') throw new Error(`LLM 返回错误：${finish.message || 'unknown'}`)
    }
    if (!text.trim()) throw new Error('LLM 没有返回文本')
    return { text: text.trim(), reasoning: reasoning.trim(), finish, selection }
  }

  async plan(chat, now) {
    const result = await this.complete({
      system: '你只输出一个 JSON 对象，不聊天，不解释。',
      prompt: planPrompt({ chat, now }),
      maxTokens: 500,
      purpose: 'delta-chat-plan',
    })
    const value = parseJsonObject(result.text)
    if (!value) {
      return { need_search: false, query: '', reason: '没想好，先接话', vibe: '', angle: '', raw: result.text, reasoning: result.reasoning }
    }
    return {
      need_search: Boolean(value.need_search),
      query: String(value.query || '').slice(0, 120),
      reason: String(value.reason || '').slice(0, 300),
      vibe: String(value.vibe || '').slice(0, 200),
      angle: String(value.angle || '').slice(0, 300),
      raw: result.text,
      reasoning: result.reasoning,
    }
  }

  async reply(chat, plan, results, now) {
    const result = await this.complete({
      system: '你只输出一个 JSON 对象，不解释，不 markdown。',
      prompt: replyPrompt({ chat, plan, results, now }),
      maxTokens: 1000,
      purpose: 'delta-chat-reply',
    })
    const value = parseJsonObject(result.text)
    if (!value) {
      return {
        messages: normalizeMessages(result.text),
        delaySeconds: 12,
        readSeconds: 3,
        memory: '',
        mood: '',
        reasoning: result.reasoning,
      }
    }
    return {
      messages: normalizeMessages(value.messages),
      delaySeconds: clampInt(value.delay_seconds, 6, 120, 12),
      readSeconds: clampInt(value.read_seconds, 2, 8, 3),
      memory: String(value.memory || '').slice(0, 240),
      mood: String(value.mood || '').slice(0, 120),
      skip: Boolean(value.skip),
      reasoning: result.reasoning,
    }
  }

  async proactive(chat, now, idleHours) {
    const result = await this.complete({
      system: '你只输出一个 JSON 对象，不解释，不 markdown。',
      prompt: proactivePrompt({ chat, now, idleHours }),
      maxTokens: 500,
      purpose: 'delta-chat-proactive',
    })
    const value = parseJsonObject(result.text)
    if (!value) return { messages: [], skip: true, reasoning: result.reasoning }
    return {
      messages: normalizeMessages(value.messages, 2),
      delaySeconds: clampInt(value.delay_seconds, 8, 90, 20),
      memory: String(value.memory || '').slice(0, 240),
      mood: String(value.mood || '').slice(0, 120),
      skip: Boolean(value.skip),
      reasoning: result.reasoning,
    }
  }
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim()
}

function unwrapDuckUrl(href) {
  try {
    const url = new URL(href, 'https://duckduckgo.com')
    return url.searchParams.get('uddg') || url.href
  } catch {
    return href
  }
}

function parseDuckDuckGo(html) {
  const results = []
  const regex = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>|<div[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>)/gi
  let match
  while ((match = regex.exec(html)) && results.length < 6) {
    const url = unwrapDuckUrl(match[1])
    const title = decodeHtml(match[2])
    const snippet = decodeHtml(match[3] || match[4] || '')
    if (url.startsWith('http') && title) results.push({ url, title, snippet })
  }
  return results
}

function parseBing(html) {
  const results = []
  const blocks = html.split(/<li[^>]+class="[^"]*b_algo[^"]*"/i).slice(1)
  for (const block of blocks) {
    const link = block.match(/<h2[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
    if (!link) continue
    const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i)
    const title = decodeHtml(link[2])
    if (!title || !link[1].startsWith('http')) continue
    results.push({ url: link[1], title, snippet: decodeHtml(snippet ? snippet[1] : '') })
    if (results.length >= 6) break
  }
  return results
}

/** Web search with the harness provider first, then a public HTML fallback. */
export class SearchClient {
  constructor(ctx, options = {}) {
    this.ctx = ctx
    this.logger = options.logger
    this.timeoutMs = Number(options.timeoutMs) || 20000
  }

  async search(query, signal) {
    const q = String(query || '').trim()
    if (!q) return []
    try {
      const web = this.ctx.web || this.ctx.get?.('web')
      if (web) {
        const value = await web.search({ query: q, maxResults: 5 }, signal)
        const sources = Array.isArray(value?.sources) ? value.sources : []
        const cleaned = sources
          .map((item) => ({
            url: String(item.url || ''),
            title: String(item.title || item.url || ''),
            snippet: String(item.snippet || item.content || ''),
          }))
          .filter((item) => item.url.startsWith('http'))
        if (cleaned.length) return cleaned
      }
    } catch (error) {
      this.logger?.warn?.(`[delta-chat] web provider 搜索失败：${error.message || error}`)
    }

    const headers = {
      'user-agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6',
    }
    const attempts = [
      { url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, parse: parseDuckDuckGo },
      { url: `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-Hans`, parse: parseBing },
    ]
    for (const attempt of attempts) {
      try {
        const response = await fetch(attempt.url, {
          headers,
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
        })
        if (!response.ok) continue
        const html = await response.text()
        const results = attempt.parse(html)
        if (results.length) return results
      } catch (error) {
        this.logger?.warn?.(`[delta-chat] 搜索兜底失败：${error.message || error}`)
      }
    }
    return []
  }
}
