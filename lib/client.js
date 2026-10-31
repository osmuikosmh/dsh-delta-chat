window.__ModuleLoader__.load({
  id: "dsh-delta-chat",
  factory: (require) => {
    const React = require("react")
    const { useCallback, useEffect, useMemo, useState } = React
    const h = React.createElement

    const API = "/dsh-delta-chat/api"

    const TEXTS = {
      "zh-CN": {
        title: "Delta Chat",
        intro: "大肥鱼（Delta Chat 机器人）的设置。修改保存后会立即生效；提示词改完下一条消息就用新的。",
        basic: "基本信息",
        name: "昵称",
        owner: "主人邮箱（绑定后主人私聊可执行 DSH 命令）",
        proactive: "主动判断（每 N 分钟自己醒来看看要不要说话）",
        autoResume: "DSH 重启后自动恢复运行",
        pacing: "聊天节奏与记忆",
        debounce: "收消息后等多久再回（毫秒）",
        poll: "轮询新消息间隔（毫秒）",
        careEvery: "主动判断间隔（分钟）",
        careIdle: "多久没聊才算安静（分钟）",
        memoryChars: "长期记忆上限（字）",
        transcript: "原文保留条数",
        stability: "稳定性",
        retryEvery: "异常关闭重试间隔（分钟）",
        retryMax: "最多重试次数",
        persona: "风格提示词（persona.md）",
        save: "保存设置",
        savePersona: "保存提示词",
        saved: "已保存",
        saving: "保存中…",
        loading: "读取中…",
        running: "运行中",
        stopped: "未运行",
        account: "账号",
        file: "配置文件",
        promptFile: "提示词文件",
        failed: "保存失败",
      },
      "en-US": {
        title: "Delta Chat",
        intro: "Settings for the Delta Chat bot. Changes apply immediately; prompt edits are used from the next message.",
        basic: "Basics",
        name: "Display name",
        owner: "Owner address (owner DMs can run DSH commands)",
        proactive: "Proactive check-ins",
        autoResume: "Resume automatically after DSH restarts",
        pacing: "Pacing and memory",
        debounce: "Reply debounce (ms)",
        poll: "Poll interval (ms)",
        careEvery: "Proactive interval (minutes)",
        careIdle: "Quiet threshold (minutes)",
        memoryChars: "Long-term memory cap (chars)",
        transcript: "Verbatim messages kept",
        stability: "Stability",
        retryEvery: "Retry interval after a crash (minutes)",
        retryMax: "Max retries",
        persona: "Style prompt (persona.md)",
        save: "Save settings",
        savePersona: "Save prompt",
        saved: "Saved",
        saving: "Saving…",
        loading: "Loading…",
        running: "Running",
        stopped: "Stopped",
        account: "Account",
        file: "Config file",
        promptFile: "Prompt file",
        failed: "Save failed",
      },
    }

    function useTexts() {
      const [lang, setLang] = useState("zh-CN")
      useEffect(() => {
        const pick = () => {
          const value = String((typeof navigator !== "undefined" && navigator.language) || "zh-CN")
          setLang(value.toLowerCase().startsWith("en") ? "en-US" : "zh-CN")
        }
        pick()
      }, [])
      return useMemo(() => ({ ...TEXTS["zh-CN"], ...(TEXTS[lang] || {}) }), [lang])
    }

    function row(label, control) {
      return h("label", { style: { display: "flex", flexDirection: "column", gap: 4, marginBottom: 12 } },
        h("span", { style: { fontSize: 12, opacity: 0.72 } }, label),
        control)
    }

    const inputStyle = {
      padding: "6px 8px",
      borderRadius: 6,
      border: "1px solid rgba(127,127,127,0.35)",
      background: "transparent",
      color: "inherit",
      fontSize: 13,
      width: "100%",
      boxSizing: "border-box",
    }

    function Section() {
      const t = useTexts()
      const [state, setState] = useState(null)
      const [draft, setDraft] = useState({})
      const [persona, setPersona] = useState("")
      const [busy, setBusy] = useState("")
      const [message, setMessage] = useState("")

      const load = useCallback(async () => {
        setBusy("load")
        try {
          const res = await fetch(API, { cache: "no-store" })
          const data = await res.json()
          if (!data.ok) throw new Error(data.error || "load failed")
          setState(data)
          setDraft(data.snapshot.effective)
          setPersona(data.snapshot.persona || "")
          setMessage("")
        } catch (error) {
          setMessage(`${t.failed}：${error.message || error}`)
        } finally {
          setBusy("")
        }
      }, [t])

      useEffect(() => { load() }, [load])

      const set = (key) => (event) => {
        const target = event.target
        const value = target.type === "checkbox" ? target.checked : target.value
        setDraft((prev) => ({ ...prev, [key]: value }))
      }

      const saveConfig = async () => {
        setBusy("config")
        try {
          const res = await fetch(API, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ config: draft }),
          })
          const data = await res.json()
          if (!data.ok) throw new Error(data.error || "save failed")
          setState({ ...state, ...data })
          setDraft(data.snapshot.effective)
          setPersona(data.snapshot.persona || "")
          setMessage(t.saved)
        } catch (error) {
          setMessage(`${t.failed}：${error.message || error}`)
        } finally {
          setBusy("")
        }
      }

      const savePrompt = async () => {
        setBusy("persona")
        try {
          const res = await fetch(API, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ persona }),
          })
          const data = await res.json()
          if (!data.ok) throw new Error(data.error || "save failed")
          setState({ ...state, ...data })
          setMessage(t.saved)
        } catch (error) {
          setMessage(`${t.failed}：${error.message || error}`)
        } finally {
          setBusy("")
        }
      }

      if (!state) {
        return h("div", { style: { padding: 16, fontSize: 13, opacity: 0.7 } }, t.loading)
      }

      const num = (key) => h("input", {
        style: inputStyle,
        type: "number",
        value: draft[key] ?? "",
        onChange: set(key),
      })
      const text = (key) => h("input", {
        style: inputStyle,
        type: "text",
        value: draft[key] ?? "",
        onChange: set(key),
      })
      const bool = (key) => h("input", {
        type: "checkbox",
        checked: Boolean(draft[key]),
        onChange: set(key),
      })

      return h("div", { style: { padding: "16px 4px", fontSize: 13, maxWidth: 720 } },
        h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8 } },
          h("strong", { style: { fontSize: 16 } }, t.title),
          h("span", {
            style: {
              fontSize: 11,
              padding: "1px 8px",
              borderRadius: 999,
              background: state.running ? "rgba(46,160,67,0.18)" : "rgba(127,127,127,0.18)",
            },
          }, state.running ? t.running : t.stopped)),
        h("p", { style: { opacity: 0.7, marginBottom: 16, lineHeight: 1.6 } }, t.intro),

        h("div", { style: { marginBottom: 6, fontWeight: 600 } }, t.basic),
        row(t.name, text("displayName")),
        row(t.owner, text("ownerAddr")),
        row(t.proactive, bool("proactive")),
        row(t.autoResume, bool("autoResume")),

        h("div", { style: { margin: "18px 0 6px", fontWeight: 600 } }, t.pacing),
        row(t.debounce, num("replyDebounceMs")),
        row(t.poll, num("pollIntervalMs")),
        row(t.careEvery, num("careEveryMinutes")),
        row(t.careIdle, num("careMinIdleMinutes")),
        row(t.memoryChars, num("memoryChars")),
        row(t.transcript, num("transcriptLimit")),

        h("div", { style: { margin: "18px 0 6px", fontWeight: 600 } }, t.stability),
        row(t.retryEvery, num("retryEveryMinutes")),
        row(t.retryMax, num("retryMax")),

        h("div", { style: { display: "flex", gap: 10, alignItems: "center", marginBottom: 18 } },
          h("button", {
            type: "button",
            onClick: saveConfig,
            disabled: busy === "config",
            style: { padding: "7px 16px", borderRadius: 8, cursor: "pointer" },
          }, busy === "config" ? t.saving : t.save),
          message ? h("span", { style: { fontSize: 12, opacity: 0.75 } }, message) : null),

        h("div", { style: { margin: "18px 0 6px", fontWeight: 600 } }, t.persona),
        h("textarea", {
          value: persona,
          onChange: (event) => setPersona(event.target.value),
          spellCheck: false,
          style: {
            ...inputStyle,
            minHeight: 220,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 12,
            lineHeight: 1.55,
            resize: "vertical",
          },
        }),
        h("div", { style: { display: "flex", gap: 10, alignItems: "center", margin: "10px 0 18px" } },
          h("button", {
            type: "button",
            onClick: savePrompt,
            disabled: busy === "persona",
            style: { padding: "7px 16px", borderRadius: 8, cursor: "pointer" },
          }, busy === "persona" ? t.saving : t.savePersona)),

        h("div", { style: { fontSize: 11, opacity: 0.55, lineHeight: 1.7 } },
          h("div", null, `${t.account}: ${state.addr || "—"}`),
          h("div", null, `${t.file}: ${state.configFile || state.snapshot.paths.config}`),
          h("div", null, `${t.promptFile}: ${state.snapshot.paths.persona}`)))
    }

    /** Register the settings page once the settings shell declares its slot. */
    function apply(ctx) {
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "delta-chat",
        order: 40,
        label: () => "Delta Chat",
      }, Section))
    }

    const inject = ["slots"]

    return { apply, inject }
  },
})
