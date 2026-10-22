import { useCallback, useEffect, useRef, useState } from 'react'
import type { Bot, Engine, Rule, Schedule } from '../agent/types'
import { agents } from '../agent/manager'
import { TOOLS, ruleFor } from '../agent/tools'
import { Workspace, formatBytes, isTextFile, type FileInfo } from '../agent/workspace'
import { computeNextRun, describeSchedule } from '../agent/scheduler'
import { BOT_COLORS } from '../agent/templates'

type Tab = 'setup' | 'files' | 'memory' | 'schedules' | 'rules'

export function BotPanel({ bot, busy, onClose, refreshKey }: { bot: Bot; busy: boolean; onClose: () => void; refreshKey: number }) {
  const [tab, setTab] = useState<Tab>('files')
  const update = (fn: (b: Bot) => Bot) => agents.updateBot(bot.id, fn)

  return (
    <aside className="panel" aria-label={`${bot.name} details`}>
      <header>
        <div className="tabs" role="tablist">
          {(['files', 'memory', 'schedules', 'rules', 'setup'] as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
              {t[0].toUpperCase() + t.slice(1)}
              {t === 'memory' && bot.memory.length > 0 && <span className="count">{bot.memory.length}</span>}
              {t === 'schedules' && bot.schedules.length > 0 && <span className="count">{bot.schedules.length}</span>}
            </button>
          ))}
        </div>
        <button className="icon" onClick={onClose} aria-label="Close panel">
          ✕
        </button>
      </header>
      <div className="panel-body">
        {tab === 'files' && <FilesTab botId={bot.id} refreshKey={refreshKey} />}
        {tab === 'memory' && <MemoryTab bot={bot} update={update} />}
        {tab === 'schedules' && <SchedulesTab bot={bot} update={update} />}
        {tab === 'rules' && <RulesTab bot={bot} update={update} />}
        {tab === 'setup' && <SetupTab bot={bot} update={update} busy={busy} />}
      </div>
    </aside>
  )
}

function FilesTab({ botId, refreshKey }: { botId: string; refreshKey: number }) {
  const ws = useRef(new Workspace(botId)).current
  const [files, setFiles] = useState<FileInfo[]>([])
  const [open, setOpen] = useState<{ path: string; text?: string; url?: string } | null>(null)
  const [drag, setDrag] = useState(false)

  const refresh = useCallback(() => ws.list().then(setFiles).catch(() => setFiles([])), [ws])
  useEffect(() => {
    refresh()
  }, [refresh, refreshKey])

  const upload = async (list: FileList | null) => {
    if (!list) return
    for (const f of Array.from(list)) await ws.write(f.name, f)
    refresh()
  }

  const view = async (path: string) => {
    if (open?.url) URL.revokeObjectURL(open.url)
    if (isTextFile(path)) setOpen({ path, text: await ws.readText(path) })
    else if (/\.(png|jpe?g|gif|webp|svg)$/i.test(path)) setOpen({ path, url: URL.createObjectURL(await ws.readBlob(path)) })
    else setOpen({ path, text: '(binary file; download it to open)' })
  }

  const download = async (path: string) => {
    const url = URL.createObjectURL(await ws.readBlob(path))
    const a = document.createElement('a')
    a.href = url
    a.download = path.split('/').pop()!
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <div
      className={`files ${drag ? 'drag' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDrag(true)
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDrag(false)
        upload(e.dataTransfer.files)
      }}
    >
      <p className="hint">The bot's private folder, stored in this browser. Drop files here to give them to the bot.</p>
      <label className="upload">
        <input type="file" multiple onChange={(e) => upload(e.target.files)} />
        Upload files
      </label>
      {files.length === 0 ? (
        <p className="empty-note">No files yet.</p>
      ) : (
        <ul className="file-list">
          {files.map((f) => (
            <li key={f.path} className={open?.path === f.path ? 'on' : ''}>
              <button className="file-name" onClick={() => view(f.path)}>
                {f.path}
              </button>
              <span className="file-size">{formatBytes(f.size)}</span>
              <button className="icon" onClick={() => download(f.path)} aria-label={`Download ${f.path}`}>
                ⇣
              </button>
              <button
                className="icon"
                onClick={async () => {
                  await ws.remove(f.path)
                  if (open?.path === f.path) setOpen(null)
                  refresh()
                }}
                aria-label={`Delete ${f.path}`}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && (
        <div className="preview">
          <div className="preview-head">{open.path}</div>
          {open.url ? <img src={open.url} alt={open.path} /> : <pre>{open.text}</pre>}
        </div>
      )}
    </div>
  )
}

function MemoryTab({ bot, update }: { bot: Bot; update: (fn: (b: Bot) => Bot) => void }) {
  const [text, setText] = useState('')
  return (
    <div className="stack">
      <p className="hint">Facts the bot keeps across threads. It adds to this with its remember tool, and you can edit it too.</p>
      {bot.memory.length === 0 && <p className="empty-note">Nothing remembered yet.</p>}
      <ul className="mem-list">
        {bot.memory.map((m) => (
          <li key={m.id}>
            <span>{m.text}</span>
            <button className="icon" onClick={() => update((b) => ({ ...b, memory: b.memory.filter((x) => x.id !== m.id) }))} aria-label="Forget">
              ✕
            </button>
          </li>
        ))}
      </ul>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault()
          const t = text.trim()
          if (!t) return
          update((b) => ({ ...b, memory: [...b.memory, { id: crypto.randomUUID(), text: t, at: Date.now() }] }))
          setText('')
        }}
      >
        <input className="field" value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a fact, e.g. I prefer short answers" />
        <button type="submit">Add</button>
      </form>
      <p className="hint">Memory changes reach the bot when you start a new thread.</p>
    </div>
  )
}

function SchedulesTab({ bot, update }: { bot: Bot; update: (fn: (b: Bot) => Bot) => void }) {
  const [task, setTask] = useState('')
  const [mode, setMode] = useState<'daily' | 'every'>('daily')
  const [at, setAt] = useState('08:00')
  const [every, setEvery] = useState(60)

  const add = () => {
    if (!task.trim()) return
    const s: Schedule = {
      id: crypto.randomUUID().slice(0, 8),
      task: task.trim(),
      everyMinutes: mode === 'every' ? Math.max(5, every) : 0,
      dailyAt: mode === 'daily' ? at : undefined,
      nextRunAt: 0,
      enabled: true,
    }
    s.nextRunAt = computeNextRun(s, Date.now())
    update((b) => ({ ...b, schedules: [...b.schedules, s] }))
    setTask('')
  }

  return (
    <div className="stack">
      <p className="hint">Runs happen while open-bot is open in a tab (keep it pinned). Runs missed while closed happen when you reopen it.</p>
      {bot.schedules.length === 0 && <p className="empty-note">No schedules. Ask the bot to schedule itself, or add one here.</p>}
      <ul className="sched-list">
        {bot.schedules.map((s) => (
          <li key={s.id}>
            <label className="check">
              <input
                type="checkbox"
                checked={s.enabled}
                onChange={(e) =>
                  update((b) => ({
                    ...b,
                    schedules: b.schedules.map((x) => (x.id === s.id ? { ...x, enabled: e.target.checked, nextRunAt: computeNextRun(x, Date.now()) } : x)),
                  }))
                }
              />
              <span>
                <strong>{describeSchedule(s)}</strong>
                <span className="sched-task">{s.task}</span>
                <span className="hint">
                  Next: {new Date(s.nextRunAt).toLocaleString()}
                  {s.lastRunAt ? ` · last: ${new Date(s.lastRunAt).toLocaleString()}` : ''}
                </span>
              </span>
            </label>
            <button
              className="icon"
              onClick={() => update((b) => ({ ...b, schedules: b.schedules.filter((x) => x.id !== s.id) }))}
              aria-label="Delete schedule"
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
      <div className="sched-form">
        <textarea className="field" rows={2} value={task} onChange={(e) => setTask(e.target.value)} placeholder="Task, e.g. Check the news on WebGPU and update briefing.md" />
        <div className="row">
          <select className="field" value={mode} onChange={(e) => setMode(e.target.value as 'daily' | 'every')}>
            <option value="daily">Daily at</option>
            <option value="every">Every (minutes)</option>
          </select>
          {mode === 'daily' ? (
            <input className="field" type="time" value={at} onChange={(e) => setAt(e.target.value)} />
          ) : (
            <input className="field" type="number" min={5} value={every} onChange={(e) => setEvery(Number(e.target.value))} />
          )}
          <button onClick={add} disabled={!task.trim()}>
            Add
          </button>
        </div>
      </div>
    </div>
  )
}

function RulesTab({ bot, update }: { bot: Bot; update: (fn: (b: Bot) => Bot) => void }) {
  return (
    <div className="stack">
      <p className="hint">Choose what this bot may do on its own, what needs your OK, and what it may never do.</p>
      <table className="rules">
        <tbody>
          {TOOLS.map((t) => {
            const rule = ruleFor(bot.rules, t)
            return (
              <tr key={t.name}>
                <td>
                  <strong>{t.label}</strong>
                  <span className="hint">{t.name}</span>
                </td>
                <td>
                  <div className="seg small">
                    {(['allow', 'ask', 'block'] as Rule[]).map((r) => (
                      <button key={r} className={rule === r ? `on rule-${r}` : ''} onClick={() => update((b) => ({ ...b, rules: { ...b.rules, [t.name]: r } }))}>
                        {r[0].toUpperCase() + r.slice(1)}
                      </button>
                    ))}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="hint">Claude bots search and read the web on Anthropic's servers; the Search and Read rules apply to other providers.</p>
    </div>
  )
}

function SetupTab({ bot, update, busy }: { bot: Bot; update: (fn: (b: Bot) => Bot) => void; busy: boolean }) {
  const [confirm, setConfirm] = useState(false)
  return (
    <div className="stack">
      <label className="lbl">
        Name
        <input className="field" value={bot.name} onChange={(e) => update((b) => ({ ...b, name: e.target.value }))} />
      </label>
      <div className="lbl">
        Color
        <div className="colors">
          {BOT_COLORS.map((c) => (
            <button
              key={c}
              className={`swatch ${bot.color === c ? 'on' : ''}`}
              style={{ background: c }}
              onClick={() => update((b) => ({ ...b, color: c }))}
              aria-label={`Color ${c}`}
            />
          ))}
        </div>
      </div>
      <label className="lbl">
        Goal
        <textarea className="field" rows={3} value={bot.goal} onChange={(e) => update((b) => ({ ...b, goal: e.target.value }))} placeholder="What should this bot work toward?" />
      </label>
      <label className="lbl">
        Instructions
        <textarea className="field" rows={5} value={bot.instructions} onChange={(e) => update((b) => ({ ...b, instructions: e.target.value }))} placeholder="How it should work, tone, things to avoid…" />
      </label>
      <div className="lbl">
        Runs on
        <div className="seg">
          {(['auto', 'cloud', 'local'] as Engine[]).map((e) => (
            <button key={e} className={bot.engine === e ? 'on' : ''} onClick={() => update((b) => ({ ...b, engine: e }))}>
              {e === 'auto' ? 'Auto' : e === 'cloud' ? 'Cloud' : 'On-device'}
            </button>
          ))}
        </div>
        <span className="hint">Auto uses your cloud model when one is set, otherwise the on-device model.</span>
      </div>
      <p className="hint">Changes to the goal and instructions apply from the bot's next thread.</p>
      <div className="row">
        <button onClick={() => agents.newThread(bot.id)} disabled={busy}>
          Start a new thread
        </button>
        {confirm ? (
          <button className="danger" onClick={() => agents.deleteBot(bot.id)}>
            Delete bot and its files
          </button>
        ) : (
          <button className="danger-quiet" onClick={() => setConfirm(true)}>
            Delete bot…
          </button>
        )}
      </div>
    </div>
  )
}
