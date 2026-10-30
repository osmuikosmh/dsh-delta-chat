/**
 * Recognising when a friend says "B 是我的小号，同步记忆" and turning that into
 * an identity link. The parsing is deliberately conservative: a sentence must
 * mention an alt-account word AND a "is" verb, so ordinary chat ("我也是小号")
 * does not accidentally trigger a link.
 */

const ALT_WORDS = /(小号|另一个号|另一个账号|同一个号|同一个账号|备用号|马甲|同步记忆|同步)/

export function detectLinkRequest(text) {
  const clean = String(text || '').trim()
  if (!clean || clean.length > 240) return null
  if (!ALT_WORDS.test(clean)) return null
  let match = /([^\s，,。.;；:：！!？?]{1,30})\s*(?:是|就是|也是)\s*(?:我|我的)\s*(?:小号|另一个号|另一个账号|同一个号|同一个账号|备用号|马甲)/.exec(clean)
  if (!match) {
    match = /(?:把|让)\s*([^\s，,。.;；:：！!？?]{1,30})\s*(?:和|跟)\s*我\s*(?:的)?\s*(?:记忆)?\s*同步/.exec(clean)
  }
  if (!match) {
    match = /(?:把|让)\s*我\s*(?:的)?\s*(?:记忆)?\s*(?:和|跟)\s*([^\s，,。.;；:：！!？?]{1,30})\s*(?:的)?(?:记忆)?\s*同步/.exec(clean)
  }
  if (!match) {
    match = /(?:我|我的)\s*(?:和|跟)\s*([^\s，,。.;；:：！!？?]{1,30})\s*(?:的)?\s*(?:记忆)?\s*同步/.exec(clean)
  }
  if (!match) return null
  const name = match[1].replace(/^(?:用户|好友|联系人)/, '').trim()
  return name || null
}

export function parseSyncCommand(text) {
  const match = /^\s*\/(?:sync|同步)\s*(\d{6})\s*$/i.exec(String(text || ''))
  return match ? match[1] : null
}

export function parseUnlinkCommand(text) {
  return /^\s*\/(?:unlink|取消同步|解除同步|取消绑定)\s*$/i.test(String(text || ''))
}

/**
 * Merge several memory blobs into one, keeping the first occurrence of every
 * sentence. Used when two accounts are linked after both already remember things.
 */
export function mergeMemoryText(parts, cap = 3000) {
  const seen = new Set()
  const out = []
  for (const part of parts) {
    const text = String(part || '')
    for (const raw of text.split(/[\n。；;]+/)) {
      const line = raw.trim()
      if (!line || seen.has(line)) continue
      seen.add(line)
      out.push(line)
    }
  }
  const merged = out.join('。')
  if (merged.length <= cap) return merged
  const head = Math.max(1, Math.floor(cap * 0.6) - 1)
  const tail = Math.max(1, cap - head - 1)
  return `${merged.slice(0, head)}…${merged.slice(-tail)}`
}
