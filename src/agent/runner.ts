import type { AgentModel } from './models'
import type { Bot, ServerStep, Thread, ToolCall, ToolContext, ToolDef, ToolResult, Turn } from './types'
import { CLIENT_WEB_TOOLS, TOOLS, TOOL_BY_NAME, ruleFor, validateInput } from './tools'
import { Workspace } from './workspace'

const MAX_STEPS = 30

export interface RunHooks {
  /** Called whenever the thread changes (including live streaming text). */
  onThread: (t: Thread) => void
  /** Persist after each completed turn. */
  save: (t: Thread) => Promise<void>
  onStatus: (step: string) => void
  approve: (call: ToolCall, tool: ToolDef) => Promise<'once' | 'always' | 'deny'>
  getBot: () => Bot
  updateBot: (fn: (b: Bot) => Bot) => Promise<void>
}

function id() {
  return crypto.randomUUID()
}

/** The tools a model is offered. Fixed per model so the request prefix never changes. */
export function toolsFor(model: AgentModel): ToolDef[] {
  if (!model.tools) return []
  return model.serverWeb ? TOOLS.filter((t) => !CLIENT_WEB_TOOLS.has(t.name)) : TOOLS
}

/**
 * The agent loop: ask the model, run the tools it calls (subject to the bot's
 * rules), feed results back, repeat until it answers without tools.
 */
export async function runAgent(
  thread: Thread,
  model: AgentModel,
  userTurn: Extract<Turn, { kind: 'user' }> | null,
  signal: AbortSignal,
  hooks: RunHooks,
): Promise<Thread> {
  let t: Thread = userTurn ? { ...thread, turns: [...thread.turns, userTurn], updatedAt: Date.now() } : thread
  hooks.onThread(t)
  await hooks.save(t)

  const append = async (turn: Turn) => {
    t = { ...t, turns: [...t.turns, turn], updatedAt: Date.now() }
    hooks.onThread(t)
    await hooks.save(t)
  }

  const tools = toolsFor(model)
  const workspace = new Workspace(t.botId)

  for (let step = 0; step < MAX_STEPS; step++) {
    hooks.onStatus(step === 0 ? 'Thinking' : 'Working')

    // Stream into a live turn so the UI shows text as it arrives.
    const live: Extract<Turn, { kind: 'assistant' }> = {
      kind: 'assistant',
      id: id(),
      at: Date.now(),
      provider: model.provider,
      model: model.model,
      text: '',
      toolCalls: [],
    }
    const showLive = () => hooks.onThread({ ...t, turns: [...t.turns, { ...live }] })
    const serverSteps: ServerStep[] = []

    let result
    try {
      result = await model.step({
        system: t.system,
        turns: t.turns,
        tools,
        signal,
        onText: (d) => {
          live.text += d
          showLive()
        },
        onThinking: (d) => {
          live.thinking = (live.thinking ?? '') + d
          showLive()
        },
        onToolCallStart: (name) => hooks.onStatus(`Preparing: ${TOOL_BY_NAME.get(name)?.label ?? name}`),
        onServerStep: (s) => {
          serverSteps.push(s)
          live.serverSteps = [...serverSteps]
          hooks.onStatus(s.name === 'web_search' ? 'Searching the web' : 'Reading a page')
          showLive()
        },
      })
    } catch (err) {
      const stopped = signal.aborted
      await append({
        ...live,
        stop: stopped ? 'stopped' : 'error',
        error: stopped ? undefined : describeError(err),
      })
      return t
    }

    await append({
      ...live,
      text: result.text,
      thinking: result.thinking || undefined,
      toolCalls: result.toolCalls,
      serverSteps: result.serverSteps.length ? result.serverSteps : undefined,
      raw: result.raw,
      stop: result.stop === 'pause' ? 'tools' : result.stop,
    })

    // Claude paused a long server-side tool loop: send the history back and it resumes.
    if (result.stop === 'pause') continue
    if (result.stop !== 'tools') return t

    // All results go back in one turn, but each is shown as soon as its tool finishes.
    const resultsId = id()
    const results: ToolResult[] = []
    for (const call of result.toolCalls) {
      if (signal.aborted) {
        results.push({ callId: call.id, name: call.name, output: 'Stopped by the user before this ran.', isError: true })
        continue
      }
      results.push(await runTool(call, workspace, signal, hooks))
      hooks.onThread({ ...t, turns: [...t.turns, { kind: 'tool_results', id: resultsId, at: Date.now(), results: [...results] }] })
    }
    await append({ kind: 'tool_results', id: resultsId, at: Date.now(), results })
    if (signal.aborted) return t
  }

  await append({
    kind: 'assistant',
    id: id(),
    at: Date.now(),
    provider: 'open-bot',
    model: '',
    text: `_Stopped after ${MAX_STEPS} steps. Send a message to let me continue._`,
    toolCalls: [],
    stop: 'done',
  })
  return t
}

async function runTool(call: ToolCall, workspace: Workspace, signal: AbortSignal, hooks: RunHooks): Promise<ToolResult> {
  const base = { callId: call.id, name: call.name }
  const tool = TOOL_BY_NAME.get(call.name)
  if (!tool) return { ...base, output: `Unknown tool "${call.name}".`, isError: true }

  if ('__invalid_json' in call.input) {
    return { ...base, output: JSON.stringify({ INVALID_JSON: call.input.__invalid_json }), isError: true }
  }
  const problem = validateInput(call.input, tool.schema)
  if (problem) return { ...base, output: `Invalid input: ${problem}. Input was ${JSON.stringify(call.input)}`, isError: true }

  const bot = hooks.getBot()
  const rule = ruleFor(bot.rules, tool)
  if (rule === 'block') {
    return { ...base, output: `The user has blocked the ${tool.name} tool for this bot.`, isError: true, decision: 'blocked' }
  }
  let decision: ToolResult['decision'] = 'auto'
  if (rule === 'ask') {
    hooks.onStatus(`Waiting for approval: ${tool.label}`)
    const answer = await hooks.approve(call, tool)
    if (answer === 'deny') {
      return { ...base, output: 'The user declined this action. Do not retry it; continue another way or ask.', isError: true, decision: 'denied' }
    }
    if (answer === 'always') await hooks.updateBot((b) => ({ ...b, rules: { ...b.rules, [tool.name]: 'allow' } }))
    decision = 'approved'
  }

  hooks.onStatus(tool.label)
  const ctx: ToolContext = { bot: hooks.getBot(), workspace, signal, updateBot: hooks.updateBot }
  try {
    const out = await tool.run(call.input, ctx)
    return { ...base, output: out.output, isError: !!out.isError, decision }
  } catch (err) {
    return { ...base, output: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true, decision }
  }
}

export function describeError(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err)
  if (/Failed to fetch|NetworkError|CORS/i.test(msg)) {
    return `Could not reach the model provider (${msg}). It may block browser requests; a small proxy fixes that.`
  }
  if (/\b401\b|invalid.*key|authentication/i.test(msg)) return `The API key was rejected: ${msg}`
  return msg
}
