import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useSettings, cloudConfigured } from './lib/settings'
import { localEngine, ALL_LOCAL_MODELS } from './lib/providers/local'
import { CLAUDE_MODELS, OPENAI_COMPAT_PRESETS } from './lib/providers/openaiCompat'
import { useLocalStatus } from './hooks/useLocalStatus'
import { useAgents } from './hooks/useAgents'
import { agents } from './agent/manager'
import { TEMPLATES, type BotTemplate } from './agent/templates'
import { Workspace } from './agent/workspace'
import { MOOD_LABEL, avatarFor, moodFor, type Mood } from './agent/avatar'
import type { Bot, BotStatus, Thread } from './agent/types'
import { Composer } from './components/Composer'
import { SettingsPanel } from './components/SettingsPanel'
import { Timeline } from './components/Timeline'
import { BotPanel, type PanelRequest } from './components/BotPanel'
import { BotAvatar } from './components/BotAvatar'

const IDLE: BotStatus = { state: 'idle' }

export default function App() {
  const [settings, update] = useSettings()
  const local = useLocalStatus()
  const { ready, bots, threads, status } = useAgents()
  const [activeId, setActiveId] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showPanel, setShowPanel] = useState(false)
  const [showSidebar, setShowSidebar] = useState(false)
  const [panelRequest, setPanelRequest] = useState<PanelRequest | null>(null)
  const [atBottom, setAtBottom] = useState(true)
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

  // Escape closes the top-most overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (showSettings) setShowSettings(false)
      else if (showSidebar) setShowSidebar(false)
      else if (showPanel) setShowPanel(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showSettings, showSidebar, showPanel])

  const bot = bots.find((b) => b.id === activeId) ?? null
  const thread = bot ? threads[bot.id] : null
  const botStatus = bot ? (status[bot.id] ?? IDLE) : IDLE
  const busy = botStatus.state === 'working' || botStatus.state === 'waiting'
  const mood: Mood = moodFor(botStatus, thread?.turns)

  // Refresh the file list whenever a tool finishes.
  const filesKey = useMemo(() => thread?.turns.filter((t) => t.kind === 'tool_results').length ?? 0, [thread])

  // Follow new output only when the reader is already at the bottom.
  useEffect(() => {
    const el = scrollRef.current
    if (el && atBottom) el.scrollTop = el.scrollHeight
  }, [thread, botStatus, atBottom])

  useEffect(() => {
    requestAnimationFrame(() => {
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    })
  }, [activeId])

  const select = (id: string | null) => {
    setActiveId(id)
    setAtBottom(true)
    setShowSidebar(false)
    setPanelRequest(null)
    // On narrow screens the panel covers the conversation; show the conversation.
    if (matchMedia('(max-width: 1100px)').matches) setShowPanel(false)
  }

  const create = async (t: BotTemplate) => {
    const b = await agents.createBot(t)
    select(b.id)
    if (t.starter) setTimeout(() => agents.send(b.id, t.starter), 50)
  }

  const send = async (text: string, files: File[]) => {
    if (!bot) return
    const ws = new Workspace(bot.id)
    for (const f of files) await ws.write(f.name, f)
    const note = files.length ? `\n\n(Attached to your workspace: ${files.map((f) => f.name).join(', ')})` : ''
    setAtBottom(true)
    agents.send(bot.id, `${text || 'Take a look at the attached files.'}${note}`)
  }

  const openFile = (path: string) => {
    setShowPanel(true)
    setPanelRequest({ tab: 'files', path, nonce: Date.now() })
  }

  const openComputer = () => {
    setShowPanel(true)
    setPanelRequest({ tab: 'computer', nonce: Date.now() })
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
  const noModel = engineLabel === 'No model set'
  const starter = bot ? TEMPLATES.find((t) => t.name === bot.name)?.starter : undefined

  // The open bot's color becomes the accent for the whole view.
  const accent = bot ? ({ '--bot': bot.color } as CSSProperties) : undefined

  return (
    <div className={`app ${showSidebar ? 'sidebar-open' : ''} ${showPanel && bot ? 'panel-open' : ''}`} style={accent}>
      <nav className="sidebar" aria-label="Bots">
        <button className="brand" onClick={() => select(null)}>
          <span className="brand-dots" aria-hidden>
            <i />
            <i />
            <i />
          </span>
          open-bot
        </button>
        <button className="new-chat" onClick={() => select(null)}>
          + New bot
        </button>
        <ul className="bot-list">
          {bots.map((b) => {
            const s = status[b.id] ?? IDLE
            return (
              <li key={b.id} className={`tint ${b.id === activeId ? 'on' : ''}`} style={{ '--bot': b.color } as CSSProperties}>
                <button className="bot-item" onClick={() => select(b.id)} aria-current={b.id === activeId ? 'page' : undefined}>
                  <BotAvatar id={b.id} color={b.color} look={avatarFor(b)} mood={moodFor(s, threads[b.id]?.turns)} size={38} />
                  <span className="bot-text">
                    <span className="bot-name">{b.name}</span>
                    <span className={`bot-sub ${s.state}`}>{botSubtitle(b, s, threads[b.id])}</span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
        <div className="sidebar-foot">
          <button
            className={`toggle ${settings.privacy ? 'on privacy' : ''}`}
            onClick={() => update({ privacy: !settings.privacy })}
            aria-pressed={settings.privacy}
            title="Run every bot on this device only"
          >
            {settings.privacy ? '● Private mode on' : 'Private mode'}
          </button>
          <button className="engine" onClick={() => setShowSettings(true)} title="Models and keys">
            <span className={`engine-dot ${noModel ? 'off' : ''}`} />
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
              <BotAvatar id={bot.id} color={bot.color} look={avatarFor(bot)} mood={mood} size={36} />
              <div className="title">
                <span className="title-line">
                  <span className="title-name">{bot.name}</span>
                  <span className={`mood ${mood}`}>{botStatus.state === 'working' && mood === 'working' ? botStatus.step : MOOD_LABEL[mood]}</span>
                </span>
                {bot.goal && <span className="title-goal">{bot.goal}</span>}
              </div>
              <div className="spacer" />
              <button onClick={() => agents.newThread(bot.id)} disabled={busy || !thread?.turns.length} title="Start fresh; picks up edits to goal, instructions and memory">
                New thread
              </button>
              {bot.computer && (
                <button onClick={openComputer} title="Watch or drive the Linux computer">
                  Computer
                </button>
              )}
              <button className={showPanel ? 'on-btn' : ''} onClick={() => setShowPanel(!showPanel)} aria-pressed={showPanel}>
                Workspace
              </button>
            </>
          ) : (
            <span className="title-name">{bots.length ? 'Home' : 'Welcome'}</span>
          )}
        </header>

        <div
          className="scroll"
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget
            setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80)
          }}
        >
          {!ready ? null : bot && thread ? (
            thread.turns.length ? (
              <Timeline
                botId={bot.id}
                turns={thread.turns}
                status={botStatus}
                onApprove={(d) => botStatus.state === 'waiting' && botStatus.approval.resolve(d)}
                onOpenFile={openFile}
                onOpenSettings={() => setShowSettings(true)}
                avatar={(m, size) => <BotAvatar id={bot.id} color={bot.color} look={avatarFor(bot)} mood={m} size={size} />}
                liveMood={mood}
              />
            ) : (
              <div className="greeting" key={bot.id}>
                <BotAvatar id={bot.id} color={bot.color} look={avatarFor(bot)} mood={mood} size={128} />
                <div className="speech">
                  <h1>Hi, I'm {bot.name}</h1>
                  <p>{bot.goal || 'Give me a goal or a task. I plan, use my tools, and report back.'}</p>
                </div>
                {noModel && (
                  <p className="setup-note">
                    Pick a model first. <button className="link" onClick={() => setShowSettings(true)}>Open settings</button>
                  </p>
                )}
                <div className="suggestions">
                  {(starter ? [starter] : SUGGESTIONS).map((s) => (
                    <button key={s} onClick={() => agents.send(bot.id, s)} disabled={busy}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )
          ) : (
            <Home bots={bots} status={status} threads={threads} onOpen={select} onCreate={create} needsModel={noModel} onSetup={() => setShowSettings(true)} />
          )}
        </div>

        {bot && !atBottom && (
          <button
            className="to-latest"
            onClick={() => {
              setAtBottom(true)
              scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
            }}
          >
            ↓ Latest
          </button>
        )}

        {bot && <Composer busy={busy} placeholder={`Give ${bot.name} a task…`} onSend={send} onStop={() => agents.stop(bot.id)} />}
      </main>

      {showPanel && bot && <BotPanel bot={bot} busy={busy} onClose={() => setShowPanel(false)} refreshKey={filesKey} request={panelRequest} />}
      {showSettings && <SettingsPanel settings={settings} update={update} onClose={() => setShowSettings(false)} />}
    </div>
  )
}

const SUGGESTIONS = [
  'What can you do? Show me with a quick demo in your workspace.',
  'Use the shell to make a small SQLite database of 5 books and query it.',
  'Research a topic I care about: ask me which one first.',
]

function botSubtitle(b: Bot, s: BotStatus, t?: Thread) {
  if (s.state === 'working') return `${s.step}…`
  if (s.state === 'waiting') return 'Needs your OK'
  if (s.state === 'error') return 'Error'
  if (s.done) return 'Done!'
  const next = b.schedules.filter((x) => x.enabled).sort((x, y) => x.nextRunAt - y.nextRunAt)[0]
  if (next) return `Next run ${relTime(next.nextRunAt)}`
  return t?.turns.length ? `Active ${relTime(t.updatedAt)}` : 'Not started'
}

function relTime(at: number) {
  const diff = at - Date.now()
  const abs = Math.abs(diff)
  const fmt = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (abs < 60_000) return fmt.format(Math.round(diff / 1000), 'second')
  if (abs < 3_600_000) return fmt.format(Math.round(diff / 60_000), 'minute')
  if (abs < 86_400_000) return fmt.format(Math.round(diff / 3_600_000), 'hour')
  return fmt.format(Math.round(diff / 86_400_000), 'day')
}

function Home({ bots, status, threads, onOpen, onCreate, needsModel, onSetup }: {
  bots: Bot[]
  status: Record<string, BotStatus>
  threads: Record<string, Thread>
  onOpen: (id: string) => void
  onCreate: (t: BotTemplate) => void
  needsModel: boolean
  onSetup: () => void
}) {
  return (
    <div className="home">
      <section className="hero">
        <div className="hero-crew" aria-hidden>
          {TEMPLATES.map((t, i) => (
            <BotAvatar key={t.key} id={`hero-${t.key}`} color={t.color} look={t.avatar} mood={i === 2 ? 'thinking' : 'idle'} size={i === 2 ? 74 : 58} />
          ))}
        </div>
        <h1>{bots.length ? 'Your crew is ready.' : 'Agents that live in your browser'}</h1>
        <p className="lede">
          Give a bot a goal. It plans, searches the web, runs a real shell, Python and a whole Linux desktop, writes files, remembers what matters, and
          works on a schedule. Its computer is a private sandbox in this tab, and it runs on the model you choose.
        </p>
      </section>

      {needsModel && (
        <p className="setup-note">
          First, <button className="link" onClick={onSetup}>pick a model</button>: a cloud key (Claude, Grok, NVIDIA, OpenAI…), a local Ollama server, or an
          on-device model.
        </p>
      )}

      {bots.length > 0 && (
        <>
          <h2 className="home-h">Your bots</h2>
          <div className="bot-cards">
            {bots.map((b) => {
              const s = status[b.id] ?? IDLE
              return (
                <button key={b.id} className="bot-card tint" onClick={() => onOpen(b.id)} style={{ '--bot': b.color } as CSSProperties}>
                  <span className="card-head">
                    <BotAvatar id={b.id} color={b.color} look={avatarFor(b)} mood={moodFor(s, threads[b.id]?.turns)} size={48} />
                    <strong>{b.name}</strong>
                  </span>
                  <span className="template-blurb">{b.goal || 'No goal set'}</span>
                  <span className={`bot-sub ${s.state}`}>{botSubtitle(b, s, threads[b.id])}</span>
                </button>
              )
            })}
          </div>
        </>
      )}

      <h2 className="home-h">{bots.length ? 'Hire another' : 'Pick your first bot'}</h2>
      <div className="templates">
        {TEMPLATES.map((t) => (
          <button key={t.key} className="template tint" onClick={() => onCreate(t)} style={{ '--bot': t.color } as CSSProperties}>
            <span className="card-head">
              <BotAvatar id={`tpl-${t.key}`} color={t.color} look={t.avatar} size={48} />
              <strong>{t.key === 'blank' ? 'Blank bot' : t.name}</strong>
            </span>
            <span className="template-blurb">{t.blurb}</span>
          </button>
        ))}
      </div>

      {bots.length === 0 && (
        <ul className="pillars">
          <li>
            <strong>Your browser is the computer.</strong> A real Unix shell, Python, Node and a Linux desktop compiled to WebAssembly, with files in private
            browser storage.
          </li>
          <li>
            <strong>Any model.</strong> Claude, Grok, NVIDIA, OpenAI, Groq, OpenRouter, Ollama, or fully on-device with WebGPU or WASM.
          </li>
          <li>
            <strong>You set the rules.</strong> Every tool can be allowed, need your OK, or be blocked, per bot. Every step is shown.
          </li>
        </ul>
      )}
    </div>
  )
}
