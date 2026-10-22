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

/**
 * Runs JavaScript in a throwaway worker: no DOM, no access to the app, killed
 * on timeout. `files` gives read access to the workspace as a plain object.
 */
export async function runJavaScript(code: string, ws: Workspace, signal: AbortSignal, timeoutMs = 30_000): Promise<RunResult> {
  const files: Record<string, string> = {}
  for (const f of await ws.list()) {
    if (f.size < 2_000_000) files[f.path] = await ws.readText(f.path).catch(() => '')
  }
  const src = `
    const logs = [];
    const fmt = (v) => typeof v === 'string' ? v : (() => { try { return JSON.stringify(v, null, 2) } catch { return String(v) } })();
    console.log = console.info = console.warn = console.error = (...a) => logs.push(a.map(fmt).join(' '));
    self.onmessage = async (e) => {
      const files = e.data.files;
      const written = {};
      const writeFile = (path, text) => { written[path] = String(text) };
      try {
        const AsyncFunction = (async () => {}).constructor;
        const result = await new AsyncFunction('files', 'writeFile', e.data.code)(files, writeFile);
        postMessage({ ok: true, logs, result: result === undefined ? undefined : fmt(result), written });
      } catch (err) {
        postMessage({ ok: false, logs, error: String(err && err.stack || err), written });
      }
    };`
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))
  const w = new Worker(url)
  type JsReply = { ok: boolean; logs: string[]; result?: string; error?: string; written: Record<string, string> }
  const res = await new Promise<JsReply>((resolve) => {
    const done = (r: JsReply) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      w.terminate()
      URL.revokeObjectURL(url)
      resolve(r)
    }
    const timer = setTimeout(() => done({ ok: false, logs: [], error: `Timed out after ${timeoutMs / 1000}s`, written: {} }), timeoutMs)
    const onAbort = () => done({ ok: false, logs: [], error: 'Stopped', written: {} })
    signal.addEventListener('abort', onAbort, { once: true })
    w.onmessage = (e: MessageEvent<JsReply>) => done(e.data)
    w.onerror = (e) => done({ ok: false, logs: [], error: e.message, written: {} })
    w.postMessage({ code, files })
  })

  const changed = Object.keys(res.written)
  for (const path of changed) await ws.write(path, res.written[path])
  const parts = [] as string[]
  if (res.logs.length) parts.push(res.logs.join('\n'))
  if (res.result !== undefined) parts.push(`[result] ${res.result}`)
  if (res.error) parts.push(`[error]\n${res.error}`)
  if (changed.length) parts.push(`[files written] ${changed.join(', ')}`)
  return { ok: res.ok, output: parts.join('\n\n') || '(no output)', changedFiles: changed }
}
