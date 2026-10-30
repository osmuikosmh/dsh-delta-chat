import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MAX_HISTORY = 40
const MAX_SEEN = 4000

export const DEFAULT_DISPLAY_NAME = '大肥鱼'

function emptyState() {
  return {
    version: 1,
    accountId: null,
    addr: null,
    displayName: DEFAULT_DISPLAY_NAME,
    invite: null,
    createdAt: Date.now(),
    lastStartedAt: null,
    lastStoppedAt: null,
    chats: {},
    seen: {},
    /** Linked identities: two Delta Chat addresses the bot treats as one person. */
    identities: {},
    stats: { replies: 0, searches: 0, proactive: 0, errors: 0, incoming: 0, ownerReplies: 0 },
    lastThought: '',
    /** Last recorded mood: { text, chatId, at }. */
    mood: null,
    lastError: null,
    historySeq: 0,
    proactiveLastAt: 0,
    ownerAddr: null,
    ownerBoundAt: null,
    pairCode: null,
  }
}

function resolveDataDir(explicit) {
  if (explicit && String(explicit).trim()) return path.resolve(String(explicit).trim())
  if (process.env.DSH_DELTA_CHAT_DIR && process.env.DSH_DELTA_CHAT_DIR.trim()) {
    return path.resolve(process.env.DSH_DELTA_CHAT_DIR.trim())
  }
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(dshHome, 'delta-chat')
}

/**
 * Small JSON store for account metadata, conversation memory, and audit trail.
 * It deliberately never stores the account password: the Delta Chat database
 * already holds the login and `list_transports` can read it back.
 */
export class ChatStore {
  constructor(dataDir) {
    this.dataDir = resolveDataDir(dataDir)
    this.rpcDir = path.join(this.dataDir, 'rpc')
    this.stateFile = path.join(this.dataDir, 'state.json')
    this.auditFile = path.join(this.dataDir, 'audit.jsonl')
    this.state = emptyState()
  }

  ensure() {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 })
    fs.mkdirSync(this.rpcDir, { recursive: true, mode: 0o700 })
    try { fs.chmodSync(this.dataDir, 0o700) } catch {}
    try { fs.chmodSync(this.rpcDir, 0o700) } catch {}
  }

  load() {
    this.ensure()
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'))
      const base = emptyState()
      this.state = {
        ...base,
        ...raw,
        chats: raw && typeof raw.chats === 'object' && raw.chats ? raw.chats : {},
        seen: raw && typeof raw.seen === 'object' && raw.seen ? raw.seen : {},
        stats: { ...base.stats, ...(raw && raw.stats ? raw.stats : {}) },
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.audit('store.load_error', { message: String(error.message || error) })
      }
      this.state = emptyState()
    }
    // Migrate history written before `seq` existed: stamp it in order so the
    // memory compressor can still tell which messages it has already absorbed.
    let seq = Number(this.state.historySeq) || 0
    for (const chat of Object.values(this.state.chats || {})) {
      if (!chat) continue
      if (typeof chat.identity !== 'string') chat.identity = ''
      if (!Array.isArray(chat.history)) continue
      for (const entry of chat.history) {
        if (entry && entry.seq === undefined) {
          seq += 1
          entry.seq = seq
        } else if (entry && Number(entry.seq) > seq) {
          seq = Number(entry.seq)
        }
      }
    }
    this.state.historySeq = seq
    // Older state files predate identity linking (two addresses of one person).
    if (!this.state.identities || typeof this.state.identities !== 'object') this.state.identities = {}
    for (const [id, rec] of Object.entries(this.state.identities)) {
      if (!rec || typeof rec !== 'object') { delete this.state.identities[id]; continue }
      if (!Array.isArray(rec.members)) rec.members = []
      if (typeof rec.memory !== 'string') rec.memory = ''
      if (typeof rec.longMemory !== 'string') rec.longMemory = ''
      rec.memoryUpto = Number(rec.memoryUpto) || 0
    }
    // Drop the oldest seen ids rather than growing forever.
    const ids = Object.keys(this.state.seen)
    if (ids.length > MAX_SEEN) {
      ids.sort((a, b) => Number(this.state.seen[a]) - Number(this.state.seen[b]))
      for (const id of ids.slice(0, ids.length - MAX_SEEN)) delete this.state.seen[id]
    }
    return this.state
  }

  save() {
    this.ensure()
    const tmp = `${this.stateFile}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, this.stateFile)
    try { fs.chmodSync(this.stateFile, 0o600) } catch {}
  }

  audit(event, fields = {}) {
    try {
      this.ensure()
      const line = JSON.stringify({ at: new Date().toISOString(), event, ...fields })
      fs.appendFileSync(this.auditFile, line + '\n', { mode: 0o600 })
    } catch {}
  }

  chat(chatId) {
    const key = String(chatId)
    if (!this.state.chats[key]) {
      this.state.chats[key] = {
        chatId: Number(chatId),
        name: '',
        addr: '',
        isGroup: false,
        identity: '',
        history: [],
        memory: '',
        longMemory: '',
        memoryUpto: 0,
        mood: '',
        moodAt: 0,
        pendingIds: [],
        lastIncomingAt: 0,
        lastReplyAt: 0,
        lastProactiveAt: 0,
      }
    }
    return this.state.chats[key]
  }

  appendHistory(chatId, entry) {
    const chat = this.chat(chatId)
    this.state.historySeq = (Number(this.state.historySeq) || 0) + 1
    chat.history.push({
      seq: this.state.historySeq,
      id: entry.id !== undefined ? entry.id : null,
      role: entry.role === 'me' ? 'me' : 'friend',
      name: entry.name || (entry.role === 'me' ? this.state.displayName : ''),
      text: String(entry.text || '').slice(0, 2000),
      ts: Number(entry.ts) || Math.floor(Date.now() / 1000),
    })
    if (chat.history.length > MAX_HISTORY) {
      chat.history.splice(0, chat.history.length - MAX_HISTORY)
    }
    if (entry.role === 'friend') chat.lastIncomingAt = Date.now()
    if (entry.role === 'me') chat.lastReplyAt = Date.now()
  }

  addPending(chatId, messageId) {
    const chat = this.chat(chatId)
    if (!chat.pendingIds.includes(messageId)) chat.pendingIds.push(messageId)
  }

  clearPending(chatId, ids) {
    const chat = this.chat(chatId)
    const drop = new Set(ids)
    chat.pendingIds = chat.pendingIds.filter((id) => !drop.has(id))
  }

  markSeen(messageId) {
    this.state.seen[String(messageId)] = Date.now()
  }

  seen(messageId) {
    return Object.prototype.hasOwnProperty.call(this.state.seen, String(messageId))
  }

  summary() {
    const chats = Object.values(this.state.chats)
      .filter((chat) => chat.history.length > 0)
      .sort((a, b) => (b.lastIncomingAt || 0) - (a.lastIncomingAt || 0))
      .map((chat) => ({
        chatId: chat.chatId,
        name: chat.name || chat.addr || `#${chat.chatId}`,
        isGroup: Boolean(chat.isGroup),
        messages: chat.history.length,
        lastIncomingAt: chat.lastIncomingAt || null,
        memory: chat.memory || '',
      }))
    return {
      addr: this.state.addr,
      displayName: this.state.displayName,
      accountId: this.state.accountId,
      invite: this.state.invite,
      chats,
      stats: this.state.stats,
      lastThought: this.state.lastThought,
      lastError: this.state.lastError,
    }
  }
}
