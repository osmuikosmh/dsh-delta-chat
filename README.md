# 大肥鱼 Delta Chat

让 DSH 变成一只住在服务器鱼缸里的胖鲸鱼，用自己的 Delta Chat 账号和好友像真人网友一样聊天。

## 它做什么

- 首次 `delta_chat_start` 时自动向 chatmail 中转站申请一个新账号（随机地址 + 随机密码，密码只留在 Delta Chat 自己的数据库里）。
- 生成一张邀请链接；朋友在 Delta Chat 里打开链接、完成加密握手后，就能和“大肥鱼”聊天。
- 收到消息后先“读一下、想一下”，再按真人节奏分 1～4 条短消息回复；会接梗、会吐槽、会困、会摸鱼。
- 需要事实/时效信息时自己联网搜索，把结果自然融进聊天，不甩报告。
- 支持主动搭话：好友很久没说话时，偶尔发一条不刻意的消息（可关）。
- 聊天记录、长期印象、审计日志都在本地，不上传。

## 使用

在 DSH 里直接说：

```text
delta_chat_start
```

或者用斜杠命令：

```text
/delta_chat_start
```

第一次启动可能要 1～4 分钟（创建账号、连中转站）。启动完成后会返回：

- 账号地址（类似 `xxxxxxxx@chatmail.xx`）
- 邀请链接（`https://i.delta.chat/#...`）

把邀请链接发给朋友，让对方在 Delta Chat 里打开。对方加入后发第一条消息，大肥鱼就会开始回。

停止：

```text
delta_chat_stop
```

查看状态 / 再要一次邀请链接：

```text
delta_chat_status
```

## 配置

在 profile 的 `cordis.patch.yml` 里改 `dsh-delta-chat` 那一行的 `config`：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `displayName` | `大肥鱼` | Delta Chat 昵称，也会写进邀请链接 |
| `selfStatus` | 一条住在服务器鱼缸里的胖鲸鱼，专业摸鱼 | Delta Chat 签名 |
| `dataDir` | `$DSH_HOME/delta-chat` | 账号数据库、状态、日志目录；也可用 `DSH_DELTA_CHAT_DIR` |
| `binary` | 包内 `bin/deltachat-rpc-server` | 自定义 Delta Chat RPC 内核 |
| `replyTimingScale` | `1` | 回复节奏倍率；测试时可调成 `0.05` |
| `maxReplyDelaySeconds` | `90` | 单次“看到后隔多久回”的上限 |
| `replyDebounceMs` | `1300` | 对方连发几条时，等多久合并回复 |
| `fallbackOnError` | `true` | 模型临时失败时，是否发一句很短的兜底话 |
| `proactive` | `true` | 是否主动搭话 |
| `proactiveMinIdleHours` | `12` | 多久没说话才考虑主动搭话 |
| `proactiveCooldownHours` | `24` | 同一好友两次主动搭话的最短间隔 |
| `quietStart` / `quietEnd` | `23` / `8` | 免打扰时段（本地时间） |
| `maxBacklogHours` | `72` | 启动时超过这么久的历史消息只读不回 |

## 数据与隐私

默认目录：

```text
$DSH_HOME/delta-chat/
├── state.json       # 账号地址、会话摘要、统计（600）
├── audit.jsonl      # 收发/搜索/错误审计（600）
└── rpc/             # Delta Chat 账号数据库（内核管理）
```

- 不保存邮箱密码；密码在 Delta Chat 自己的数据库里。
- 审计日志只记消息摘要（每条最多 300 字），用于排查。
- 搜索走 DSH 的 `ctx.web`；如果 provider 不可用，会退到 DuckDuckGo/Bing 的 HTML 结果页。

## 已知边界

- chatmail 账号是“首次登录自动创建”，但需要当前网络能连上某个 chatmail 中转站；连不上时 `delta_chat_start` 会报错并提示换网络。
- Delta Chat 的端到端加密要求先通过邀请链接/securejoin 握手；直接给陌生地址发消息会报 `e2e encryption unavailable`，这是协议限制，不是插件 bug。
- 插件自带的是 Android arm64 的 `deltachat-rpc-server`（Termux 环境）；换平台时用 `binary` 指向对应内核。
- 群聊只在被点名/被接话时回复。
- “像真人”是角色扮演，不冒充真实存在的人；不承诺转账、见面、恋爱等现实关系。

## 开发

```bash
node --check index.js
node --check lib/rpc.js
node --check lib/store.js
node --check lib/persona.js
node --check lib/llm.js
node --check lib/service.js
```

安装为 DSH bundle：

```text
plugin_manager action=install_bundle target=/data/data/com.termux/files/home/dsh_ext
```
