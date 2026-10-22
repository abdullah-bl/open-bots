import { useEffect, useMemo, useRef, useState } from 'react'
import { useSettings, cloudConfigured } from './lib/settings'
import { localEngine, ALL_LOCAL_MODELS } from './lib/providers/local'
import { CLAUDE_MODELS, OPENAI_COMPAT_PRESETS } from './lib/providers/openaiCompat'
import { useLocalStatus } from './hooks/useLocalStatus'
import { useAgents } from './hooks/useAgents'
import { agents } from './agent/manager'
import { TEMPLATES, type BotTemplate } from './agent/templates'
import type { BotStatus } from './agent/types'
import { Composer } from './components/Composer'
import { SettingsPanel } from './components/SettingsPanel'
import { Timeline } from './components/Timeline'
import { BotPanel } from './components/BotPanel'
import { Dot } from './components/Dot'

const IDLE: BotStatus = { state: 'idle' }

export default function App() {
  const [settings, update] = useSettings()
  const local = useLocalStatus()
  const { ready, bots, threads, status } = useAgents()
  const [activeId, setActiveId] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showPanel, setShowPanel] = useState(false)
  const [showSidebar, setShowSidebar] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    agents.setSettings(settings)
  }, [settings])

  useEffect(() => {
    agents.init()
  }, [])

  // Optionally warm up the on-device model, but only if it is already downloaded.
  useEffect(() => {
    if (!settings.autoLoadLocal) return
    localEngine.ready.then(async () => {
      const model = localEngine.pick(settings.localModel)
      if (await localEngine.isCached(model.id)) localEngine.load(model.id)
    })
    // Only on first mount.
  }, [])

  const bot = bots.find((b) => b.id === activeId) ?? null
  const thread = bot ? threads[bot.id] : null
  const botStatus = bot ? (status[bot.id] ?? IDLE) : IDLE
  const busy = botStatus.state === 'working' || botStatus.state === 'waiting'

  // Refresh the file list whenever a tool finishes.
  const filesKey = useMemo(() => thread?.turns.filter((t) => t.kind === 'tool_results').length ?? 0, [thread])

  useEffect(() => {
    const el = scrollRef.current
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 240) el.scrollTop = el.scrollHeight
  }, [thread])

  const create = async (t: BotTemplate) => {
    const b = await agents.createBot(t)
    setActiveId(b.id)
    setShowSidebar(false)
    if (t.starter) setTimeout(() => agents.send(b.id, t.starter), 50)
  }

  const engineLabel = (() => {
    if (settings.privacy) return 'Private: on-device only'
    if (cloudConfigured(settings)) {
      if (settings.cloud === 'anthropic') return CLAUDE_MODELS.find((m) => m.id === settings.anthropicModel)?.label ?? 'Claude'
      return `${OPENAI_COMPAT_PRESETS.find((p) => p.id === settings.compatPreset)?.label ?? 'Cloud'} · ${settings.compatModel}`
    }
    if (local.state === 'ready') return ALL_LOCAL_MODELS.find((m) => m.id === local.modelId)?.label ?? 'On-device'
    return 'No model set'
  })()

  return (
    <div className={`app ${showSidebar ? 'sidebar-open' : ''} ${showPanel && bot ? 'panel-open' : ''}`}>
      <nav className="sidebar">
        <div className="brand">
          <span className="brand-dots" aria-hidden>
            <i />
            <i />
            <i />
          </span>
          open-bot
        </div>
        <button
          className="new-chat"
          onClick={() => {
            setActiveId(null)
            setShowSidebar(false)
          }}
        >
          + New bot
        </button>
        <ul className="bot-list">
          {bots.map((b) => {
            const s = status[b.id] ?? IDLE
            return (
              <li key={b.id} className={b.id === activeId ? 'on' : ''}>
                <button
                  className="bot-item"
                  onClick={() => {
                    setActiveId(b.id)
                    setShowSidebar(false)
                  }}
                >
                  <Dot color={b.color} status={s} />
                  <span className="bot-text">
                    <span className="bot-name">{b.name}</span>
                    <span className="bot-sub">
                      {s.state === 'working' ? `${s.step}…` : s.state === 'waiting' ? 'Needs your OK' : s.state === 'error' ? 'Error' : b.schedules.some((x) => x.enabled) ? 'Scheduled' : 'Idle'}
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
        <div className="sidebar-foot">
          <button className={`toggle ${settings.privacy ? 'on privacy' : ''}`} onClick={() => update({ privacy: !settings.privacy })} aria-pressed={settings.privacy}>
            Private
          </button>
          <button className="engine" onClick={() => setShowSettings(true)} title="Models and keys">
            <span className={`engine-dot ${engineLabel === 'No model set' ? 'off' : ''}`} />
            <span className="engine-label">{engineLabel}</span>
            <span aria-hidden>⚙</span>
          </button>
        </div>
      </nav>
      <div className="scrim" onClick={() => setShowSidebar(false)} />

      <main>
        <header className="topbar">
          <button className="icon menu" onClick={() => setShowSidebar(true)} aria-label="Open bots">
            ☰
          </button>
          {bot ? (
            <>
              <Dot color={bot.color} status={botStatus} size={12} />
              <div className="title">
                <span className="title-name">{bot.name}</span>
                {bot.goal && <span className="title-goal">{bot.goal}</span>}
              </div>
              <div className="spacer" />
              <button onClick={() => agents.newThread(bot.id)} disabled={busy || !thread?.turns.length}>
                New thread
              </button>
              <button className={showPanel ? 'on-btn' : ''} onClick={() => setShowPanel(!showPanel)}>
                Workspace
              </button>
            </>
          ) : (
            <span className="title-name">New bot</span>
          )}
        </header>

        <div className="scroll" ref={scrollRef}>
          {!ready ? null : bot && thread ? (
            thread.turns.length ? (
              <Timeline turns={thread.turns} status={botStatus} onApprove={(d) => botStatus.state === 'waiting' && botStatus.approval.resolve(d)} />
            ) : (
              <div className="empty">
                <Dot color={bot.color} size={40} />
                <h1>{bot.name} is ready</h1>
                <p>{bot.goal || 'Give it a goal or a task. It will plan, use tools, and report back.'}</p>
                {TEMPLATES.find((t) => t.name === bot.name)?.starter && (
                  <div className="suggestions">
                    <button onClick={() => agents.send(bot.id, TEMPLATES.find((t) => t.name === bot.name)!.starter)}>
                      {TEMPLATES.find((t) => t.name === bot.name)!.starter}
                    </button>
                  </div>
                )}
              </div>
            )
          ) : (
            <Home onCreate={create} needsModel={engineLabel === 'No model set'} onSetup={() => setShowSettings(true)} />
          )}
        </div>

        {bot && (
          <Composer
            busy={busy}
            placeholder={`Give ${bot.name} a task…`}
            onSend={(text) => agents.send(bot.id, text)}
            onStop={() => agents.stop(bot.id)}
          />
        )}
      </main>

      {showPanel && bot && <BotPanel bot={bot} busy={busy} onClose={() => setShowPanel(false)} refreshKey={filesKey} />}
      {showSettings && <SettingsPanel settings={settings} update={update} onClose={() => setShowSettings(false)} />}
    </div>
  )
}

function Home({ onCreate, needsModel, onSetup }: { onCreate: (t: BotTemplate) => void; needsModel: boolean; onSetup: () => void }) {
  return (
    <div className="home">
      <h1>Agents that live in your browser</h1>
      <p className="lede">
        Give a bot a goal. It plans, searches the web, writes files, runs Python, remembers what matters, and works on a schedule. Its computer is a
        private workspace in this browser, and it runs on the model you choose.
      </p>
      {needsModel && (
        <p className="setup-note">
          First, <button className="link" onClick={onSetup}>pick a model</button>: a cloud key (Claude, Grok, OpenAI…), a local Ollama server, or an on-device model.
        </p>
      )}
      <div className="templates">
        {TEMPLATES.map((t) => (
          <button key={t.key} className="template" onClick={() => onCreate(t)}>
            <span className="template-head">
              <span className="dot" style={{ ['--dot' as string]: t.color, width: 14, height: 14 }} />
              <strong>{t.key === 'blank' ? 'Blank bot' : t.name}</strong>
            </span>
            <span className="template-blurb">{t.blurb}</span>
          </button>
        ))}
      </div>
      <ul className="pillars">
        <li>
          <strong>Your browser is the computer.</strong> Files live in private browser storage; Python and JavaScript run in WebAssembly sandboxes.
        </li>
        <li>
          <strong>Any model.</strong> Claude, Grok, OpenAI, Groq, OpenRouter, Ollama, or fully on-device with WebGPU or WASM.
        </li>
        <li>
          <strong>You set the rules.</strong> Every tool can be allowed, need your OK, or be blocked, per bot. Every step is shown.
        </li>
      </ul>
    </div>
  )
}
