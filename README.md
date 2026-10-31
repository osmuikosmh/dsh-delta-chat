# 大肥鱼 Delta Chat

让 DSH 变成一只住在服务器鱼缸里的胖鲸鱼，用自己的 Delta Chat 账号和好友像真人网友一样聊天。

## 它做什么

- 首次 `delta_chat_start` 时自动向 chatmail 中转站申请一个新账号（随机地址 + 随机密码，密码只留在 Delta Chat 自己的数据库里）。
- 生成一张邀请链接；朋友在 Delta Chat 里打开链接、完成加密握手后，就能和“大肥鱼”聊天。
- 收到消息立刻想、立刻回，不再故意等几十秒；仍然拆成 1～4 条短消息，会接梗、会吐槽、会困、会摸鱼。
- 消息一读到就回已读回执；如果它还在憋上一条的回复，你中间又发消息，它会先插一句“等下，我字还没打完”，再接着回。
- 内核二进制不随插件走：按平台从 `@deltachat/stdio-rpc-server-*` 安装，真正跨平台。
- 每条消息都交给后台子智能体处理：需要事实/时效信息时，它自己调用 `web_search` / `web_fetch`，不再靠提示词预判“要不要搜”，把结果自然融进聊天。
- 动手前先自审：非主人的会话只开放联网搜索/抓网页，shell、文件读写、系统命令一律被硬性拦下。
- 支持主动搭话：好友很久没说话时，偶尔发一条不刻意的消息（可关）。
- **小号记忆同步**：好友说「B 是我的小号，同步记忆」时，它不会直接信——先给 B 发一个 6 位确认码，B 回 `/sync 码` 确认后才把两个地址合成一个人：共用长期/短期记忆和最近聊天记录，之后跟谁聊都算同一个人。主人自己说这句话则直接同步，不用确认。发 `/unlink` 解开。
- **自己排定时消息**：说「20 分钟后提醒我」「每天九点叫我」，它用内置的 `delta_chat_schedule` 排一个唤醒点（`afterSeconds` / `atIso` / `everySeconds`）。到点才读当时的聊天记录、自己决定说什么——也可能觉得这会儿不合适就不说，不会把排的时候那句话死板地念出来。`delta_chat_schedules` 查、`delta_chat_schedule_cancel` 撤。朋友会话也能用（只能排在自己会话里），不用再自己写定时插件。
- **主动关心**：每 `careEveryMinutes` 分钟（默认 30）它自己醒来想一次「要不要跟主人说句话」；最近有过对话、知道主人在忙/开会/开车，或者没什么可说的，就保持安静。不分昼夜——作息因人而异，它只看聊天里的信号。
- **同步邀请码**：嫌名字会重名，可以让它「给我一个同步码」（或直接发 `/sync`），它会回一个 6 位码（字母+数字、10 分钟、一次性）。把码发给对方，对方在聊天里发 `/sync 码` 就行——完全按地址认人，不靠昵称。
- **主人模式**：绑定一个主人邮箱后，只有主人的私聊命令会**无条件执行**，可用完整 DSH 助理能力——`bash`、读写文件、执行命令、联网搜索，并把真实 shell 输出回给你；其他好友仍然只能普通聊天。
- 聊天记录、账号状态、审计日志都在本地，不上传。
- 会看情况不回：对方只是「ok」「嗯」「收到」、发个表情、收尾附和，或者明确说“别回了”，它就不回——回不回由它自己判断，不用每条都应付。
- 能发文件：主人让发图片/文件时，它把真实文件发出去；收到的图片只当「（图片）」提示，看不到画面，会如实说看不见。
- 有心情：每聊完一次会留下一点情绪（被夸了有点飘、被冷落有点闷），存进 `state.json`，下次开口带着余味；放久了会自然淡掉，不会永远记仇也不会永远兴奋。
- 记忆像人一样分层：最近 16 条保留原文；更早的消息由专门的记忆子智能体压成“你记得的事”，分长期层（TA 是谁、关系、喜好、承诺、共同经历）、中期层（最近几周在聊什么）、短期层（寒暄琐事一句话带过或丢掉）。模型上下文不会随聊天变长而膨胀。

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

## 提示词与子智能体

- 硬编码的系统提示词（身份框架、工具自审规则、JSON 输出契约）在 `lib/persona.js`。
- 风格/人设提示词在 `prompts/persona.md`，改完下一条消息就生效（按文件 mtime 热加载），不用重启服务。
- 实际发给模型的内容 = 硬编码系统提示词 + `prompts/persona.md` + 每条消息的用户提示词（压缩记忆、对方印象、当前心情、最近 16 条、当前时间）。`.md` 改完下一条新消息就会用新版本（旧子智能体在下一次对话时自动换新）。
- 想确认提示词到底有没有生效，直接调用 `delta_chat_prompt`（可带 `chatId`）：它会原样打印子智能体收到的系统提示词全文，以及该会话的压缩记忆和最近几条聊天。
- 聊天由真正的 DSH 子智能体完成：每个 Delta Chat 会话一个，服务启动后按需创建，`delta_chat_stop` 时全部销毁。
- 每个子智能体只回答一次就换新会话（`sessionTurns=1`），上下文不会重复叠加；历史靠压缩记忆 + 最近 16 条承载，而不是把全部聊天记录反复塞进去。
- 子智能体的工具面：朋友会话 `tools.restrict` 只留 `web_search` / `web_fetch`，再加一层 `tools.guard`（返回拒绝理由）兜底；主人会话不设限。

## 主人模式（完整 DSH 能力）

插件启动时如果还没有主人，会生成一个 6 位绑定码（`delta_chat_status` 可见）。用你自己的 Delta Chat 账号给大肥鱼发：

```text
/pair 123456
```

绑定成功后，你的私聊就会进入助理模式：可以叫它跑 `bash`、看目录、装东西、读写文件、搜网页，它会把真实结果回给你。其他好友仍然只是普通聊天，碰不到 shell。

也可以在 DSH 里直接调用工具绑定/解绑：

```text
delta_chat_owner address=you@chatmail.cc
delta_chat_owner clear=true
```

主人私聊里发 `/unpair` 也能解绑。主人的另一个号用 `/sync` 跟主人确认绑定后，那个号也按主人对待（同一个人，命令同样无条件执行）。**绑定前请确认这个 Delta Chat 账号只有你自己能登录**——主人模式等于把 shell 交给这个账号，邀请链接不要随便发给别人。

## 配置

在 profile 的 `cordis.patch.yml` 里改 `dsh-delta-chat` 那一行的 `config`：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `displayName` | `大肥鱼` | Delta Chat 昵称，也会写进邀请链接 |
| `selfStatus` | 一条住在服务器鱼缸里的胖鲸鱼，专业摸鱼 | Delta Chat 签名 |
| `dataDir` | `$DSH_HOME/delta-chat` | 账号数据库、状态、日志目录；也可用 `DSH_DELTA_CHAT_DIR` |
| `binary` | 空 | 自定义 Delta Chat RPC 内核路径；留空则按平台用 npm 包里的二进制 |
| `maxAttachmentMb` | `50` | 收发的图片/文件大小上限 |
| `replyDebounceMs` | `1300` | 对方连发几条时，等多久合并回复 |
| `fallbackOnError` | `true` | 模型临时失败时，是否发一句很短的兜底话 |
| `proactive` | `true` | 是否主动搭话 |
| `proactiveMinIdleHours` | `12` | 多久没说话才考虑主动搭话 |
| `proactiveCooldownHours` | `24` | 同一好友两次主动搭话的最短间隔 |
| `quietStart` / `quietEnd` | 未设置 | 可选的免打扰时段（本地时间）；默认不分昼夜，由它按聊天上下文判断 |
| `maxBacklogHours` | `72` | 启动时超过这么久的历史消息只读不回 |
| `memoryChars` | `3000` | 每个会话长期记忆（压缩后）的字数上限，约等于一个人几周内真正记住的内容 |
| `transcriptLimit` | `16` | 提示词里保留多少条最近原文，更早的进压缩记忆 |
| `ownerAddr` | 空 | 主人邮箱；留空则用绑定码配对。只有这个地址的私聊能无条件执行命令 |
| `promptDir` | 包内 `prompts/` | 风格提示词目录；留空用自带 `prompts/persona.md` |
| `agentCwd` | 空 | 主人模式下 DSH 助理的工作目录；空则用 `$HOME` |
| `agentMaxTokens` | `8000` | 子智能体单次回复的 token 上限 |
| `agentTimeoutSeconds` | `600` | 子智能体单次任务超时时间（主人/聊天共用） |

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
- 搜索/抓网页由子智能体调用 DSH 的 `web_search` / `web_fetch` 工具完成，插件不直接发搜索请求。

## 已知边界

- chatmail 账号是“首次登录自动创建”，但需要当前网络能连上某个 chatmail 中转站；连不上时 `delta_chat_start` 会报错并提示换网络。
- Delta Chat 的端到端加密要求先通过邀请链接/securejoin 握手；直接给陌生地址发消息会报 `e2e encryption unavailable`，这是协议限制，不是插件 bug。
- 插件源码不带任何二进制：`deltachat-rpc-server` 由 `@deltachat/stdio-rpc-server-<平台>-<架构>` 可选依赖按机器安装（linux/darwin/win32/android）。解析顺序是 `binary` 配置 → `DELTA_CHAT_RPC_SERVER` → 本地 `bin/` → 平台 npm 包 → PATH。缺失时报错会直接给出该装的包名。
- 收到消息后会调 `markseen_msgs` 回报已读（对面能看到已读回执）。
- 群聊只在被点名/被接话时回复。
- 主人模式给的是完整 shell/文件权限（`danger-full-access`），命令不经过审核直接执行；请只绑定自己的账号，不要把邀请链接和绑定码外传。
- 非主人会话运行在 `read-only` 沙箱里，工具面只留 `web_search` / `web_fetch`；即使模型想越界，`tools.guard` 也会拒绝并说明原因。
- 聊天/主人模式都依赖 DSH 的 `agents` 服务和默认模型；如果 profile 没有可用模型，会报错或退回兜底短句。
- 每个会话的子智能体在服务停止时销毁；重新启动后会按需新建。长期记忆存在 `state.json`（`longMemory` / `memoryUpto`），不依赖子智能体会话。
- “像真人”是角色扮演，不冒充真实存在的人；不承诺转账、见面、恋爱等现实关系。

## 开发

```bash
node --check index.js
node --check lib/rpc.js
node --check lib/store.js
node --check lib/persona.js
node --check lib/prompts.js
node --check lib/tool-policy.js
node --check lib/agent-bridge.js
node --check lib/owner.js
node --check lib/service.js
node --check lib/rpc-binary.js
node --check lib/memory.js
node test/smoke.mjs   # 提示词拼接 / JSON 解析 / 工具闸门
```

安装为 DSH bundle：

```text
plugin_manager action=install_bundle target=/data/data/com.termux/files/home/dsh_ext
```
