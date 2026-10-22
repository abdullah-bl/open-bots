import type { Bot, BotStatus, Thread, Turn } from './types'
import type { Settings } from '../lib/settings'
import { pickModel } from './models'
import { runAgent } from './runner'
import { buildSystemPrompt } from './prompt'
import { computeNextRun } from './scheduler'
import { deleteBotData, loadBots, loadThreads, saveBot, saveThread } from './store'
import { Workspace } from './workspace'
import { closeShell, setShellRelay } from './sandbox/shell'
import { resolveServer, setServer, wispUrl } from '../lib/server'
import { computer } from '../computer/vm'
import { botFromTemplate, type BotTemplate } from './templates'

export interface AgentState {
  ready: boolean
  bots: Bot[]
  threads: Record<string, Thread>
  status: Record<string, BotStatus>
}

const SCHEDULER_TICK_MS = 20_000

/**
 * Owns every bot: their current threads, runs, approvals and schedules.
 * React reads it through useSyncExternalStore (see useAgents).
 */
class AgentManager {
  state: AgentState = { ready: false, bots: [], threads: {}, status: {} }
  private listeners = new Set<() => void>()
  private controllers = new Map<string, AbortController>()
  private settings: Settings | null = null
  private timer: ReturnType<typeof setInterval> | null = null

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  getState = () => this.state

  private set(patch: Partial<AgentState>) {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach((fn) => fn())
  }

  private setStatus(botId: string, s: BotStatus) {
    this.set({ status: { ...this.state.status, [botId]: s } })
  }

  private setThread(t: Thread) {
    this.set({ threads: { ...this.state.threads, [t.botId]: t } })
  }

  setSettings(s: Settings) {
    this.settings = s
    setServer(resolveServer(s.serverURL))
    setShellRelay(s.internet ? wispUrl() : null)
    // The computer keeps its network card either way; offline it gets a relay that refuses everything.
    computer().setRelay(wispUrl(!s.internet))
  }

  async init() {
    if (this.state.ready) return
    const bots = await loadBots()
    const threads: Record<string, Thread> = {}
    for (const b of bots) {
      const list = await loadThreads(b.id)
      threads[b.id] = list[list.length - 1] ?? this.freshThread(b)
    }
    this.set({ ready: true, bots, threads, status: Object.fromEntries(bots.map((b) => [b.id, { state: 'idle' }])) })
    this.timer ??= setInterval(() => this.tick(), SCHEDULER_TICK_MS)
    setTimeout(() => this.tick(), 3000)
  }

  private freshThread(bot: Bot): Thread {
    const now = Date.now()
    return {
      id: crypto.randomUUID(),
      botId: bot.id,
      system: buildSystemPrompt(bot, true),
      computer: !!bot.computer,
      turns: [],
      createdAt: now,
      updatedAt: now,
    }
  }

  bot(id: string) {
    return this.state.bots.find((b) => b.id === id)
  }

  async createBot(template: BotTemplate): Promise<Bot> {
    const bot = botFromTemplate(template)
    await saveBot(bot)
    const thread = this.freshThread(bot)
    this.set({
      bots: [...this.state.bots, bot],
      threads: { ...this.state.threads, [bot.id]: thread },
      status: { ...this.state.status, [bot.id]: { state: 'idle' } },
    })
    return bot
  }

  updateBot = async (botId: string, fn: (b: Bot) => Bot) => {
    const cur = this.bot(botId)
    if (!cur) return
    const next = { ...fn(cur), updatedAt: Date.now() }
    this.set({ bots: this.state.bots.map((b) => (b.id === botId ? next : b)) })
    await saveBot(next)
  }

  async deleteBot(botId: string) {
    this.stop(botId)
    await deleteBotData(botId)
    await new Workspace(botId).destroy()
    await closeShell(botId)
    const { [botId]: _t, ...threads } = this.state.threads
    const { [botId]: _s, ...status } = this.state.status
    this.set({ bots: this.state.bots.filter((b) => b.id !== botId), threads, status })
  }

  /** Starts a new thread so edits to the bot's goal, instructions and memory take effect. */
  async newThread(botId: string) {
    const bot = this.bot(botId)
    if (!bot || this.isBusy(botId)) return
    const t = this.freshThread(bot)
    this.setThread(t)
    await saveThread(t)
  }

  isBusy(botId: string) {
    const s = this.state.status[botId]?.state
    return s === 'working' || s === 'waiting'
  }

  stop(botId: string) {
    this.controllers.get(botId)?.abort()
    const s = this.state.status[botId]
    if (s?.state === 'waiting') s.approval.resolve('deny')
  }

  async send(botId: string, text: string, source: 'user' | 'schedule' = 'user') {
    const bot = this.bot(botId)
    if (!bot || !this.settings || this.isBusy(botId)) return
    let thread = this.state.threads[botId] ?? this.freshThread(bot)
    const userTurn: Extract<Turn, { kind: 'user' }> = { kind: 'user', id: crypto.randomUUID(), at: Date.now(), text, source }

    const model = pickModel(bot.engine, this.settings)
    if (typeof model === 'string') {
      thread = {
        ...thread,
        turns: [
          ...thread.turns,
          userTurn,
          { kind: 'assistant', id: crypto.randomUUID(), at: Date.now(), provider: 'open-bot', model: '', text: '', toolCalls: [], stop: 'error', error: model },
        ],
      }
      this.setThread(thread)
      await saveThread(thread)
      return
    }

    thread = repairDanglingCalls(thread)
    const ctrl = new AbortController()
    this.controllers.set(botId, ctrl)
    this.setStatus(botId, { state: 'working', step: 'Starting' })
    try {
      const final = await runAgent(thread, model, userTurn, ctrl.signal, {
        onThread: (t) => this.setThread(t),
        save: saveThread,
        onStatus: (step) => this.setStatus(botId, { state: 'working', step }),
        approve: (call, tool) =>
          new Promise((resolve) => {
            this.setStatus(botId, {
              state: 'waiting',
              approval: {
                call,
                tool,
                resolve: (d) => {
                  this.setStatus(botId, { state: 'working', step: tool.label })
                  resolve(d)
                },
              },
            })
            if (source === 'schedule') notify(bot, 'Needs your approval', `${tool.label} is waiting for you.`)
          }),
        getBot: () => this.bot(botId)!,
        updateBot: (fn) => this.updateBot(botId, fn),
      })
      // Keep what the bot did on the computer (installed software, open apps) across reloads.
      if (final.computer && final.turns.slice(thread.turns.length).some((t) => t.kind === 'tool_results' && t.results.some((r) => r.toolset === 'computer' || r.name.startsWith('computer_')))) {
        const vm = computer()
        if (vm.status.state === 'ready') await vm.saveSnapshot().catch(() => {})
      }
      const last = final.turns[final.turns.length - 1]
      if (source === 'schedule' && last?.kind === 'assistant' && document.hidden) {
        notify(bot, 'Scheduled run finished', last.text.slice(0, 180) || 'Done.')
      }
      const succeeded = last?.kind === 'assistant' && last.stop !== 'error' && last.stop !== 'stopped'
      this.setStatus(botId, { state: 'idle', done: succeeded })
      if (succeeded) {
        setTimeout(() => {
          const s = this.state.status[botId]
          if (s?.state === 'idle' && s.done) this.setStatus(botId, { state: 'idle' })
        }, 2600)
      }
    } catch (err) {
      this.setStatus(botId, { state: 'error', message: err instanceof Error ? err.message : String(err) })
    } finally {
      this.controllers.delete(botId)
    }
  }

  /** Runs any schedules that are due (including ones missed while the app was closed). */
  private async tick() {
    if (!this.settings) return
    const now = Date.now()
    for (const bot of this.state.bots) {
      if (this.isBusy(bot.id)) continue
      const due = bot.schedules.find((s) => s.enabled && s.nextRunAt <= now)
      if (!due) continue
      await this.updateBot(bot.id, (b) => ({
        ...b,
        schedules: b.schedules.map((s) => (s.id === due.id ? { ...s, lastRunAt: now, nextRunAt: computeNextRun(s, now) } : s)),
      }))
      void this.send(bot.id, due.task, 'schedule')
    }
  }
}

/** A page reload mid-tool leaves calls without results; answer them so the history stays valid. */
function repairDanglingCalls(t: Thread): Thread {
  const last = t.turns[t.turns.length - 1]
  if (last?.kind !== 'assistant' || !last.toolCalls.length) return t
  return {
    ...t,
    turns: [
      ...t.turns,
      {
        kind: 'tool_results',
        id: crypto.randomUUID(),
        at: Date.now(),
        results: last.toolCalls.map((c) => ({ callId: c.id, name: c.name, output: 'Interrupted before it ran (the page was closed).', isError: true })),
      },
    ],
  }
}

function notify(bot: Bot, title: string, body: string) {
  if ('Notification' in window && Notification.permission === 'granted') new Notification(`${bot.name}: ${title}`, { body, tag: bot.id })
}

export const agents = new AgentManager()
