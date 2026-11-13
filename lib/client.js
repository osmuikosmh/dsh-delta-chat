window.__ModuleLoader__.load({
  id: "dsh-delta-chat",
  factory: (require) => {
    const React = require("react")
    const { useCallback, useEffect, useMemo, useState } = React
    const h = React.createElement

    const API = "/dsh-delta-chat/api"
    let CLIENT_CTX = null
    const SHIPPED_MODELS = [{ id: "deepseek-account", name: "DeepSeek", models: [{ id: "deepseek-flash", name: "DeepSeek v4.1 flash", reasoning: { defaultEffort: "high", efforts: [{ id: "high", name: "High" }, { id: "medium", name: "Medium" }, { id: "low", name: "Low" }] } }] }]

    const TEXTS = {
      "zh-CN": {
        title: "Delta Chat",
        intro: "大肥鱼（Delta Chat 机器人）的设置。修改保存后会立即生效；提示词改完下一条消息就用新的。",
        basic: "基本信息",
        name: "昵称",
        owner: "主人邮箱（只认这一个；留空=未绑定。绑定后主人私聊可执行 DSH 命令）",
        proactive: "主动判断（每 N 分钟自己醒来看看要不要说话）",
        autoResume: "DSH 重启后自动恢复运行",
        pacing: "聊天节奏与记忆",
        debounce: "收消息后等多久再回（毫秒）",
        poll: "轮询新消息间隔（毫秒）",
        careEvery: "主动判断间隔（分钟）",
        careIdle: "多久没聊才算安静（分钟）",
        memoryChars: "长期记忆上限（字）",
        transcript: "原文保留条数",
        sessionTurns: "子智能体用满多少轮后换新会话（0=不换）",
        seenPing: "每隔多少秒刷新一次「已读」状态（0=关闭）",
        continueText: "模型空转时发送给它的催促语",
        continueRetries: "最多催几次（不计入换会话的轮数）",
        stability: "稳定性",
        modelTitle: "使用的模型",
        model: "模型（和对话框右下角的选择同步）",
        effort: "推理等级",
        effortDefault: "Off",
        service: "服务",
        serviceOn: "运行中，点击停止",
        serviceOff: "已停止，点击启动",
        modelFailed: "切换模型失败",
        retryEvery: "异常关闭重试间隔（分钟）",
        retryMax: "最多重试次数",
        persona: "风格提示词（persona.md）",
        save: "保存设置",
        savePersona: "保存提示词",
        limits: "硬性限制（limits.md）",
        saveLimits: "保存限制",
        saved: "已保存",
        saving: "保存中…",
        loading: "读取中…",
        running: "运行中",
        stopped: "未运行",
        account: "账号",
        file: "配置文件",
        promptFile: "提示词文件",
        failed: "保存失败",
        status: "状态（和 delta_chat_status 一样）",
      },
      "en-US": {
        title: "Delta Chat",
        intro: "Settings for the Delta Chat bot. Changes apply immediately; prompt edits are used from the next message.",
        basic: "Basics",
        name: "Display name",
        owner: "Owner address (the only owner; empty = unbound. Owner DMs can run DSH commands)",
        proactive: "Proactive check-ins",
        autoResume: "Resume automatically after DSH restarts",
        pacing: "Pacing and memory",
        debounce: "Reply debounce (ms)",
        poll: "Poll interval (ms)",
        careEvery: "Proactive interval (minutes)",
        careIdle: "Quiet threshold (minutes)",
        memoryChars: "Long-term memory cap (chars)",
        transcript: "Verbatim messages kept",
        sessionTurns: "Replies per agent before a fresh session (0 = never)",
        seenPing: "Refresh the seen status every N seconds (0 = off)",
        continueText: "Nudge text sent when the model stalls",
        continueRetries: "Max nudges (not counted toward session rotation)",
        stability: "Stability",
        modelTitle: "Model in use",
        model: "Model (synced with the picker at the bottom-right of the chat)",
        effort: "Reasoning effort",
        effortDefault: "Default",
        service: "Service",
        serviceOn: "Running — click to stop",
        serviceOff: "Stopped — click to start",
        modelFailed: "Could not switch model",
        retryEvery: "Retry interval after a crash (minutes)",
        retryMax: "Max retries",
        persona: "Style prompt (persona.md)",
        save: "Save settings",
        savePersona: "Save prompt",
        limits: "Hard limits (limits.md)",
        saveLimits: "Save limits",
        saved: "Saved",
        saving: "Saving…",
        loading: "Loading…",
        running: "Running",
        stopped: "Stopped",
        account: "Account",
        file: "Config file",
        promptFile: "Prompt file",
        failed: "Save failed",
        status: "Status (same as delta_chat_status)",
      },
    }

    /** Read a JSON response, keeping the HTTP status when the body is empty. */
    async function readJson(res) {
      const text = await res.text()
      if (!text) throw new Error(`HTTP ${res.status}（空响应）`)
      try {
        return JSON.parse(text)
      } catch {
        throw new Error(`HTTP ${res.status}：${text.slice(0, 200)}`)
      }
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

    function row(label, control, inline = false) {
      return h("label", {
        style: inline
          ? { display: "flex", alignItems: "center", gap: 10, marginBottom: 14, justifyContent: "space-between" }
          : { display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 },
      },
        h("span", { style: { fontSize: 12, opacity: 0.72 } }, label),
        control)
    }


    const BUTTON_CSS = `
.dc-settings .dc-btn {
  padding: 8px 18px;
  border-radius: 999px;
  border: 1px solid rgba(127,127,127,0.35);
  background: transparent;
  color: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: border-color .15s ease, color .15s ease, transform .15s ease, box-shadow .15s ease;
}
.dc-settings .dc-btn:hover:not(:disabled) { border-color: #36c5f0; color: #36c5f0; transform: translateY(-1px); }
.dc-settings .dc-btn:disabled { opacity: 0.55; cursor: default; transform: none; }
.dc-settings .dc-btn-primary {
  border-color: transparent;
  background: linear-gradient(135deg, #2f80ed, #36c5f0);
  color: #fff;
  box-shadow: 0 2px 10px rgba(54,197,240,0.35);
}
.dc-settings .dc-btn-primary:hover:not(:disabled) { color: #fff; filter: brightness(1.06); }
.dc-settings .dc-input {
  padding: 8px 12px;
  border-radius: 10px;
  border: 1px solid rgba(127,127,127,0.28);
  background: rgba(127,127,127,0.055);
  color: inherit;
  font-size: 13px;
  width: 100%;
  box-sizing: border-box;
  outline: none;
  transition: border-color .15s ease, box-shadow .15s ease, background .15s ease;
}
.dc-settings .dc-input:hover { border-color: rgba(127,127,127,0.45); }
.dc-settings .dc-input:focus {
  border-color: #36c5f0;
  background: rgba(54,197,240,0.06);
  box-shadow: 0 0 0 3px rgba(54,197,240,0.18);
}
.dc-settings .dc-textarea {
  padding: 12px 14px;
  line-height: 1.6;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  resize: vertical;
}
.dc-settings .dc-select {
  appearance: none;
  -webkit-appearance: none;
  padding-right: 34px;
  background-image: linear-gradient(45deg, transparent 50%, currentColor 50%),
    linear-gradient(135deg, currentColor 50%, transparent 50%);
  background-position: calc(100% - 18px) calc(50% + 2px), calc(100% - 13px) calc(50% + 2px);
  background-size: 5px 5px, 5px 5px;
  background-repeat: no-repeat;
  cursor: pointer;
}
.dc-settings .dc-select option, .dc-settings .dc-select optgroup { background: #1b1d21; color: #e8eaed; }
@media (prefers-color-scheme: light) {
  .dc-settings .dc-select option, .dc-settings .dc-select optgroup { background: #fff; color: #1b1d21; }
}
.dc-settings .dc-switch {
  appearance: none;
  -webkit-appearance: none;
  position: relative;
  width: 42px;
  height: 24px;
  border-radius: 999px;
  border: 1px solid rgba(127,127,127,0.35);
  background: rgba(127,127,127,0.2);
  cursor: pointer;
  transition: background .18s ease, border-color .18s ease;
  flex: none;
  margin: 0;
}
.dc-settings .dc-switch::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0,0,0,0.35);
  transition: transform .18s ease;
}
.dc-settings .dc-switch:checked {
  background: linear-gradient(135deg, #2f80ed, #36c5f0);
  border-color: transparent;
}
.dc-settings .dc-switch:checked::after { transform: translateX(18px); }
.dc-settings .dc-switch:focus-visible { box-shadow: 0 0 0 3px rgba(54,197,240,0.25); }
.dc-settings .dc-msg { font-size: 12px; opacity: 0.75; }
.dc-settings .dc-msg-error { color: #e05252; opacity: 1; }
`

    /** The owner field mirrors the real binding in state.json, not a config file. */
    function withOwner(data) {
      return { ...(data?.snapshot?.effective || {}), ownerAddr: data?.ownerAddr || "" }
    }

    function Section() {
      const t = useTexts()
      const [state, setState] = useState(null)
      const [draft, setDraft] = useState({})
      const [persona, setPersona] = useState("")
      const [limits, setLimits] = useState("")
      const [busy, setBusy] = useState("")
      const [message, setMessage] = useState("")

      // The compositor's bottom-right picker and this card share the same
      // catalog: the card polls the Host so a pick in the chat shows up here.
      const [models, setModels] = useState(null)
      const [modelMsg, setModelMsg] = useState("")
      const clientCtx = CLIENT_CTX
      const sessionId = useMemo(() => {
        try {
          const ws = clientCtx?.uiWorkspace || clientCtx?.get?.("uiWorkspace")
          return ws?.selection?.getSnapshot?.()?.sessionId || ""
        } catch { return "" }
      }, [clientCtx])
      const directory = useMemo(() => {
        try {
          if (!sessionId) return null
          const dirs = clientCtx?.modelDirectories || clientCtx?.get?.("modelDirectories")
          return dirs?.directoryFor?.(sessionId) || null
        } catch { return null }
      }, [clientCtx, sessionId])

      const catalog = state?.catalog
      const groups = (Array.isArray(catalog?.groups) && catalog.groups.length ? catalog.groups : SHIPPED_MODELS)
      const current = models?.current || state?.model || { provider: "deepseek-account", model: "deepseek-flash", reasoningEffort: "high" }
      const currentGroup = groups.find((g) => g.id === current?.provider)
      const currentModel = (currentGroup?.models || []).find((m) => m.id === current?.model)
      const efforts = currentModel?.reasoning?.efforts || []
      const modelKey = current ? `${current.provider}\u0000${current.model}` : ""
      const effortValue = current?.reasoningEffort || (efforts[0]?.id ?? "")

      /** Re-read the Host catalog + selection so the card follows the chat picker. */
      const refreshModel = useCallback(async () => {
        try {
          const res = await fetch(API, { cache: "no-store" })
          const data = await readJson(res)
          if (!data.ok) return
          setState((prev) => (prev ? { ...prev, model: data.model, catalog: data.catalog, running: data.running } : prev))
        } catch {}
      }, [])

      useEffect(() => {
        if (!directory) return undefined
        const timer = setInterval(() => {
          try { setModels(directory.store.getSnapshot()) } catch {}
        }, 1000)
        try { setModels(directory.store.getSnapshot()) } catch {}
        return () => clearInterval(timer)
      }, [directory])

      useEffect(() => {
        if (directory) return undefined
        const timer = setInterval(refreshModel, 2000)
        return () => clearInterval(timer)
      }, [directory, refreshModel])

      const applyModel = async (selection) => {
        if (directory) {
          try {
            const res = await directory.select(selection)
            if (res && res.ok === false) throw (res.error || new Error("select failed"))
            return
          } catch (error) {
            if (!/session\/writer-held/.test(String(error?.message || error))) throw error
          }
        }
        const res = await fetch(API, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: selection }),
        })
        const data = await readJson(res)
        if (!data.ok) throw new Error(data.error || "failed")
        setState((prev) => ({ ...(prev || {}), model: data.model, catalog: data.catalog || prev?.catalog, running: data.running }))
      }

      const pickModel = async (event) => {
        const value = event.target.value
        if (!value) return
        const [provider, model] = value.split("\u0000")
        const group = groups.find((g) => g.id === provider)
        const picked = (group?.models || []).find((m) => m.id === model)
        const effort = picked?.reasoning?.defaultEffort
        try {
          await applyModel({ provider, model, ...(effort ? { reasoningEffort: effort } : {}) })
          setModelMsg("")
        } catch (error) {
          setModelMsg(`${t.modelFailed}：${error?.message || error}`)
        }
      }

      const pickEffort = async (event) => {
        const effort = event.target.value
        if (!current) return
        try {
          await applyModel({ provider: current.provider, model: current.model, ...(effort ? { reasoningEffort: effort } : {}) })
          setModelMsg("")
        } catch (error) {
          setModelMsg(`${t.modelFailed}：${error?.message || error}`)
        }
      }

      const toggleService = async () => {
        setBusy("service")
        try {
          const res = await fetch(API, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: state.running ? "stop" : "start" }),
          })
          const data = await readJson(res)
          if (!data.ok) throw new Error(data.error || "failed")
          setState({ ...state, ...data })
          setMessage(data.running ? "已启动" : "已停止")
        } catch (error) {
          setMessage(`${t.failed}：${error?.message || error}`)
        } finally {
          setBusy("")
        }
      }

      const load = useCallback(async () => {
        setBusy("load")
        try {
          const res = await fetch(API, { cache: "no-store" })
          const data = await readJson(res)
          if (!data.ok) throw new Error(data.error || "load failed")
          setState(data)
          setDraft(withOwner(data))
          setPersona(data.snapshot.persona || "")
          setLimits(data.snapshot.limits || "")
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
          let res = await fetch(API, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ config: draft }),
          })
          if (res.status === 404 || res.status === 405 || res.status === 401 || res.status === 403) {
            // Proxies in front of the GUI may only pass GET to plugin routes.
            res = await fetch(`${API}?saveConfig=${encodeURIComponent(JSON.stringify(draft))}`, { cache: "no-store" })
          }
          const data = await readJson(res)
          if (!data.ok) throw new Error(data.error || "save failed")
          setState({ ...state, ...data })
          setDraft(withOwner(data))
          setPersona(data.snapshot.persona || "")
          setLimits(data.snapshot.limits || "")
          setMessage(t.saved)
        } catch (error) {
          setMessage(`${t.failed}：${error.message || error}`)
        } finally {
          setBusy("")
        }
      }

      const saveLimitsDraft = async () => {
        setBusy("limits")
        try {
          let res = await fetch(API, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ limits }),
          })
          if (res.status === 404 || res.status === 405 || res.status === 401 || res.status === 403) {
            res = await fetch(`${API}?saveLimits=${encodeURIComponent(limits)}`, { cache: "no-store" })
          }
          const data = await readJson(res)
          if (!data.ok) throw new Error(data.error || "save failed")
          setState({ ...state, ...data })
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
          let res = await fetch(API, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ persona }),
          })
          if (res.status === 404 || res.status === 405 || res.status === 401 || res.status === 403) {
            res = await fetch(`${API}?savePersona=${encodeURIComponent(persona)}`, { cache: "no-store" })
          }
          const data = await readJson(res)
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
        return h("div", { style: { padding: 16, fontSize: 13, opacity: 0.7 } },
          busy === "load" ? t.loading : (message || t.loading),
          h("button", {
            type: "button",
            onClick: load,
            className: "dc-btn", style: { marginLeft: 10 },
          }, "重新读取"))
      }

      const num = (key) => h("input", {
        className: "dc-input",
        type: "number",
        value: draft[key] ?? "",
        onChange: set(key),
      })
      const text = (key) => h("input", {
        className: "dc-input",
        type: "text",
        value: draft[key] ?? "",
        onChange: set(key),
      })
      const bool = (key) => h("input", {
        className: "dc-switch",
        type: "checkbox",
        checked: Boolean(draft[key]),
        onChange: set(key),
      })

      return h("div", { className: "dc-settings", style: { padding: "16px 4px", fontSize: 13, maxWidth: 720 } },
        h("style", null, BUTTON_CSS),
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
        h("details", { style: { margin: "10px 0 14px", border: "1px solid rgba(127,127,127,0.25)", borderRadius: 8, padding: "8px 12px" } },
          h("summary", { style: { cursor: "pointer", fontWeight: 600 } }, t.status),
          h("pre", {
            style: {
              margin: "10px 0 2px",
              whiteSpace: "pre-wrap",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: 12,
              lineHeight: 1.6,
              opacity: 0.9,
            },
          }, state.status || "—")),

        h("p", { style: { opacity: 0.7, marginBottom: 16, lineHeight: 1.6 } }, t.intro),

        h("div", { style: { marginBottom: 6, fontWeight: 600 } }, t.basic),
        row(t.name, text("displayName")),
        row(t.owner, text("ownerAddr")),
        row(t.proactive, bool("proactive"), true),
        row(t.autoResume, bool("autoResume"), true),

        h("div", { style: { margin: "18px 0 6px", fontWeight: 600 } }, t.pacing),
        row(t.debounce, num("replyDebounceMs")),
        row(t.poll, num("pollIntervalMs")),
        row(t.careEvery, num("careEveryMinutes")),
        row(t.careIdle, num("proactiveMinIdleMinutes")),
        row(t.memoryChars, num("memoryChars")),
        row(t.transcript, num("transcriptLimit")),
        row(t.sessionTurns, num("sessionTurns")),
        row(t.seenPing, num("seenPingSeconds")),
        row(t.continueText, text("continueText")),
        row(t.continueRetries, num("continueRetries")),

        h("div", { style: { margin: "18px 0 6px", fontWeight: 600 } }, t.stability),
        row(t.retryEvery, num("retryEveryMinutes")),
        row(t.retryMax, num("retryMax")),

        h("div", { style: { display: "flex", gap: 10, alignItems: "center", marginBottom: 18 } },
          h("button", {
            type: "button",
            className: "dc-btn dc-btn-primary",
            onClick: saveConfig,
            disabled: busy === "config",
          }, busy === "config" ? t.saving : t.save),
          message ? h("span", { className: message.startsWith(t.failed) ? "dc-msg dc-msg-error" : "dc-msg" }, message) : null),

        h("div", { style: { margin: "18px 0 6px", fontWeight: 600 } }, t.modelTitle),
        h("div", { style: { display: "flex", gap: 10, alignItems: "center", marginBottom: 12, flexWrap: "wrap" } },
          h("button", {
            type: "button",
            className: state.running ? "dc-btn" : "dc-btn dc-btn-primary",
            onClick: toggleService,
            disabled: busy === "service",
          }, busy === "service" ? t.saving : (state.running ? `● ${t.serviceOn}` : `○ ${t.serviceOff}`))),
        row(t.model, h("select", {
          className: "dc-input dc-select",
          value: modelKey,
          onChange: pickModel,

        },
          !modelKey ? h("option", { value: "" }, "—") : null,
          groups.map((group) => h("optgroup", { key: group.id, label: group.name || group.id },
            (group.models || []).map((model) => h("option", {
              key: `${group.id}\u0000${model.id}`,
              value: `${group.id}\u0000${model.id}`,
            }, model.name || model.id)))))),
        row(t.effort, h("select", {
          className: "dc-input dc-select",
          value: effortValue,
          onChange: pickEffort,

        },
          efforts.length
            ? efforts.map((effort) => h("option", { key: effort.id, value: effort.id }, effort.name || effort.id))
            : h("option", { value: "" }, t.effortDefault))),
        modelMsg ? h("div", { className: "dc-msg dc-msg-error" }, modelMsg) : null,

        h("div", { style: { margin: "18px 0 6px", fontWeight: 600 } }, t.limits),
        h("textarea", {
          className: "dc-input dc-textarea",
          value: limits,
          onChange: (event) => setLimits(event.target.value),
          spellCheck: false,
          style: { minHeight: 96 },
        }),
        h("div", { style: { display: "flex", gap: 10, alignItems: "center", margin: "10px 0 18px" } },
          h("button", {
            type: "button",
            className: "dc-btn dc-btn-primary",
            onClick: saveLimitsDraft,
            disabled: busy === "limits",
          }, busy === "limits" ? t.saving : t.saveLimits)),

        h("div", { style: { margin: "18px 0 6px", fontWeight: 600 } }, t.persona),
        h("textarea", {
          className: "dc-input dc-textarea",
          value: persona,
          onChange: (event) => setPersona(event.target.value),
          spellCheck: false,
          style: { minHeight: 240 },
        }),
        h("div", { style: { display: "flex", gap: 10, alignItems: "center", margin: "10px 0 18px" } },
          h("button", {
            type: "button",
            className: "dc-btn dc-btn-primary",
            onClick: savePrompt,
            disabled: busy === "persona",
          }, busy === "persona" ? t.saving : t.savePersona)),

        h("div", { style: { fontSize: 11, opacity: 0.55, lineHeight: 1.7 } },
          h("div", null, `${t.account}: ${state.addr || "—"}`),
          h("div", null, `${t.file}: ${state.configFile || state.snapshot.paths.config}`),
          h("div", null, `${t.promptFile}: ${state.snapshot.paths.persona}`),
          h("div", null, `${t.limits}: ${state.snapshot.paths.limits}`)))
    }

    /** Register the settings page once the settings shell declares its slot. */
    function apply(ctx) {
      CLIENT_CTX = ctx
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
