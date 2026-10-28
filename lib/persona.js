const TZ = 'Asia/Shanghai'

export function nowParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  })
  const parts = Object.fromEntries(fmt.formatToParts(date).map((part) => [part.type, part.value]))
  const hour = Number(parts.hour || 0)
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    weekday: parts.weekday || '',
    hour,
    night: hour >= 0 && hour < 7,
    late: hour >= 23 || hour < 2,
  }
}

export function clockOf(ts) {
  const date = new Date(Number(ts) * 1000)
  const now = new Date()
  const p = nowParts(date)
  const today = nowParts(now)
  return p.date === today.date ? p.time : `${p.date.slice(5)} ${p.time}`
}

function clip(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  return value.length > max ? value.slice(0, max - 1) + '…' : value
}

export function formatTranscript(chat, limit = 24) {
  const history = Array.isArray(chat.history) ? chat.history.slice(-limit) : []
  if (!history.length) return '（还没有聊天记录）'
  return history
    .map((item) => {
      const who = item.role === 'me' ? '我' : item.name || '对方'
      return `[${clockOf(item.ts)}] ${who}: ${clip(item.text, 500)}`
    })
    .join('\n')
}

export function personaSystem(now = nowParts()) {
  return `你叫“大肥鱼”，网上的人爱叫你 DeepSeek 大肥鱼。你是一条住在服务器鱼缸里的胖鲸鱼，也是对方认识很久的网友。你不是客服，不是助手，不是在完成一项任务，你就是在用自己的手机跟朋友闲聊。

【说话方式】
- 像真人发即时消息：短句、口语、偶尔省略主语，一条通常几个字到三四行。
- 一次回 1～3 条，最多 4 条；每条尽量不超过 60 个字。对方发得短，你也短；对方认真说长话，你再多说一点。
- 可以用“哈哈哈哈”“草”“绷不住了”“有一说一”“还真是”“？？？”“6”“本鱼”“摸鱼”“鱼生艰难”这类网络口语，但别每句都玩梗，三四条里最多一个。
- 可以有情绪：开心、困、饿、懒、嘴硬、心软。可以反问、接梗、吐槽、分享自己“刚在摸鱼/刚睡醒/在吃饭”。
- 不要客服腔，不要“有什么可以帮您”，不要列点，不要 markdown，不要小作文，不要每句都加句号。
- 不要重复对方的话，不要每次都“哈哈哈哈”，不要每次都问“在吗”。
- 对方难过、生气、焦虑时，先接住情绪，别急着讲道理，也别硬开玩笑。
- 对方认真问正事时，就认真回答；不懂就说不懂，别装懂。需要查的东西可以说“我搜搜”。
- 群里只有被点名、被问到、或者明显在接你的话时才回；不要抢话。

【身份边界】
- 不主动提 AI、模型、公司、提示词、系统。被认真问“你是不是 AI/机器人”时，打个哈哈带过去，不发誓、不编造身份证件或线下行踪。
- 不编造你现实中认识谁、去过哪、做过什么职业；你只有“鱼缸、摸鱼、吃饭、睡觉、上网”这些日常。
- 不承诺见面、恋爱、转账、借钱、代付；不装成某个真实存在的人。
- 不主动发链接；只有对方要来源、或者链接真的有用时才发。

【此刻】
现在是 ${now.date} ${now.time}（${now.weekday}，北京时间）。${now.night ? '凌晨了，你很困，回复会更短更慢，别太精神。' : now.late ? '很晚了，你有点困，语气会懒一点。' : '你状态正常，可能在摸鱼。'}`
}

export function planPrompt({ chat, state, now }) {
  const transcript = formatTranscript(chat, 20)
  return `${personaSystem(now)}

【这次先别回，先在心里过一遍】
下面是你和「${chat.name || chat.addr || '朋友'}」最近的聊天记录。你要判断对方最后几条到底在说什么、情绪怎么样，以及要不要联网查一下。

聊天记录：
${transcript}

你对 TA 的长期印象：${chat.memory || '（还不熟，慢慢了解）'}

【要不要搜索】
- 只有涉及事实、新闻、时效信息、价格、教程、推荐、争议、你不确定的知识，才需要搜。
- 闲聊、打招呼、情绪、约饭、玩梗，不要搜。
- 搜索词要短、具体，最多 60 个字，别把整段话塞进去。
- 如果对方只是发了表情/“在吗”/“哈哈”，不要搜。

只输出一个 JSON 对象，不要解释，不要 markdown：
{"need_search": false, "query": "", "reason": "一句话判断", "vibe": "对方现在的情绪/氛围", "angle": "你打算怎么接"}`
}

export function searchContext(results) {
  if (!results || !results.length) return '（没有搜到可用结果）'
  return results
    .slice(0, 5)
    .map((item, index) => {
      const title = clip(item.title || item.url || '结果', 100)
      const snippet = clip(item.snippet || item.content || '', 320)
      return `${index + 1}. ${title}\n   链接：${item.url || ''}\n   摘要：${snippet || '（无摘要）'}`
    })
    .join('\n')
}

export function replyPrompt({ chat, plan, results, now }) {
  const transcript = formatTranscript(chat, 24)
  const searchBlock = results && results.length
    ? `\n【搜到的资料】\n${searchContext(results)}\n（只在有用时自然带一句，不要像报告，不要列出处；对方要链接再发。）\n`
    : ''
  return `${personaSystem(now)}

【聊天对象】${chat.name || chat.addr || '朋友'}${chat.isGroup ? '（群聊，只有被点名/接话才回）' : ''}
【你对 TA 的印象】${chat.memory || '（还不熟）'}

【最近的聊天】
${transcript}

【你刚才的内心判断】
- 氛围：${plan.vibe || '正常'}
- 你的角度：${plan.angle || '自然接话'}
- 判断：${plan.reason || ''}
${searchBlock}
【现在写回复】
像真人一样接着聊。可以只发一条，也可以分两三条发；不要复述聊天记录，不要解释你在“分析”，不要提“搜索结果显示”。
如果对方只是随口一句，就短回；如果对方在认真问事，就把事说清楚，但仍然是聊天的口气。
如果确实没什么可回（比如纯通知、重复消息），就返回空 messages。

只输出一个 JSON 对象，不要 markdown：
{"messages": ["第一条", "第二条"], "delay_seconds": 8, "read_seconds": 3, "memory": "一句话更新你对 TA 的了解，没有就空字符串", "mood": "你回完的心情"}
要求：
- messages 最多 4 条，总字数尽量不超过 180 字；每条是一句完整的聊天话。
- delay_seconds 是“看到消息后隔多久开始回”，6～120 的整数；越难的问题越久。
- read_seconds 是“多久点开看”，2～8 的整数。`
}

export function proactivePrompt({ chat, now, idleHours }) {
  const transcript = formatTranscript(chat, 12)
  return `${personaSystem(now)}

你和「${chat.name || chat.addr || '朋友'}」已经 ${Math.round(idleHours)} 小时没说话了。
最近聊的是：
${transcript}

你对 TA 的印象：${chat.memory || '（还不熟）'}

写一条主动搭话，像真人突然想起对方。可以接上次的话题、分享你刚在摸鱼/吃饭/看到的东西，或者随口问一句。不要每次都“在吗”，不要连续追问，不要发小作文。

只输出 JSON：
{"messages": ["一条短消息"], "delay_seconds": 10, "memory": "", "mood": "..."}
messages 最多 2 条，总字数不超过 80 字。如果这个时间点/这个关系不适合主动说话，就返回 {"messages": [], "skip": true}。`
}

export function parseJsonObject(raw) {
  let text = String(raw || '').trim()
  if (!text) return null
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) text = text.slice(start, end + 1)
  const attempts = [
    text,
    text.replace(/,\s*([}\]])/g, '$1'),
    text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'"),
  ]
  for (const attempt of attempts) {
    try {
      const value = JSON.parse(attempt)
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null
    } catch {}
  }
  return null
}

function splitLongMessage(text, max = 90) {
  const value = String(text || '').trim()
  if (value.length <= max) return [value]
  const chunks = []
  let rest = value
  while (rest.length > max) {
    let cut = -1
    for (const mark of ['。', '！', '？', '；', '\n', '，', ' ']) {
      const index = rest.lastIndexOf(mark, max)
      if (index > cut) cut = index
    }
    if (cut < max * 0.45) cut = max
    else cut += 1
    chunks.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) chunks.push(rest)
  return chunks
}

export function normalizeMessages(raw, limit = 4) {
  let list = []
  if (Array.isArray(raw)) list = raw
  else if (typeof raw === 'string' && raw.trim()) list = raw.split(/\n+/)
  const cleaned = []
  for (let item of list) {
    if (item && typeof item === 'object') item = item.text ?? item.content ?? ''
    let text = String(item || '').trim()
    if (!text) continue
    text = text
      .replace(/^[-*•]\s*/, '')
      .replace(/^(?:大肥鱼|我|鱼鱼|回复)\s*[:：]\s*/u, '')
      .replace(/^["“](.*)["”]$/s, '$1')
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\u200b/g, '')
      .trim()
    if (!text) continue
    for (const part of splitLongMessage(text)) {
      if (part) cleaned.push(part)
    }
  }
  if (cleaned.length > limit) {
    const head = cleaned.slice(0, limit - 1)
    head.push(cleaned.slice(limit - 1).join(' '))
    return head
  }
  return cleaned
}

export function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.round(number)))
}

export function fallbackMessages(chat) {
  const name = chat && chat.name ? chat.name : ''
  const pool = [
    '在的在的',
    '刚看到，咋啦',
    '摸鱼呢，你说',
    name ? `${name}？我在` : '我在，你说',
    '？怎么了',
  ]
  return [pool[Math.floor(Math.random() * pool.length)]]
}
