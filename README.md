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
- 支持主动搭话：每 20 分钟醒来判断一次，挑最久没说话的那个会话看看要不要开口；主人和朋友用同一套判断，只是回复形式不同（可关）。
- **小号记忆同步**：好友说「B 是我的小号，同步记忆」时，它不会直接信——先给 B 发一个 6 位确认码，B 回 `/sync 码` 确认后才把两个地址合成一个人：共用长期/短期记忆和最近聊天记录，之后跟谁聊都算同一个人。主人自己说这句话则直接同步，不用确认。发 `/unlink` 解开。
- **思考中途也能说话**：一轮还没干完时想先回一句（报进度、回答插进来的问题），它调用 `delta_chat_say` 立刻发出，不用等整轮结束；最终回复再另外发，不重复。子智能体在等模型时收到的插话会以 `steer` 送进当前回合，下一次工具边界就能看到。
- **斜杠命令兜底**：消息以 `/` 开头但没匹配到任何真实命令时，不把原文丢给模型，而是回一张命令表（`/help`）。现有命令只有 `/help`、`/status`、`/sync`、`/sync 码`、`/unlink`、`/pair 码`、`/unpair`。
- **自己排定时消息**：说「20 分钟后提醒我」「每天九点叫我」，它用内置的 `delta_chat_schedule` 排一个唤醒点（`afterSeconds` / `atIso` / `everySeconds`）。到点才读当时的聊天记录、自己决定说什么——也可能觉得这会儿不合适就不说，不会把排的时候那句话死板地念出来。`delta_chat_schedules` 查、`delta_chat_schedule_cancel` 撤。朋友会话也能用（只能排在自己会话里），不用再自己写定时插件。
- **主动关心**：每 `careEveryMinutes` 分钟（默认 20）它自己醒来想一次「要不要说句话」，候选是所有非群聊里最久没说话的那个——主人和朋友走同一套逻辑、同一份「性格」配置。最近 `proactiveMinIdleMinutes`（默认 20）分钟内有过对话就不打扰，主动过一次之后 `proactiveCooldownHours`（默认 3）小时内不重复；它记得你说过「接下来几小时忙」就自己跳过。不分昼夜——作息因人而异，它只看聊天里的信号。
- **同步邀请码**：嫌名字会重名，可以让它「给我一个同步码」（或直接发 `/sync`），它会回一个 6 位码（字母+数字、10 分钟、一次性）。把码发给对方，对方在聊天里发 `/sync 码` 就行——完全按地址认人，不靠昵称。
- **重启后自己回来**：DSH 关掉时它是在跑的，下次 DSH 一起来它就按上次状态自动上线（`autoResume`，默认开）。如果是异常关掉——内核崩了、进程被杀了——立刻重试一次，之后每 `retryEveryMinutes` 分钟重试一次，最多 `retryMax` 次（默认 30 分钟 × 8 次）。八次都起不来，它会尽力再用 Delta Chat 给每个好友发一条异常关闭的日志；连这个也发不出去就只留在 audit 里，不再无限重试。发 `/delta_chat_stop` 主动关掉的不会自动回来。
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

- 硬编码的系统提示词（身份框架、工具自审规则、纯文本输出契约）在 `lib/persona.js`。
- 风格/人设提示词首次运行会从包内 `prompts/persona.md` 复制到 `~/.dsh/delta-chat/prompts/persona.md`，之后改的都是数据目录这份，升级插件不会覆盖；改完下一条消息就生效（按文件 mtime 热加载），不用重启服务。
- 实际发给模型的内容 = 硬编码系统提示词 + `prompts/persona.md` + 每条消息的用户提示词（压缩记忆、对方印象、当前心情、最近 16 条、当前时间）。`.md` 改完下一条新消息就会用新版本（旧子智能体在下一次对话时自动换新）。
- 主人和朋友共用一套纯文本输出契约：正文按空行分成几条消息；`[附件] 路径 | 说明` 发文件；`[记忆] 一句话` 更新印象；`[心情] 10～25 字` 更新心情；什么都不输出就是不回。解析在 `lib/persona.js` 的 `splitReply()`，三个标记行都不会发给对方。
- 想确认提示词到底有没有生效，直接调用 `delta_chat_prompt`（可带 `chatId`）：它会原样打印子智能体收到的系统提示词全文，以及该会话的压缩记忆和最近几条聊天。
- 聊天由真正的 DSH 子智能体完成：每个 Delta Chat 会话一个，服务启动后按需创建，`delta_chat_stop` 时全部销毁。
- 每个子智能体只回答一次就换新会话（`sessionTurns=1`），上下文不会重复叠加；历史靠压缩记忆 + 最近 16 条承载，而不是把全部聊天记录反复塞进去。
- 忙的时候再来一句，会直接插进正在生成的那一轮（`agent.steer()`，在下一个 step 边界被采纳），不会另起一轮、也不会先回一句“在听了”。插进去的这句如果那一轮最后没答上来（报错、超时、模型选择沉默），会自动重新排队，不会丢。
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

主人绑定只存一份：`~/.dsh/delta-chat/state.json` 里的 `ownerAddr`。设置页那一栏读写的就是这个值，留空保存=解绑并生成新的绑定码；配置文件里没有 `ownerAddr`，重启也不会把旧地址塞回来。

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
| `proactiveMinIdleMinutes` | `20` | 多久没说话才考虑主动搭话 |
| `proactiveCooldownHours` | `3` | 同一会话两次主动搭话的最短间隔 |
| `careEveryMinutes` | `20` | 醒来判断「要不要说话」的间隔（主人和朋友共用） |
| `quietStart` / `quietEnd` | 未设置 | 可选的免打扰时段（本地时间）；默认不分昼夜，由它按聊天上下文判断 |
| `maxBacklogHours` | `72` | 启动时超过这么久的历史消息只读不回 |
| `memoryChars` | `3000` | 每个会话长期记忆（压缩后）的字数上限，约等于一个人几周内真正记住的内容 |
| `transcriptLimit` | `16` | 提示词里保留多少条最近原文，更早的进压缩记忆 |
| `promptDir` | `~/.dsh/delta-chat/prompts/` | 风格提示词目录；留空用数据目录那份（首次从包内复制） |
| `agentCwd` | 空 | 主人模式下 DSH 助理的工作目录；空则用 `$HOME` |
| `agentMaxTokens` | `8000` | 子智能体单次回复的 token 上限 |
| `agentTimeoutSeconds` | `600` | 子智能体单次任务超时时间（主人/聊天共用） |

## 数据与隐私

默认目录：

```text
$DSH_HOME/delta-chat/
├── state.json       # 账号地址、会话摘要、统计（600）
├── audit.jsonl      # 收发/搜索/错误审计（600）
├── rpc/             # Delta Chat 账号数据库（内核管理）
└── users/           # 每个聊天对象一个工作区文件夹（700）
    └── <邮箱>/
        ├── inbox/   # 对方发来的文件（files/ 与 media/）
        └── outbox/  # TA 想发出去的东西，也可以自己建子目录
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
- 非主人会话有自己的工作区 `$DSH_HOME/delta-chat/users/<邮箱>/`：工具面只留 `web_search` / `web_fetch` / `delta_chat_schedule` / `delta_chat_say` 和 `bash` / `read` / `read_image` / `write` / `edit` / `glob` / `grep`，其中所有路径都必须落在工作区内，`tools.guard` 会逐条校验并拒绝越界（`..`、软链接、`/etc`、`~`、`$HOME`）。
- shell 不是白名单制：**能跑什么由大肥鱼自己判断**，插件只硬拦几类会让围栏失效的东西——解释器/脚本运行时（`sh`/`python`/`node`/`sed`/`awk`/`powershell`/`cmd` 这些能绕开路径检查的）、网络客户端（`curl`/`wget`/`ssh`/`pip`/`npm`/`openssl`/`socat` 等，联网走 `web_search`/`web_fetch`）、多合一工具箱（`busybox`/`toybox`）、设备与身份查询（`ip`/`ifconfig`/`getprop`/`hostname`/`uname`/`id`/`whoami`/`df`/`wmic`/`system_profiler` 等）、进程与挂载（`ps`/`kill`/`mount`/`su`）、裸打印环境变量（`env`/`printenv`/`set`），以及直接执行文件（`./x`、`/bin/x`、`C:\\x.exe`）。`git` 只允许工作区内的本地操作，联网子命令和 `--global` 会被拦。其余命令（`date`、`sort`、`find`、`tar`、`zip`、`jq`、`du`…）随便用。
- 通配符由插件自己展开：命令里的未加引号 glob（`*.txt`、`inbox/*`）会用 `fs.globSync` 在工作区里展开，每一条匹配都要落在工作区内，否则整条命令拒绝；展开不到任何文件也拒绝（没法确认指向哪里）。`$变量`、`${...}`、`$'...'`、`~用户`、`%VAR%` 因为不能在不执行任何东西的前提下确定结果，直接拒绝；`$(...)` 和反引号会被拆成独立命令逐条校验。
- 路径校验跨平台：`..`（`/` 或 `\` 分隔）、`~`、`$HOME`、`%USERPROFILE%`、POSIX 绝对路径、Windows 盘符（`C:\x`、`C:/x`）和 UNC（`\\host\share`）都会被判定，工作区外一律拒绝。
- 这是**软隔离**：朋友会话固定使用 `danger-full-access` 加插件的确定性 guard（不依赖 OS 沙箱后端，因此在 Termux/Android、Linux、macOS、Windows 上行为一致）。guard 是确定性的字符串/路径校验，能挡住正常使用和提示词诱导，但挡不住刻意构造的 shell 绕过；不要把不可信的人加进来。
- 朋友也会被提示词明确要求不要查 IP / MAC / 主机名 / 设备型号 / 序列号 / 账号等设备与网络身份信息；`/proc`、`/sys` 这类路径本来就在工作区外面，加上上面那几类命令的硬拦，日常使用里基本摸不到。
- 身份同步（`/sync`）后，两个地址的一对一聊天记录会**交叉合并成一份**：模型看到的是按时间排好的合并记录，长期记忆的压缩也是拿合并后的记录做的，不是各记各的。合并后已经压进记忆的原文会从两边的历史里清掉，避免同一条事在合并窗口里出现两次。
- 收发文件：对方发来的附件自动存到工作区的 `inbox/`；回复里写一行「`[附件] 相对路径 | 说明`」就能发（最多 3 个，单个 ≤ 50MB）；发文件夹会依次尝试 `zip` → `7z` → `tar.gz` 打包再发（跨平台）。主人和朋友用的是同一套标记。
- 聊天/主人模式都依赖 DSH 的 `agents` 服务和模型；如果 profile 没有可用模型，会报错或退回兜底短句。
- 主人会话的工作区固定为 `$DSH_HOME/delta-chat/users/<主人邮箱>/`，和你在哪个工作区启动无关，同一台机器上文件始终在一起管理；agent 预设、模型参数（provider / model / 思考强度）仍然继承 `delta_chat_start` 所在的会话，换模型时重新调用一次即可。
- 插件创建的会话会自动注册成 Workspace 并挂到对应目录下，所以在界面里按工作区分组显示、预设与系统提示词都可查看，不会掉进“未分组”。
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
node --check lib/workspace.js
node --check lib/friend-sandbox.js
node test/smoke.mjs   # 提示词拼接 / 回复解析 / 工作区与工具闸门
node test/steer.mjs   # 忙时插话
```

安装为 DSH bundle：

```text
plugin_manager action=install_bundle target=/data/data/com.termux/files/home/dsh_ext
```

## 配置与设置页

配置分三层叠加，后一层覆盖前一层：

1. 包内 `config.json`：随插件发布的默认值（`lib/defaults.js` 是代码里的兜底，两者保持一致）。
2. profile patch 里的 `config`（一般不用动）。
3. `~/.dsh/delta-chat/config.json`：只写你要改的键，没写的键自动跳过、继续沿用默认值。

Web GUI 的「设置」里新增了一栏 **Delta Chat**：可以改昵称、主人邮箱、主动判断开关、重启自动恢复、回复间隔、记忆上限、重试次数等常用项，也能直接编辑 `persona.md` 并保存到 `~/.dsh/delta-chat/prompts/persona.md`。保存设置会自动重启服务让数值生效；保存提示词下一条消息生效。

数据目录（默认 `~/.dsh/delta-chat/`）：

| 文件 | 内容 |
| --- | --- |
| `config.json` | 用户覆盖配置（设置页写这里） |
| `prompts/persona.md` | 可热改的风格提示词 |
| `state.json` | 账号、联系人、记忆、心情、定时消息 |
| `audit.jsonl` | 事件日志（排查用） |
