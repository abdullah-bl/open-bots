// Python (Pyodide = CPython compiled to WebAssembly) in its own worker. The
// bot's files are copied into /workspace before a run, and anything the code
// creates or changes there is sent back so it lands in the bot's workspace.

const PYODIDE_URL = 'https://cdn.jsdelivr.net/pyodide/v314.0.7/full/'

interface Pyodide {
  FS: {
    mkdirTree(p: string): void
    writeFile(p: string, d: Uint8Array): void
    readFile(p: string): Uint8Array
    readdir(p: string): string[]
    stat(p: string): { mode: number; mtime: number | Date }
    isDir(mode: number): boolean
    rmdir(p: string): void
    unlink(p: string): void
    chdir(p: string): void
  }
  setStdout(o: { batched: (s: string) => void }): void
  setStderr(o: { batched: (s: string) => void }): void
  loadPackagesFromImports(code: string, opts?: { messageCallback?: (m: string) => void }): Promise<void>
  runPythonAsync(code: string): Promise<unknown>
}

export interface PyRequest {
  id: number
  code: string
  files: { path: string; data: Uint8Array }[]
}

export interface PyResponse {
  id: number
  ok: boolean
  stdout: string
  stderr: string
  result?: string
  error?: string
  changed: { path: string; data: Uint8Array }[]
}

let pyodide: Promise<Pyodide> | null = null

function load() {
  pyodide ??= (async () => {
    const mod = (await import(/* @vite-ignore */ `${PYODIDE_URL}pyodide.mjs`)) as {
      loadPyodide(o: { indexURL: string }): Promise<Pyodide>
    }
    const py = await mod.loadPyodide({ indexURL: PYODIDE_URL })
    // Headless plotting so matplotlib can savefig() into the workspace.
    await py.runPythonAsync('import os\nos.environ["MPLBACKEND"] = "Agg"')
    return py
  })()
  return pyodide
}

function listFiles(py: Pyodide, dir: string, prefix = ''): string[] {
  const out: string[] = []
  for (const name of py.FS.readdir(dir)) {
    if (name === '.' || name === '..') continue
    const full = `${dir}/${name}`
    if (py.FS.isDir(py.FS.stat(full).mode)) out.push(...listFiles(py, full, `${prefix}${name}/`))
    else out.push(prefix + name)
  }
  return out
}

function resetDir(py: Pyodide, dir: string) {
  try {
    for (const name of py.FS.readdir(dir)) {
      if (name === '.' || name === '..') continue
      const full = `${dir}/${name}`
      if (py.FS.isDir(py.FS.stat(full).mode)) {
        resetDir(py, full)
        py.FS.rmdir(full)
      } else py.FS.unlink(full)
    }
  } catch {
    py.FS.mkdirTree(dir)
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

self.onmessage = async (e: MessageEvent<PyRequest>) => {
  const { id, code, files } = e.data
  let stdout = ''
  let stderr = ''
  const reply = (r: Omit<PyResponse, 'id' | 'stdout' | 'stderr'>) =>
    (self as unknown as Worker).postMessage({ id, stdout, stderr, ...r } satisfies PyResponse)

  try {
    const py = await load()
    py.setStdout({ batched: (s) => (stdout += s + '\n') })
    py.setStderr({ batched: (s) => (stderr += s + '\n') })

    resetDir(py, '/workspace')
    const before = new Map<string, Uint8Array>()
    for (const f of files) {
      const full = `/workspace/${f.path}`
      py.FS.mkdirTree(full.slice(0, full.lastIndexOf('/')))
      py.FS.writeFile(full, f.data)
      before.set(f.path, f.data)
    }
    py.FS.chdir('/workspace')

    await py.loadPackagesFromImports(code, { messageCallback: () => {} })
    const result = await py.runPythonAsync(code)

    const changed: PyResponse['changed'] = []
    for (const path of listFiles(py, '/workspace')) {
      const data = py.FS.readFile(`/workspace/${path}`)
      const old = before.get(path)
      if (!old || !sameBytes(old, data)) changed.push({ path, data })
    }
    reply({ ok: true, result: result === undefined || result === null ? undefined : String(result), changed })
  } catch (err) {
    reply({ ok: false, error: err instanceof Error ? err.message : String(err), changed: [] })
  }
}
