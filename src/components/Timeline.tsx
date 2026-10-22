import { useEffect, useState, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { BotStatus, ServerStep, ToolResult, Turn } from '../agent/types'
import { TOOL_BY_NAME } from '../agent/tools'
import { Workspace } from '../agent/workspace'
import { describeComputerAction } from '../computer/actions'
import type { Mood } from '../agent/avatar'

type UserTurn = Extract<Turn, { kind: 'user' }>
type AssistantTurn = Extract<Turn, { kind: 'assistant' }>

/** One task: what you asked, everything the bot did, and how it ended. */
interface Run {
  user: UserTurn | null
  steps: AssistantTurn[]
  results: Map<string, ToolResult>
  end: number
}

function groupRuns(turns: Turn[]): Run[] {
  const runs: Run[] = []
  let cur: Run | null = null
  for (const t of turns) {
    if (t.kind === 'user' || !cur) {
      cur = { user: t.kind === 'user' ? t : null, steps: [], results: new Map(), end: t.at }
      runs.push(cur)
      if (t.kind === 'user') continue
    }
    cur.end = t.at
    if (t.kind === 'assistant') cur.steps.push(t)
    else if (t.kind === 'tool_results') for (const r of t.results) cur.results.set(r.callId, r)
  }
  return runs
}

export interface TimelineProps {
  botId: string
  turns: Turn[]
  status: BotStatus
  onApprove: (d: 'once' | 'always' | 'deny') => void
  onOpenFile: (path: string) => void
  onOpenSettings: () => void
  /** Renders the bot's avatar in a given mood and size. */
  avatar: (mood: Mood, size: number) => ReactNode
  /** The bot's mood right now, for the run in progress. */
  liveMood: Mood
}

export function Timeline(props: TimelineProps) {
  const runs = groupRuns(props.turns)
  return (
    <div className="thread">
      {runs.map((run, i) => (
        <RunView key={run.user?.id ?? run.steps[0]?.id ?? i} run={run} live={i === runs.length - 1} {...props} />
      ))}
    </div>
  )
}

function RunView({ run, live: isLast, botId, status, onApprove, onOpenFile, onOpenSettings, avatar, liveMood }: TimelineProps & { run: Run; live: boolean }) {
  const working = isLast && (status.state === 'working' || status.state === 'waiting')
  const last = run.steps[run.steps.length - 1]
  // The final answer is the last step's text once the bot stops calling tools.
  const finished = !working && last && last.stop !== 'tools'
  const answer = finished ? last : null
  const activity = answer ? run.steps.slice(0, -1) : run.steps
  const toolCount = run.steps.reduce((n, s) => n + s.toolCalls.length + (s.serverSteps?.length ?? 0), 0)
  const files = [...new Set([...run.results.values()].flatMap((r) => r.files ?? []))]
  const failed = [...run.results.values()].filter((r) => r.isError).length
  const started = run.user?.at ?? run.steps[0]?.at ?? run.end
  const showActivity = working || toolCount > 0 || activity.some((s) => s.text.trim() || s.thinking?.trim())

  return (
    <section className="run">
      {run.user && (
        <div className="msg user">
          {run.user.source === 'schedule' && <div className="tag">Scheduled run</div>}
          <div className="bubble" title={new Date(run.user.at).toLocaleString()}>
            {run.user.text}
          </div>
        </div>
      )}

      {(showActivity || answer) && (
        <div className="bot-turn">
          {avatar(isLast ? liveMood : answer?.stop === 'error' ? 'error' : 'idle', 34)}
          <div className="bot-turn-body">
            {showActivity && (
              <details className={`activity ${working ? 'live' : ''}`} open={working || undefined}>
                <summary>
                  <span className={`activity-icon ${working ? 'spin' : failed && !answer ? 'bad' : 'ok'}`} aria-hidden />
                  <span className="activity-title">
                    {working
                      ? status.state === 'waiting'
                        ? 'Waiting for your OK'
                        : `${status.state === 'working' ? status.step : 'Working'}…`
                      : `Worked for ${duration(run.end - started)}`}
                  </span>
                  <span className="activity-meta">
                    {toolCount > 0 && `${toolCount} step${toolCount === 1 ? '' : 's'}`}
                    {files.length > 0 && ` · ${files.length} file${files.length === 1 ? '' : 's'}`}
                    {failed > 0 && ` · ${failed} failed`}
                  </span>
                </summary>
                <ol className="activity-steps">
                  {activity.map((s) => (
                    <StepGroup key={s.id} step={s} results={run.results} working={working} />
                  ))}
                </ol>
                {working && status.state === 'waiting' && (
                  <Approval status={status} onApprove={onApprove} />
                )}
                {working && <LiveScreen results={run.results} />}
              </details>
            )}

            {answer && (
              <div className="msg assistant">
                {answer.text && <MarkdownBlock text={answer.text} />}
                {answer.stop === 'error' && <ErrorNote text={answer.error ?? 'Something went wrong.'} onOpenSettings={answer.provider === 'open-bot' ? onOpenSettings : undefined} />}
                {answer.stop === 'stopped' && <div className="note">Stopped. Send a message to continue.</div>}
                {answer.stop === 'refusal' && <div className="note">The model declined this request.</div>}
                {answer.stop === 'max_tokens' && <div className="note">The reply hit the length limit.</div>}
                {files.length > 0 && <FileChips botId={botId} files={files} onOpen={onOpenFile} />}
                {answer.model && (
                  <div className="meta">
                    <span className={`badge ${answer.provider.startsWith('On-device') || answer.provider.startsWith('Ollama') ? 'local' : 'cloud'}`}>{answer.provider}</span>
                    <span>{answer.model}</span>
                    {answer.text && <CopyButton text={answer.text} label="Copy answer" />}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

/** One model turn inside the activity log: its narration, reasoning, and tool calls. */
function StepGroup({ step, results, working }: { step: AssistantTurn; results: Map<string, ToolResult>; working: boolean }) {
  return (
    <>
      {step.thinking?.trim() && (
        <li className="act-reasoning">
          <details>
            <summary>Reasoning</summary>
            <div className="thinking-body">{step.thinking.trim()}</div>
          </details>
        </li>
      )}
      {step.text.trim() && <li className="act-narration">{step.text.trim()}</li>}
      {step.serverSteps?.map((s) => <ServerStepView key={s.id} step={s} />)}
      {step.toolCalls.map((c) => (
        <ToolStep key={c.id} name={c.name} input={c.input} toolset={c.toolset} result={results.get(c.id)} running={working && !results.has(c.id)} />
      ))}
      {step.stop === 'error' && step.error && <li className="act-error">{step.error}</li>}
    </>
  )
}

function ServerStepView({ step }: { step: ServerStep }) {
  const search = step.name === 'web_search'
  return (
    <li className="step done">
      <div className="step-row">
        <span className="step-icon" aria-hidden>
          {search ? '⌕' : '⇣'}
        </span>
        <span className="step-name">{search ? 'Searched the web' : 'Read a page'}</span>
        <span className="step-detail">{String(step.input.query ?? step.input.url ?? '')}</span>
        {step.summary && <span className="step-status">{step.summary}</span>}
      </div>
    </li>
  )
}

const ICONS: Record<string, string> = { read: '▤', write: '✎', execute: '▶', network: '⌕', notify: '◉', computer: '▣' }

function ToolStep({ name, input, toolset, result, running }: {
  name: string
  input: Record<string, unknown>
  toolset?: 'computer'
  result?: ToolResult
  running: boolean
}) {
  const computerAction = toolset === 'computer'
  const tool = computerAction ? TOOL_BY_NAME.get('computer') : TOOL_BY_NAME.get(name)
  const state = result ? (result.decision === 'denied' || result.decision === 'blocked' ? 'denied' : result.isError ? 'failed' : 'done') : running ? 'running' : 'skipped'
  const command = typeof input.command === 'string' ? input.command : null
  const code = typeof input.code === 'string' ? input.code : null
  const detail = computerAction ? describeComputerAction(name, input) : command ?? (code ? firstLine(code) : summarizeInput(input))
  return (
    <li className={`step ${state}`}>
      <details>
        <summary className="step-row">
          <span className="step-icon" aria-hidden>
            {ICONS[tool?.risk ?? 'read']}
          </span>
          <span className="step-name">{computerAction ? 'Computer' : (tool?.label ?? name)}</span>
          <span className="step-detail">{detail}</span>
          <span className="step-status">
            {state === 'running' ? 'running…' : state === 'denied' ? (result?.decision === 'blocked' ? 'blocked' : 'denied') : state}
            {result?.decision === 'approved' && ' · approved'}
            {result?.ms !== undefined && result.ms > 900 && ` · ${duration(result.ms)}`}
          </span>
        </summary>
        <div className="step-body">
          {command ? (
            <pre className="term">
              <span className="prompt">$ </span>
              {command}
              {input.packages ? <span className="term-dim">{`\n# packages: ${String(input.packages)}`}</span> : null}
            </pre>
          ) : code ? (
            <CodeBlock code={code} />
          ) : (
            Object.keys(input).length > 0 && <pre className="code">{formatInput(input)}</pre>
          )}
          {result?.image ? (
            <img className="step-shot" src={`data:${result.image.mediaType};base64,${result.image.data}`} alt="Screenshot from the computer" />
          ) : (
            result && <pre className={`output ${result.isError ? 'err' : ''} ${command ? 'term' : ''}`}>{result.output}</pre>
          )}
        </div>
      </details>
    </li>
  )
}

/** While a bot works, the most recent screenshot it took, so you can follow along. */
function LiveScreen({ results }: { results: Map<string, ToolResult> }) {
  const shot = [...results.values()].reverse().find((r) => r.image)?.image
  if (!shot) return null
  return (
    <div className="live-shot">
      <img src={`data:${shot.mediaType};base64,${shot.data}`} alt="What the bot last saw on its computer" />
    </div>
  )
}

const RISK_NOTES: Record<string, string> = {
  read: 'It only reads.',
  write: 'This changes the bot’s files, memory or schedules.',
  execute: 'This runs code in a WebAssembly sandbox in this tab.',
  network: 'This contacts websites through the proxy.',
  notify: 'This shows you a desktop notification.',
  computer: 'This acts on the shared Linux computer (no internet access).',
}

function Approval({ status, onApprove }: { status: Extract<BotStatus, { state: 'waiting' }>; onApprove: (d: 'once' | 'always' | 'deny') => void }) {
  const { tool, call } = status.approval
  return (
    <div className="approval" role="alertdialog" aria-label={`${tool.label} needs your OK`}>
      <div className="approval-head">
        <strong>{tool.label}</strong> needs your OK
        <span className="hint">{RISK_NOTES[tool.risk]}</span>
      </div>
      <pre className="approval-input">{call.toolset === 'computer' ? describeComputerAction(call.name, call.input) : formatInput(call.input)}</pre>
      <div className="row">
        <button className="primary" autoFocus onClick={() => onApprove('once')}>
          Allow once
        </button>
        <button onClick={() => onApprove('always')}>Always allow</button>
        <button className="danger-quiet" onClick={() => onApprove('deny')}>
          Deny
        </button>
      </div>
    </div>
  )
}

function ErrorNote({ text, onOpenSettings }: { text: string; onOpenSettings?: () => void }) {
  return (
    <div className="error-card">
      <span>{text}</span>
      {onOpenSettings && (
        <button className="primary" onClick={onOpenSettings}>
          Set up a model
        </button>
      )}
    </div>
  )
}

const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i

function FileChips({ botId, files, onOpen }: { botId: string; files: string[]; onOpen: (path: string) => void }) {
  const images = files.filter((f) => IMAGE.test(f)).slice(0, 4)
  return (
    <div className="files-out">
      {images.length > 0 && (
        <div className="thumbs">
          {images.map((f) => (
            <Thumb key={f} botId={botId} path={f} onOpen={onOpen} />
          ))}
        </div>
      )}
      <div className="chips">
        {files.map((f) => (
          <button key={f} className="chip" onClick={() => onOpen(f)} title={`Open ${f}`}>
            <span aria-hidden>{IMAGE.test(f) ? '▧' : '▤'}</span> {f}
          </button>
        ))}
      </div>
    </div>
  )
}

function Thumb({ botId, path, onOpen }: { botId: string; path: string; onOpen: (path: string) => void }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let u: string | null = null
    new Workspace(botId)
      .readBlob(path)
      .then((b) => setUrl((u = URL.createObjectURL(b))))
      .catch(() => setUrl(null))
    return () => {
      if (u) URL.revokeObjectURL(u)
    }
  }, [botId, path])
  if (!url) return null
  return (
    <button className="thumb" onClick={() => onOpen(path)} aria-label={`Open ${path}`}>
      <img src={url} alt={path} />
    </button>
  )
}

function MarkdownBlock({ text }: { text: string }) {
  return (
    <div className="md">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => <PreWithCopy>{children}</PreWithCopy>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  )
}

function PreWithCopy({ children }: { children: ReactNode }) {
  const [el, setEl] = useState<HTMLPreElement | null>(null)
  return (
    <div className="pre-wrap">
      <pre ref={setEl}>{children}</pre>
      <CopyButton text={() => el?.innerText ?? ''} label="Copy code" floating />
    </div>
  )
}

function CodeBlock({ code }: { code: string }) {
  return (
    <div className="pre-wrap">
      <pre className="code">{code}</pre>
      <CopyButton text={code} label="Copy code" floating />
    </div>
  )
}

export function CopyButton({ text, label, floating }: { text: string | (() => string); label: string; floating?: boolean }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className={`copy ${floating ? 'floating' : ''}`}
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(typeof text === 'function' ? text() : text)
          setDone(true)
          setTimeout(() => setDone(false), 1400)
        } catch {
          // Clipboard blocked; nothing useful to do.
        }
      }}
    >
      {done ? 'Copied' : 'Copy'}
    </button>
  )
}

function duration(ms: number) {
  const s = Math.max(1, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

function firstLine(code: string) {
  const line = code.split('\n').find((l) => l.trim() && !l.trim().startsWith('#')) ?? ''
  return line.trim().slice(0, 90)
}

function summarizeInput(input: Record<string, unknown>) {
  const v = input.path ?? input.url ?? input.query ?? input.note ?? input.task ?? input.title ?? input.schedule_id
  return typeof v === 'string' ? v.slice(0, 90) : ''
}

function formatInput(input: Record<string, unknown>) {
  return Object.entries(input)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n')
}
