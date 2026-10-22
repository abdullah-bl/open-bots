import type { PyRequest, PyResponse } from './python.worker'
import type { Workspace } from '../workspace'

const MAX_SYNC_BYTES = 50_000_000

let pyWorker: Worker | null = null
let nextId = 1
const pending = new Map<number, (r: PyResponse) => void>()

function worker() {
  if (!pyWorker) {
    pyWorker = new Worker(new URL('./python.worker.ts', import.meta.url), { type: 'module' })
    pyWorker.onmessage = (e: MessageEvent<PyResponse>) => {
      pending.get(e.data.id)?.(e.data)
      pending.delete(e.data.id)
    }
  }
  return pyWorker
}

/** Hard-stops Python; the next run starts a fresh interpreter. */
function killPython() {
  pyWorker?.terminate()
  pyWorker = null
  for (const [id, resolve] of pending) {
    resolve({ id, ok: false, stdout: '', stderr: '', error: 'Python was stopped', changed: [] })
  }
  pending.clear()
}

export interface RunResult {
  ok: boolean
  output: string
  changedFiles: string[]
}

/** Runs Python with the bot's workspace mounted at /workspace (the working directory). */
export async function runPython(code: string, ws: Workspace, signal: AbortSignal, timeoutMs = 120_000): Promise<RunResult> {
  const files: PyRequest['files'] = []
  let total = 0
  for (const f of await ws.list()) {
    total += f.size
    if (total > MAX_SYNC_BYTES) break
    files.push({ path: f.path, data: await ws.readBytes(f.path) })
  }

  const id = nextId++
  const res = await new Promise<PyResponse>((resolve) => {
    const timer = setTimeout(killPython, timeoutMs)
    const onAbort = () => killPython()
    signal.addEventListener('abort', onAbort, { once: true })
    pending.set(id, (r) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(r)
    })
    worker().postMessage({ id, code, files } satisfies PyRequest)
  })

  for (const f of res.changed) await ws.write(f.path, f.data)

  const parts = [] as string[]
  if (res.stdout.trim()) parts.push(res.stdout.trimEnd())
  if (res.stderr.trim()) parts.push(`[stderr]\n${res.stderr.trimEnd()}`)
  if (res.result) parts.push(`[result] ${res.result}`)
  if (res.error) parts.push(`[error]\n${res.error}`)
  if (res.changed.length) parts.push(`[files written] ${res.changed.map((f) => f.path).join(', ')}`)
  return { ok: res.ok, output: parts.join('\n\n') || '(no output)', changedFiles: res.changed.map((f) => f.path) }
}
