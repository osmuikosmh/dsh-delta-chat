// ESM module holding the built-in defaults. Kept separate from service.js so
// the configuration layer can read defaults without importing the service.
export const DEFAULT_CONFIG = {
  displayName: '大肥鱼',
  selfStatus: '一条住在服务器鱼缸里的胖鲸鱼，专业摸鱼',
  dataDir: '',
  binary: '',
  pollIntervalMs: 2500,
  replyDebounceMs: 1300,
  /** Incoming/outgoing attachment size limit, in MB. */
  maxAttachmentMb: 50,
  fallbackOnError: true,
  proactive: true,
  /** Ask about a quiet friend at most once per this many minutes. */
  proactiveMinIdleMinutes: 20,
  /** After actually speaking up, leave that chat alone for a while. */
  proactiveCooldownHours: 3,
  /**
   * Every N minutes the bot wakes up and asks itself "should I say anything?"
   * — about the owner and about the quietest friend. The model decides; a
   * known "busy until X" in memory makes it skip on its own.
   */
  careEveryMinutes: 20,
  // No hardcoded do-not-disturb window: people keep different hours, so the
  // bot judges from the conversation instead. Set both to enable one.
  quietStart: null,
  quietEnd: null,
  maxBacklogHours: 72,
  promptDir: '',
  agentCwd: '',
  agentMaxTokens: 8000,
  agentTimeoutSeconds: 600,
  /** Keep the service running across DSH restarts, and retry an abnormal exit. */
  autoResume: true,
  retryEveryMinutes: 30,
  retryMax: 8,
  /** Long-term memory: chars kept per chat, and recent messages kept verbatim. */
  memoryChars: 3000,
  transcriptLimit: 16,
}
