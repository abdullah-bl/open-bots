import type { JsonSchema, Rule, Schedule, ToolDef, ToolRisk } from './types'
import { cleanPath, formatBytes, isTextFile } from './workspace'
import { runPython } from './sandbox/sandbox'
import { runShell } from './sandbox/shell'
import { computeNextRun } from './scheduler'
import { runComputerAction } from '../computer/actions'
import { NO_SERVER, apiUrl } from '../lib/server'

const MAX_READ = 40_000

function schema(properties: JsonSchema['properties'], required: string[] = Object.keys(properties)): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false }
}

const str = (description: string) => ({ type: 'string' as const, description })

/** Wasmer registry packages a bot can add to its shell. */
const SHELL_PACKAGES: Record<string, { pkg: string; about: string }> = {
  python: { pkg: 'python/python', about: 'python3 3.13, standard library only' },
  sqlite: { pkg: 'sqlite/sqlite', about: 'sqlite3' },
  node: { pkg: 'wasmer/edgejs', about: 'node, Node.js 24 compatible' },
  quickjs: { pkg: 'wasmer/quickjs', about: 'qjs, small JavaScript engine' },
  ripgrep: { pkg: 'wasmer/ripgrep', about: 'rg, fast search' },
  php: { pkg: 'php/php', about: 'php 8.3' },
  curl: { pkg: 'curl/curl', about: 'curl, HTTP(S) from the shell' },
}

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
      return { output: `Wrote ${path} (${formatBytes(new TextEncoder().encode(content).length)}).`, files: [path] }
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
      return { output: r.output, isError: !r.ok, files: r.changedFiles }
    },
  },
  {
    name: 'bash',
    label: 'Run shell',
    risk: 'execute',
    description:
      'Run a bash command in a Unix shell compiled to WebAssembly (WASIX), sandboxed in the browser. It can reach public internet hosts when the user has internet access on (add the curl package for HTTP). ' +
      'The working directory /workspace is your workspace, so files you create there are saved. Built in: bash, coreutils (ls, cat, head, sort, wc, cut, tr, …), grep, sed. There is no awk. ' +
      'Add tools with `packages` (comma-separated, installed once per session): ' +
      Object.entries(SHELL_PACKAGES)
        .map(([k, v]) => `${k} (${v.about})`)
        .join(', ') +
      '. Use run_python instead for numpy, pandas or matplotlib.',
    schema: schema(
      {
        command: str('The bash command or script to run'),
        packages: str(`Optional extra tools, comma-separated: ${Object.keys(SHELL_PACKAGES).join(', ')}`),
      },
      ['command'],
    ),
    async run(input, { workspace, signal, progress }) {
      const wanted = typeof input.packages === 'string' ? input.packages.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean) : []
      const unknown = wanted.filter((p) => !(p in SHELL_PACKAGES))
      if (unknown.length) {
        return { output: `Unknown package(s): ${unknown.join(', ')}. Available: ${Object.keys(SHELL_PACKAGES).join(', ')}.`, isError: true }
      }
      const r = await runShell(String(input.command), workspace, {
        packages: wanted.map((p) => SHELL_PACKAGES[p].pkg),
        signal,
        onProgress: progress,
      })
      return { output: r.output, isError: !r.ok, files: r.changedFiles.filter((f) => !f.endsWith(' (deleted)')) }
    },
  },
  {
    name: 'web_search',
    label: 'Search the web',
    risk: 'network',
    description: 'Search the web. Returns titles, URLs and snippets; follow up with fetch_url to read a page.',
    schema: schema({ query: str('Search query') }),
    async run(input) {
      const url = apiUrl(`/api/search?q=${encodeURIComponent(String(input.query))}`)
      if (!url) return { output: NO_SERVER, isError: true }
      const res = await fetch(url)
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
      const url = apiUrl(`/api/fetch?url=${encodeURIComponent(String(input.url))}`)
      if (!url) return { output: NO_SERVER, isError: true }
      const res = await fetch(url)
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

/**
 * Rules and approvals treat every computer action as this one tool. Claude
 * drives the computer through its own toolset; the tools below are for other models.
 */
export const COMPUTER_TOOL: ToolDef = {
  name: 'computer',
  label: 'Use the computer',
  risk: 'computer',
  description: 'Screenshots, mouse and keyboard on the shared Linux computer.',
  schema: schema({}),
  run: async () => ({ output: '' }),
}

const xy = (what: string) => ({
  x: { type: 'integer' as const, description: `X pixel of ${what}, in screenshot coordinates` },
  y: { type: 'integer' as const, description: `Y pixel of ${what}, in screenshot coordinates` },
})

/** Runs an action, then returns a fresh screenshot so the model sees the result. */
async function actThenLook(member: string, input: Record<string, unknown>) {
  const done = await runComputerAction(member, input)
  if (done.isError || done.image) return done
  await new Promise((r) => setTimeout(r, 300))
  const shot = await runComputerAction('screenshot', {})
  return { output: `${done.output}. Screenshot after the action attached.`, image: shot.image }
}

export const COMPUTER_TOOLS: ToolDef[] = [
  {
    name: 'computer_screenshot',
    label: 'Take a screenshot',
    risk: 'computer',
    description: 'See the computer screen (a 1024x768 Linux desktop). Always look before you click.',
    schema: schema({}),
    run: () => runComputerAction('screenshot', {}),
  },
  {
    name: 'computer_click',
    label: 'Click',
    risk: 'computer',
    description: 'Click at a screen position.',
    schema: schema(
      {
        ...xy('the click'),
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Default left' },
        clicks: { type: 'integer', description: '1 (default), 2 for double-click, 3 for triple-click' },
        modifiers: str('Keys to hold, e.g. "ctrl" or "shift"'),
      },
      ['x', 'y'],
    ),
    run: (i) => {
      const clicks = Number(i.clicks ?? 1)
      const button = String(i.button ?? 'left')
      const member = button === 'right' ? 'right_click' : button === 'middle' ? 'middle_click' : clicks >= 3 ? 'triple_click' : clicks === 2 ? 'double_click' : 'left_click'
      return actThenLook(member, { coordinate: [i.x, i.y], ...(i.modifiers ? { text: i.modifiers } : {}) })
    },
  },
  {
    name: 'computer_type',
    label: 'Type',
    risk: 'computer',
    description: 'Type text where the keyboard focus is (US layout). Use computer_key for Enter and shortcuts.',
    schema: schema({ text: str('Text to type') }),
    run: (i) => actThenLook('type', { text: i.text }),
  },
  {
    name: 'computer_key',
    label: 'Press keys',
    risk: 'computer',
    description: 'Press a key or combination, e.g. "Return", "ctrl+c", "alt+Tab", "Page_Down".',
    schema: schema({ keys: str('Key or + combination'), repeat: { type: 'integer', description: 'Times to press, default 1' } }, ['keys']),
    run: (i) => actThenLook('key', { text: i.keys, repeat: i.repeat ?? 1 }),
  },
  {
    name: 'computer_scroll',
    label: 'Scroll',
    risk: 'computer',
    description: 'Scroll the mouse wheel, optionally after moving to a position.',
    schema: schema(
      {
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'integer', description: 'Wheel clicks, default 3' },
        ...xy('where to scroll'),
      },
      ['direction'],
    ),
    run: (i) =>
      actThenLook('scroll', {
        scroll_direction: i.direction,
        scroll_amount: i.amount ?? 3,
        ...(i.x !== undefined && i.y !== undefined ? { coordinate: [i.x, i.y] } : {}),
      }),
  },
  {
    name: 'computer_drag',
    label: 'Drag',
    risk: 'computer',
    description: 'Press at one position, drag, and release at another.',
    schema: schema({
      from_x: { type: 'integer' },
      from_y: { type: 'integer' },
      to_x: { type: 'integer' },
      to_y: { type: 'integer' },
    }),
    run: (i) => actThenLook('left_click_drag', { start_coordinate: [i.from_x, i.from_y], coordinate: [i.to_x, i.to_y] }),
  },
  {
    name: 'computer_move',
    label: 'Move pointer',
    risk: 'computer',
    description: 'Move the mouse pointer without clicking (to hover).',
    schema: schema(xy('the pointer')),
    run: (i) => actThenLook('mouse_move', { coordinate: [i.x, i.y] }),
  },
  {
    name: 'computer_zoom',
    label: 'Zoom',
    risk: 'computer',
    description: 'See a region of the screen enlarged, to read small text. Coordinates stay in full-screenshot space.',
    schema: schema({
      x0: { type: 'integer' },
      y0: { type: 'integer' },
      x1: { type: 'integer' },
      y1: { type: 'integer' },
    }),
    run: (i) => runComputerAction('zoom', { region: [i.x0, i.y0, i.x1, i.y1] }),
  },
  {
    name: 'computer_wait',
    label: 'Wait',
    risk: 'computer',
    description: 'Wait for something to load, then get a screenshot.',
    schema: schema({ seconds: { type: 'integer', description: '1 to 30' } }),
    run: (i) => runComputerAction('wait', { duration: Math.min(30, Number(i.seconds)) }),
  },
]

export const TOOL_BY_NAME = new Map([...TOOLS, ...COMPUTER_TOOLS, COMPUTER_TOOL].map((t) => [t.name, t]))

/** Tools that Claude replaces with its own server-side web search and fetch. */
export const CLIENT_WEB_TOOLS = new Set(['web_search', 'fetch_url'])

export const DEFAULT_RULES: Record<ToolRisk, Rule> = {
  read: 'allow',
  write: 'allow',
  execute: 'allow',
  network: 'allow',
  notify: 'allow',
  computer: 'allow',
}

/** Stricter defaults for the few tools that can lose work or act on their own. */
const TOOL_DEFAULTS: Record<string, Rule> = {
  delete_file: 'ask',
  schedule_task: 'ask',
}

export function ruleFor(rules: Record<string, Rule>, tool: ToolDef): Rule {
  const name = tool.risk === 'computer' ? COMPUTER_TOOL.name : tool.name
  return rules[name] ?? TOOL_DEFAULTS[name] ?? DEFAULT_RULES[tool.risk]
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
