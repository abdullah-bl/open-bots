import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type { ServerStep, ToolCall, ToolDef, Turn } from './types'
import { ThinkTagSplitter, localEngine } from '../lib/providers/local'
import { cloudConfigured, type Settings } from '../lib/settings'
import { OPENAI_COMPAT_PRESETS, usesServer } from '../lib/providers/openaiCompat'

export interface StepRequest {
  system: string
  turns: Turn[]
  tools: ToolDef[]
  /** Give the model the shared Linux computer. */
  computer: boolean
  signal: AbortSignal
  onText: (delta: string) => void
  onThinking: (delta: string) => void
  onServerStep: (step: ServerStep) => void
  /** A tool call has started streaming; its input is still being written. */
  onToolCallStart: (name: string) => void
}

export interface StepResult {
  text: string
  thinking: string
  toolCalls: ToolCall[]
  serverSteps: ServerStep[]
  raw?: unknown[]
  stop: 'done' | 'tools' | 'pause' | 'refusal' | 'max_tokens'
}

/** One model turn: stream a reply, return its text and any tool calls. */
export interface AgentModel {
  provider: string
  model: string
  local: boolean
  /** Claude searches and fetches the web server-side, so the client web tools are swapped out. */
  serverWeb: boolean
  /** Whether this engine can call tools at all. */
  tools: boolean
  /** Claude drives the computer with its own toolset rather than our computer_* tools. */
  nativeComputer: boolean
  step(req: StepRequest): Promise<StepResult>
}

export function pickModel(engine: 'auto' | 'cloud' | 'local', s: Settings): AgentModel | string {
  const wantLocal = s.privacy || engine === 'local' || (engine === 'auto' && !cloudConfigured(s))
  if (wantLocal) {
    const local = localAgentModel()
    if (local) return local
    return s.privacy
      ? 'Private mode is on: load an on-device model in Settings.'
      : 'No model available. Add a cloud provider or load an on-device model in Settings.'
  }
  if (!cloudConfigured(s)) return 'Add a cloud provider in Settings (or switch this bot to on-device).'
  if (s.cloud === 'anthropic') return claudeModel(s.anthropicKey, s.anthropicModel)
  const preset = OPENAI_COMPAT_PRESETS.find((p) => p.id === s.compatPreset)
  // Providers without CORS (NVIDIA, many self-hosted gateways) are reached through
  // our server's /api/llm passthrough; the real base URL rides along in a header.
  const viaServer = usesServer(s.compatPreset, s.compatBaseURL, s.compatViaServer)
  const client = new OpenAI({
    baseURL: viaServer ? `${location.origin}/api/llm` : s.compatBaseURL,
    apiKey: s.compatKey || 'not-needed',
    dangerouslyAllowBrowser: true,
    ...(viaServer ? { defaultHeaders: { 'x-openbot-target': s.compatBaseURL } } : {}),
  })
  return openAIStyleModel(preset?.label ?? 'OpenAI-compatible', s.compatModel, s.compatPreset === 'ollama', (params, signal) =>
    client.chat.completions.create({ ...params, stream: true } as OpenAI.ChatCompletionCreateParamsStreaming, { signal }),
  )
}

/* ───────────────────────── Claude ───────────────────────── */

const SUPPORTS_FALLBACK = new Set(['claude-opus-5-5', 'claude-sonnet-5-5'])

function claudeModel(apiKey: string, model: string): AgentModel {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true })
  return {
    provider: 'Claude',
    model,
    local: false,
    serverWeb: true,
    tools: true,
    nativeComputer: true,
    async step(req) {
      // Same tool list on every request: changing it would invalidate earlier reasoning blocks.
      const tools: Anthropic.Beta.BetaToolUnion[] = [
        ...req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.schema as unknown as Anthropic.Beta.BetaTool.InputSchema,
          eager_input_streaming: true,
        })),
        { type: 'web_search_20260209' as const, name: 'web_search' as const },
        { type: 'web_fetch_20260209' as const, name: 'web_fetch' as const },
        ...(req.computer ? [{ type: 'computer_toolset_20260801' as const }] : []),
      ]
      const params: Anthropic.Beta.MessageCreateParamsStreaming = {
        model,
        max_tokens: 64000,
        stream: true,
        system: req.system,
        messages: toClaudeMessages(req.turns),
        tools,
        thinking: {
          type: 'adaptive',
          display: 'summarized',
          // If history ever changes underneath a reasoning block, drop it instead of failing the run.
          block_binding: { prefix_mismatch_behavior: 'drop_block' },
        },
        output_config: { effort: 'high' },
        betas: [
          'thinking-binding-controls-2026-08-01',
          ...(SUPPORTS_FALLBACK.has(model) ? ['server-side-fallback-2026-07-01'] : []),
        ],
        ...(SUPPORTS_FALLBACK.has(model) ? { fallbacks: 'default' as const } : {}),
      }

      // With eager input streaming a malformed tool input can reject the stream; retry those only.
      for (let attempt = 0; ; attempt++) {
        try {
          const stream = client.beta.messages.stream(params, { signal: req.signal })
          for await (const ev of stream) {
            if (ev.type === 'content_block_start' && ev.content_block.type === 'server_tool_use') {
              const b = ev.content_block
              req.onServerStep({ id: b.id, name: b.name, input: {} })
            } else if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use') {
              req.onToolCallStart(ev.content_block.name)
            } else if (ev.type === 'content_block_delta') {
              if (ev.delta.type === 'text_delta') req.onText(ev.delta.text)
              else if (ev.delta.type === 'thinking_delta') req.onThinking(ev.delta.thinking)
            }
          }
          return fromClaudeMessage(await stream.finalMessage())
        } catch (err) {
          if (err instanceof Anthropic.APIError || req.signal.aborted || attempt >= 2) throw err
        }
      }
    },
  }
}

function fromClaudeMessage(msg: Anthropic.Beta.BetaMessage): StepResult {
  let text = ''
  let thinking = ''
  const toolCalls: ToolCall[] = []
  const serverSteps: ServerStep[] = []
  for (const b of msg.content) {
    if (b.type === 'text') text += b.text
    else if (b.type === 'thinking') thinking += b.thinking
    else if (b.type === 'tool_use') {
      const toolset = (b as { toolset_name?: string }).toolset_name === 'computer' ? ('computer' as const) : undefined
      toolCalls.push({ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown>, ...(toolset ? { toolset } : {}) })
    }
    else if (b.type === 'server_tool_use') serverSteps.push({ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> })
    else if (b.type === 'web_search_tool_result') {
      const step = serverSteps.find((s) => s.id === b.tool_use_id)
      if (step) step.summary = Array.isArray(b.content) ? `${b.content.length} results` : `error: ${b.content.error_code}`
    } else if (b.type === 'web_fetch_tool_result') {
      const step = serverSteps.find((s) => s.id === b.tool_use_id)
      if (step) step.summary = b.content.type === 'web_fetch_result' ? 'page read' : `error: ${b.content.error_code}`
    }
  }
  const stop =
    msg.stop_reason === 'tool_use' && toolCalls.length ? 'tools'
    : msg.stop_reason === 'pause_turn' ? 'pause'
    : msg.stop_reason === 'refusal' ? 'refusal'
    : msg.stop_reason === 'max_tokens' ? 'max_tokens'
    : 'done'
  return { text, thinking, toolCalls, serverSteps, raw: msg.content as unknown[], stop }
}

/** Deterministic: the same turns always produce the same messages, so the prefix never shifts. */
function toClaudeMessages(turns: Turn[]): Anthropic.Beta.BetaMessageParam[] {
  const keep = imagesToSend(turns)
  const out: Anthropic.Beta.BetaMessageParam[] = []
  const push = (role: 'user' | 'assistant', content: Anthropic.Beta.BetaContentBlockParam[]) => {
    if (!content.length) return
    const last = out[out.length - 1]
    if (last && last.role === role) (last.content as Anthropic.Beta.BetaContentBlockParam[]).push(...content)
    else out.push({ role, content })
  }
  for (const t of turns) {
    if (t.kind === 'user') push('user', [{ type: 'text', text: userText(t) }])
    else if (t.kind === 'tool_results') {
      push(
        'user',
        t.results.map((r) => ({
          type: 'tool_result' as const,
          tool_use_id: r.callId,
          is_error: r.isError,
          ...(r.toolset ? { toolset_name: r.toolset } : {}),
          content:
            r.image && keep.has(r.callId)
              ? [{ type: 'image' as const, source: { type: 'base64' as const, media_type: r.image.mediaType, data: r.image.data } }]
              : r.image
                ? '[Older screenshot removed to save space]'
                : r.output || '(empty)',
        })),
      )
    } else if (t.raw && t.provider === 'Claude') {
      push('assistant', t.raw as Anthropic.Beta.BetaContentBlockParam[])
    } else {
      const blocks: Anthropic.Beta.BetaContentBlockParam[] = []
      if (t.text.trim()) blocks.push({ type: 'text', text: t.text })
      for (const c of t.toolCalls) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input })
      push('assistant', blocks)
    }
  }
  return out
}

/* ───────────────────── OpenAI-style (Grok, OpenAI, Ollama, wllama) ───────────────────── */

type ChunkStream = AsyncIterable<{
  choices: {
    delta?: {
      content?: string | null
      reasoning?: string
      reasoning_content?: string
      tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[]
    }
    finish_reason?: string | null
  }[]
}>

type StreamFn = (params: { messages: unknown[]; tools?: unknown[] }, signal: AbortSignal) => Promise<ChunkStream> | ChunkStream

function openAIStyleModel(provider: string, model: string, local: boolean, stream: StreamFn, tools = true): AgentModel {
  return {
    provider,
    model,
    local,
    serverWeb: false,
    tools,
    nativeComputer: false,
    async step(req) {
      const params = {
        model,
        messages: [{ role: 'system', content: req.system }, ...toOpenAIMessages(req.turns)],
        ...(tools && req.tools.length
          ? {
              tools: req.tools.map((t) => ({
                type: 'function',
                function: { name: t.name, description: t.description, parameters: t.schema },
              })),
            }
          : {}),
      }
      const calls = new Map<number, { id: string; name: string; args: string }>()
      const splitter = new ThinkTagSplitter()
      let text = ''
      let thinking = ''
      let finish = ''
      const emit = (c: { type: 'text' | 'thinking'; text: string }) => {
        if (c.type === 'text') {
          text += c.text
          req.onText(c.text)
        } else {
          thinking += c.text
          req.onThinking(c.text)
        }
      }
      for await (const part of await stream(params, req.signal)) {
        const choice = part.choices[0]
        if (!choice) continue
        if (choice.finish_reason) finish = choice.finish_reason
        const d = choice.delta
        if (!d) continue
        const reasoning = d.reasoning_content ?? d.reasoning
        if (reasoning) emit({ type: 'thinking', text: reasoning })
        if (d.content) for (const c of splitter.push(d.content)) emit(c)
        for (const tc of d.tool_calls ?? []) {
          const cur = calls.get(tc.index) ?? { id: '', name: '', args: '' }
          if (!calls.has(tc.index) && tc.function?.name) req.onToolCallStart(tc.function.name)
          if (tc.id) cur.id = tc.id
          if (tc.function?.name) cur.name += tc.function.name
          if (tc.function?.arguments) cur.args += tc.function.arguments
          calls.set(tc.index, cur)
        }
      }
      for (const c of splitter.flush()) emit(c)
      if (req.signal.aborted) throw new DOMException('Stopped', 'AbortError')

      const toolCalls: ToolCall[] = [...calls.values()].map((c, i) => {
        let input: Record<string, unknown>
        try {
          input = c.args.trim() ? JSON.parse(c.args) : {}
        } catch {
          input = { __invalid_json: c.args }
        }
        return { id: c.id || `call_${Date.now()}_${i}`, name: c.name, input }
      })
      const stop = toolCalls.length ? 'tools' : finish === 'length' ? 'max_tokens' : 'done'
      return { text, thinking, toolCalls, serverSteps: [], stop }
    },
  }
}

function toOpenAIMessages(turns: Turn[]): unknown[] {
  const keep = imagesToSend(turns)
  const out: unknown[] = []
  for (const t of turns) {
    if (t.kind === 'user') out.push({ role: 'user', content: userText(t) })
    else if (t.kind === 'tool_results') {
      for (const r of t.results) out.push({ role: 'tool', tool_call_id: r.callId, content: r.output || '(empty)' })
      // Tool messages carry text only, so screenshots follow as a user message.
      const images = t.results.filter((r) => r.image && keep.has(r.callId))
      if (images.length) {
        out.push({
          role: 'user',
          content: [
            { type: 'text', text: `Screenshot${images.length > 1 ? 's' : ''} from the computer:` },
            ...images.map((r) => ({ type: 'image_url', image_url: { url: `data:${r.image!.mediaType};base64,${r.image!.data}` } })),
          ],
        })
      }
    } else {
      // Claude's server-side web steps have no OpenAI equivalent; keep the visible text.
      if (!t.text.trim() && !t.toolCalls.length) continue
      out.push({
        role: 'assistant',
        content: t.text || null,
        ...(t.toolCalls.length
          ? {
              tool_calls: t.toolCalls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.input) },
              })),
            }
          : {}),
      })
    }
  }
  return out
}

/**
 * Which screenshots go back to the model. Past 40, the oldest are dropped in
 * blocks of 30 (keeping at least 10), so the history only changes now and then
 * instead of on every request, which keeps the prompt cache useful.
 */
function imagesToSend(turns: Turn[]): Set<string> {
  const ids: string[] = []
  for (const t of turns) if (t.kind === 'tool_results') for (const r of t.results) if (r.image) ids.push(r.callId)
  const drop = ids.length > 40 ? Math.floor((ids.length - 10) / 30) * 30 : 0
  return new Set(ids.slice(drop))
}

function userText(t: Extract<Turn, { kind: 'user' }>) {
  const when = new Date(t.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  return t.source === 'schedule' ? `[Scheduled run, ${when}]\n${t.text}` : `[${when}]\n${t.text}`
}

/* ───────────────────────── On-device ───────────────────────── */

function localAgentModel(): AgentModel | null {
  const stream = localEngine.agentStream()
  if (!stream) return null
  const s = localEngine.status as { modelId: string }
  return openAIStyleModel(`On-device (${localEngine.backend.toUpperCase()})`, s.modelId, true, stream.fn, stream.tools)
}

