import type { JsonSchema, Rule, Schedule, ToolDef, ToolRisk } from './types'
import { cleanPath, formatBytes, isTextFile } from './workspace'
import { runJavaScript, runPython } from './sandbox/sandbox'
import { computeNextRun } from './scheduler'

const MAX_READ = 40_000

function schema(properties: JsonSchema['properties'], required: string[] = Object.keys(properties)): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false }
}

const str = (description: string) => ({ type: 'string' as const, description })

export const TOOLS: ToolDef[] = [
  {
    name: 'list_files',
    label: 'List files',
    risk: 'read',
    description: "List every file in your workspace (the bot's private folder in the browser) with sizes.",
    schema: schema({}),
    async run(_input, { workspace }) {
      const files = await workspace.list()
      if (!files.length) return { output: 'The workspace is empty.' }
      return { output: files.map((f) => `${f.path}  (${formatBytes(f.size)})`).join('\n') }
    },
  },
  {
    name: 'read_file',
    label: 'Read file',
    risk: 'read',
    description: `Read a text file from your workspace. Returns up to ${MAX_READ} characters; use run_python for large or binary files.`,
    schema: schema({ path: str('File path relative to the workspace, e.g. "notes/today.md"') }),
    async run(input, { workspace }) {
      const path = cleanPath(String(input.path))
      if (!isTextFile(path)) return { output: `${path} looks binary. Open it with run_python instead.`, isError: true }
      const text = await workspace.readText(path)
      return { output: text.length > MAX_READ ? `${text.slice(0, MAX_READ)}\n…[truncated, ${text.length} chars total]` : text }
    },
  },
  {
    name: 'write_file',
    label: 'Write file',
    risk: 'write',
    description: 'Create or overwrite a text file in your workspace. Use it for reports, notes, code, and data you produce.',
    schema: schema({ path: str('File path relative to the workspace'), content: str('Full file contents') }),
    async run(input, { workspace }) {
      const path = cleanPath(String(input.path))
      const content = String(input.content)
      await workspace.write(path, content)
      return { output: `Wrote ${path} (${formatBytes(new TextEncoder().encode(content).length)}).` }
    },
  },
  {
    name: 'delete_file',
    label: 'Delete file',
    risk: 'write',
    description: 'Delete a file or folder from your workspace.',
    schema: schema({ path: str('File or folder path relative to the workspace') }),
    async run(input, { workspace }) {
      const path = cleanPath(String(input.path))
      await workspace.remove(path)
      return { output: `Deleted ${path}.` }
    },
  },
  {
    name: 'run_python',
    label: 'Run Python',
    risk: 'execute',
    description:
      'Run Python 3 (Pyodide, in a WebAssembly sandbox in the browser). The working directory is your workspace, so open() reads and writes your files. ' +
      'numpy, pandas, matplotlib, scipy and other common packages load automatically from imports. Save charts with plt.savefig("chart.png"). ' +
      'print() what you need to see. No network access from Python.',
    schema: schema({ code: str('Python source to run') }),
    async run(input, { workspace, signal }) {
      const r = await runPython(String(input.code), workspace, signal)
      return { output: r.output, isError: !r.ok }
    },
  },
  {
    name: 'run_javascript',
    label: 'Run JavaScript',
    risk: 'execute',
    description:
      'Run JavaScript in an isolated web worker (no DOM, 30s limit). The code is the body of an async function with `files` ' +
      '(an object of workspace path -> text) and `writeFile(path, text)` in scope. Use console.log or `return` a value.',
    schema: schema({ code: str('JavaScript function body to run') }),
    async run(input, { workspace, signal }) {
      const r = await runJavaScript(String(input.code), workspace, signal)
      return { output: r.output, isError: !r.ok }
    },
  },
  {
    name: 'web_search',
    label: 'Search the web',
    risk: 'network',
    description: 'Search the web. Returns titles, URLs and snippets; follow up with fetch_url to read a page.',
    schema: schema({ query: str('Search query') }),
    async run(input) {
      const res = await fetch(`/api/search?q=${encodeURIComponent(String(input.query))}`)
      const data = (await res.json()) as { error?: string; note?: string; source?: string; results?: { title: string; url: string; snippet: string }[] }
      if (data.error) return { output: data.error, isError: true }
      const lines = (data.results ?? []).map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
      return { output: [data.note, ...lines].filter(Boolean).join('\n') || 'No results.' }
    },
  },
  {
    name: 'fetch_url',
    label: 'Read a web page',
    risk: 'network',
    description: 'Fetch a web page or file by URL and return its readable text (and links). Public http(s) URLs only.',
    schema: schema({ url: str('Absolute http(s) URL') }),
    async run(input) {
      const res = await fetch(`/api/fetch?url=${encodeURIComponent(String(input.url))}`)
      const type = res.headers.get('content-type') ?? ''
      if (type.includes('application/json') && !res.ok) {
        const data = (await res.json()) as { error?: string }
        return { output: data.error ?? `HTTP ${res.status}`, isError: true }
      }
      const body = await res.text()
      const text = type.includes('html') ? htmlToText(body, res.headers.get('x-final-url') ?? String(input.url)) : body
      const clipped = text.length > MAX_READ ? `${text.slice(0, MAX_READ)}\n…[truncated]` : text
      return { output: `HTTP ${res.status}\n\n${clipped}`, isError: !res.ok }
    },
  },
  {
    name: 'remember',
    label: 'Remember',
    risk: 'write',
    description:
      'Save a short fact to your long-term memory (user preferences, decisions, progress on the goal). Memory is shown to you at the start of every new thread.',
    schema: schema({ note: str('The fact to remember, one sentence') }),
    async run(input, { updateBot }) {
      const note = String(input.note).trim()
      await updateBot((b) => ({ ...b, memory: [...b.memory, { id: crypto.randomUUID(), text: note, at: Date.now() }] }))
      return { output: `Remembered: ${note}` }
    },
  },
  {
    name: 'notify_user',
    label: 'Notify user',
    risk: 'notify',
    description: 'Show the user a desktop notification. Use it for important results or when you need their input, especially during scheduled runs.',
    schema: schema({ title: str('Short title'), message: str('One or two sentences') }),
    async run(input, { bot }) {
      const title = `${bot.name}: ${String(input.title)}`
      const body = String(input.message)
      if (!('Notification' in window)) return { output: 'This browser has no notifications.', isError: true }
      let perm = Notification.permission
      if (perm === 'default') perm = await Notification.requestPermission()
      if (perm !== 'granted') return { output: 'The user has not allowed notifications.', isError: true }
      new Notification(title, { body, tag: bot.id })
      return { output: 'Notification shown.' }
    },
  },
  {
    name: 'schedule_task',
    label: 'Schedule a task',
    risk: 'write',
    description:
      'Schedule yourself to run a task later, repeatedly: every N minutes, or daily at a time. Runs happen while open-bot is open in a browser tab; missed runs happen when it reopens.',
    schema: schema(
      {
        task: str('What to do on each run, written as an instruction to yourself'),
        every_minutes: { type: 'integer', description: 'Repeat every N minutes (minimum 5). Omit when using daily_at.' },
        daily_at: str('Local time "HH:MM" to run every day. Omit when using every_minutes.'),
      },
      ['task'],
    ),
    async run(input, { updateBot }) {
      const every = input.every_minutes === undefined ? 0 : Math.max(5, Number(input.every_minutes))
      const dailyAt = typeof input.daily_at === 'string' ? input.daily_at : undefined
      if (!every && !(dailyAt && /^\d{1,2}:\d{2}$/.test(dailyAt))) {
        return { output: 'Give every_minutes or daily_at ("HH:MM").', isError: true }
      }
      const s: Schedule = {
        id: crypto.randomUUID().slice(0, 8),
        task: String(input.task),
        everyMinutes: every,
        dailyAt: every ? undefined : dailyAt,
        nextRunAt: 0,
        enabled: true,
      }
      s.nextRunAt = computeNextRun(s, Date.now())
      await updateBot((b) => ({ ...b, schedules: [...b.schedules, s] }))
      return { output: `Scheduled ${s.id}. Next run: ${new Date(s.nextRunAt).toLocaleString()}.` }
    },
  },
  {
    name: 'list_schedules',
    label: 'List schedules',
    risk: 'read',
    description: 'List your scheduled tasks.',
    schema: schema({}),
    async run(_input, { bot }) {
      if (!bot.schedules.length) return { output: 'No schedules.' }
      return {
        output: bot.schedules
          .map((s) => `${s.id}: "${s.task}" ${s.everyMinutes ? `every ${s.everyMinutes} min` : `daily at ${s.dailyAt}`}, next ${new Date(s.nextRunAt).toLocaleString()}${s.enabled ? '' : ' (paused)'}`)
          .join('\n'),
      }
    },
  },
  {
    name: 'cancel_schedule',
    label: 'Cancel schedule',
    risk: 'write',
    description: 'Cancel one of your scheduled tasks by id.',
    schema: schema({ schedule_id: str('Schedule id from list_schedules') }),
    async run(input, { bot, updateBot }) {
      const id = String(input.schedule_id)
      if (!bot.schedules.some((s) => s.id === id)) return { output: `No schedule ${id}.`, isError: true }
      await updateBot((b) => ({ ...b, schedules: b.schedules.filter((s) => s.id !== id) }))
      return { output: `Cancelled ${id}.` }
    },
  },
]

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))

/** Tools that Claude replaces with its own server-side web search and fetch. */
export const CLIENT_WEB_TOOLS = new Set(['web_search', 'fetch_url'])

export const DEFAULT_RULES: Record<ToolRisk, Rule> = {
  read: 'allow',
  write: 'allow',
  execute: 'allow',
  network: 'allow',
  notify: 'allow',
}

/** Stricter defaults for the few tools that can lose work or act on their own. */
const TOOL_DEFAULTS: Record<string, Rule> = {
  delete_file: 'ask',
  run_javascript: 'ask',
  schedule_task: 'ask',
}

export function ruleFor(rules: Record<string, Rule>, tool: ToolDef): Rule {
  return rules[tool.name] ?? TOOL_DEFAULTS[tool.name] ?? DEFAULT_RULES[tool.risk]
}

/** Checks a parsed tool input against its schema. Returns a problem, or null when valid. */
export function validateInput(input: unknown, s: JsonSchema): string | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return 'Input must be a JSON object'
  const obj = input as Record<string, unknown>
  for (const key of s.required) if (!(key in obj)) return `Missing required field "${key}"`
  for (const [key, value] of Object.entries(obj)) {
    const prop = s.properties[key]
    if (!prop) return `Unknown field "${key}"`
    const ok =
      prop.type === 'string' ? typeof value === 'string'
      : prop.type === 'boolean' ? typeof value === 'boolean'
      : prop.type === 'integer' ? Number.isInteger(value)
      : typeof value === 'number'
    if (!ok) return `Field "${key}" must be a ${prop.type}`
  }
  return null
}

/** Pulls readable text out of an HTML page, keeping headings, list items and links. */
function htmlToText(html: string, baseUrl: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('script,style,noscript,svg,iframe,nav,footer,form,[aria-hidden="true"]').forEach((n) => n.remove())
  const root = doc.querySelector('article') ?? doc.querySelector('main') ?? doc.body
  if (!root) return ''
  const lines: string[] = []
  const blocks = root.querySelectorAll('h1,h2,h3,h4,p,li,pre,blockquote,td,th,dt,dd')
  if (blocks.length) {
    blocks.forEach((el) => {
      const t = el.textContent?.replace(/\s+/g, ' ').trim()
      if (!t) return
      const tag = el.tagName.toLowerCase()
      lines.push(tag.startsWith('h') ? `\n${'#'.repeat(Number(tag[1]))} ${t}` : tag === 'li' ? `- ${t}` : t)
    })
  } else {
    lines.push(root.textContent?.replace(/\s+/g, ' ').trim() ?? '')
  }
  const links = [...root.querySelectorAll('a[href]')]
    .map((a) => {
      try {
        return `- ${a.textContent?.trim().slice(0, 80) || '(link)'}: ${new URL(a.getAttribute('href')!, baseUrl).href}`
      } catch {
        return ''
      }
    })
    .filter((l) => l && !l.includes('javascript:'))
    .slice(0, 40)
  const title = doc.title ? `# ${doc.title}\n` : ''
  return `${title}${lines.join('\n')}${links.length ? `\n\nLinks:\n${links.join('\n')}` : ''}`.trim()
}
