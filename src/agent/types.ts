/** What a tool may do. Drives the default rule and the warning shown on approval. */
export type ToolRisk = 'read' | 'write' | 'execute' | 'network' | 'notify'
export type Rule = 'allow' | 'ask' | 'block'

export interface JsonSchema {
  type: 'object'
  properties: Record<string, { type: 'string' | 'number' | 'integer' | 'boolean'; description?: string; enum?: string[] }>
  required: string[]
  additionalProperties: false
}

export interface ToolContext {
  bot: Bot
  workspace: import('./workspace').Workspace
  signal: AbortSignal
  /** Lets a tool change its bot (memory, schedules) and persist it. */
  updateBot: (fn: (b: Bot) => Bot) => Promise<void>
}

export interface ToolOutput {
  output: string
  isError?: boolean
}

export interface ToolDef {
  name: string
  label: string
  description: string
  risk: ToolRisk
  schema: JsonSchema
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>
}

export interface Schedule {
  id: string
  task: string
  /** Repeat interval in minutes; 0 means daily at `dailyAt`. */
  everyMinutes: number
  dailyAt?: string
  nextRunAt: number
  lastRunAt?: number
  enabled: boolean
}

export type Engine = 'auto' | 'cloud' | 'local'

export interface Bot {
  id: string
  name: string
  color: string
  goal: string
  instructions: string
  engine: Engine
  rules: Record<string, Rule>
  memory: { id: string; text: string; at: number }[]
  schedules: Schedule[]
  createdAt: number
  updatedAt: number
}

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResult {
  callId: string
  name: string
  output: string
  isError: boolean
  /** How it was approved, for the activity log. */
  decision?: 'auto' | 'approved' | 'denied' | 'blocked'
}

/** A step a server-side tool took inside the model's turn (Claude web search/fetch). */
export interface ServerStep {
  id: string
  name: string
  input: Record<string, unknown>
  summary?: string
}

/**
 * A thread is append-only. That keeps cloud prompt caches warm and keeps
 * Claude's reasoning blocks valid, since they are bound to the exact history.
 */
export type Turn =
  | { kind: 'user'; id: string; at: number; text: string; source: 'user' | 'schedule' }
  | {
      kind: 'assistant'
      id: string
      at: number
      provider: string
      model: string
      text: string
      thinking?: string
      toolCalls: ToolCall[]
      serverSteps?: ServerStep[]
      /** Claude's content blocks, replayed verbatim on later requests. */
      raw?: unknown[]
      stop?: 'done' | 'tools' | 'stopped' | 'error' | 'refusal' | 'max_tokens'
      error?: string
    }
  | { kind: 'tool_results'; id: string; at: number; results: ToolResult[] }

export interface Thread {
  id: string
  botId: string
  /** Frozen when the thread starts; editing a bot applies from its next thread. */
  system: string
  turns: Turn[]
  createdAt: number
  updatedAt: number
}

export type BotStatus =
  | { state: 'idle' }
  | { state: 'working'; step: string }
  | { state: 'waiting'; approval: PendingApproval }
  | { state: 'error'; message: string }

export interface PendingApproval {
  call: ToolCall
  tool: ToolDef
  resolve: (decision: 'once' | 'always' | 'deny') => void
}
