import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { BotStatus, ToolResult, Turn } from '../agent/types'
import { TOOL_BY_NAME } from '../agent/tools'

/**
 * The thread as an activity log: what you asked, what the bot said, and every
 * tool it ran with inputs and results.
 */
export function Timeline({ turns, status, onApprove }: {
  turns: Turn[]
  status: BotStatus
  onApprove: (d: 'once' | 'always' | 'deny') => void
}) {
  const results = new Map<string, ToolResult>()
  for (const t of turns) if (t.kind === 'tool_results') for (const r of t.results) results.set(r.callId, r)
  const working = status.state === 'working' || status.state === 'waiting'
  const lastId = turns[turns.length - 1]?.id

  return (
    <div className="thread">
      {turns.map((t) => {
        if (t.kind === 'tool_results') return null
        if (t.kind === 'user') {
          return (
            <div key={t.id} className="msg user">
              {t.source === 'schedule' && <div className="tag">Scheduled run</div>}
              <div className="bubble">{t.text}</div>
            </div>
          )
        }
        const live = working && t.id === lastId
        return (
          <div key={t.id} className="msg assistant">
            {t.thinking?.trim() && (
              <details className="thinking" open={live && !t.text}>
                <summary>{live && !t.text ? 'Thinking…' : 'Reasoning'}</summary>
                <div className="thinking-body">{t.thinking.trim()}</div>
              </details>
            )}
            {t.serverSteps?.map((s) => (
              <div key={s.id} className="step server">
                <span className="step-icon">{s.name === 'web_search' ? '⌕' : '⇣'}</span>
                <span className="step-name">{s.name === 'web_search' ? 'Searched the web' : 'Read a page'}</span>
                <span className="step-detail">{String(s.input.query ?? s.input.url ?? '')}</span>
                {s.summary && <span className="step-status">{s.summary}</span>}
              </div>
            ))}
            {t.text && (
              <div className="md">
                <Markdown remarkPlugins={[remarkGfm]}>{t.text}</Markdown>
              </div>
            )}
            {t.toolCalls.map((c) => (
              <ToolStep key={c.id} name={c.name} input={c.input} result={results.get(c.id)} running={live || (working && !results.has(c.id))} />
            ))}
            {t.error && <div className="error">{t.error}</div>}
            {t.stop === 'stopped' && <div className="meta">Stopped</div>}
            {t.stop === 'refusal' && <div className="meta">The model declined this request.</div>}
            {t.stop === 'max_tokens' && <div className="meta">Reply cut off at the length limit.</div>}
            {!live && t.model && (t.text || t.toolCalls.length > 0) && t.stop !== 'tools' && (
              <div className="meta">
                <span className={`badge ${t.provider.startsWith('On-device') || t.provider.startsWith('Ollama') ? 'local' : 'cloud'}`}>{t.provider}</span>
                <span>{t.model}</span>
              </div>
            )}
          </div>
        )
      })}

      {status.state === 'waiting' && (
        <div className="approval">
          <div className="approval-head">
            <strong>{status.approval.tool.label}</strong> needs your OK
          </div>
          <pre className="approval-input">{formatInput(status.approval.call.input)}</pre>
          <div className="row">
            <button className="primary" onClick={() => onApprove('once')}>
              Allow once
            </button>
            <button onClick={() => onApprove('always')}>Always allow</button>
            <button className="danger" onClick={() => onApprove('deny')}>
              Deny
            </button>
          </div>
        </div>
      )}
      {status.state === 'working' && (
        <div className="working">
          <span className="spinner" /> {status.step}…
        </div>
      )}
    </div>
  )
}

function ToolStep({ name, input, result, running }: {
  name: string
  input: Record<string, unknown>
  result?: ToolResult
  running: boolean
}) {
  const tool = TOOL_BY_NAME.get(name)
  const code = typeof input.code === 'string' ? input.code : null
  const detail = code ? null : summarizeInput(input)
  const state = result ? (result.isError ? 'failed' : 'done') : running ? 'running' : 'skipped'
  return (
    <details className={`step tool ${state}`}>
      <summary>
        <span className="step-icon">{ICONS[tool?.risk ?? 'read']}</span>
        <span className="step-name">{tool?.label ?? name}</span>
        {detail && <span className="step-detail">{detail}</span>}
        <span className="step-status">
          {result?.decision === 'approved' && 'approved · '}
          {result?.decision === 'denied' ? 'denied' : result?.decision === 'blocked' ? 'blocked' : state === 'running' ? 'running…' : state}
        </span>
      </summary>
      {code && <pre className="code">{code}</pre>}
      {!code && Object.keys(input).length > 0 && <pre className="code">{formatInput(input)}</pre>}
      {result && <pre className={`output ${result.isError ? 'err' : ''}`}>{result.output}</pre>}
    </details>
  )
}

const ICONS: Record<string, string> = { read: '▤', write: '✎', execute: '▶', network: '⌕', notify: '◉' }

function summarizeInput(input: Record<string, unknown>) {
  const v = input.path ?? input.url ?? input.query ?? input.note ?? input.task ?? input.title
  return typeof v === 'string' ? v.slice(0, 90) : ''
}

function formatInput(input: Record<string, unknown>) {
  return Object.entries(input)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n')
}
