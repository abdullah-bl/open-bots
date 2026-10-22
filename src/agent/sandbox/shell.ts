// A real Unix shell compiled to WebAssembly (Wasmer + WASIX): bash, coreutils,
// and any package from the Wasmer registry, running in workers in this tab.
// Each bot gets one long-lived sandbox; its OPFS workspace is copied into
// /workspace before a command and changes are copied back after.
import type { Sandbox, Wasmer as WasmerClient } from '@wasmer/sdk/browser'
import type { Workspace } from '../workspace'
import { wispUrl } from '../../lib/settings'

/** bash first: it is the sandbox's shell. */
const BASE_PACKAGES = ['wasmer/bash', 'wasmer/coreutils', 'wasmer/grep', 'wasmer/sed']
const OUTPUT_LIMIT = 30_000
const MAX_SYNC_BYTES = 50_000_000

let client: Promise<WasmerClient> | null = null
let internet = true

/** Internet for new sandboxes; existing ones are closed so the next command picks it up. */
export function setShellInternet(on: boolean) {
  if (on === internet) return
  internet = on
  for (const botId of [...shells.keys()]) void closeShell(botId)
}

function wasmer() {
  client ??= import('@wasmer/sdk/browser').then(({ Wasmer }) => new Wasmer().ready())
  return client
}

interface BotShell {
  sandbox: Promise<Sandbox>
  installed: Set<string>
  /** Path -> size + last-modified of what the sandbox holds, to skip unchanged files. */
  synced: Map<string, string>
}

const shells = new Map<string, BotShell>()

function shellFor(botId: string, onProgress?: (msg: string) => void): BotShell {
  let s = shells.get(botId)
  if (!s) {
    s = {
      sandbox: wasmer().then(async (w) => {
        const pkgs = await w.packages.loadMany(BASE_PACKAGES, {
          onProgress: (p) => {
            if (p.phase === 'downloading' && typeof p.download.percent === 'number') {
              onProgress?.(`Downloading the shell (${Math.round(p.download.percent)}%)`)
            }
          },
        })
        return w.sandboxes.create({
          packages: pkgs,
          // Other packages (Python, for one) ship their own bash; always use this one.
          shell: pkgs[0].command('bash'),
          env: { HOME: '/workspace', TERM: 'dumb', LANG: 'C.UTF-8' },
          // TCP goes through our WISP relay (public addresses only); names resolve over DNS-over-HTTPS.
          network: internet ? { mode: 'wisp', url: wispUrl() } : { mode: 'disabled' },
        })
      }),
      installed: new Set(BASE_PACKAGES),
      synced: new Map(),
    }
    // A failed start should be retried next time, not cached.
    s.sandbox.catch(() => shells.delete(botId))
    shells.set(botId, s)
  }
  return s
}

async function listSandbox(sb: Sandbox, dir: string, prefix = ''): Promise<{ path: string; size: number }[]> {
  const out: { path: string; size: number }[] = []
  for (const e of await sb.fs.readDir(dir)) {
    if (e.name === '.' || e.name === '..') continue
    if (e.kind === 'directory') out.push(...(await listSandbox(sb, `${dir}/${e.name}`, `${prefix}${e.name}/`)))
    else out.push({ path: prefix + e.name, size: e.size })
  }
  return out
}

function parentDir(path: string) {
  const i = path.lastIndexOf('/')
  return i > 0 ? path.slice(0, i) : null
}

export interface ShellResult {
  ok: boolean
  output: string
  exitCode: number
  changedFiles: string[]
}

/**
 * Runs a bash command in the bot's sandbox with its workspace mounted at
 * /workspace (the working directory). `packages` adds Wasmer registry packages
 * (e.g. "python/python", "sqlite/sqlite") for this and later commands.
 */
export async function runShell(
  command: string,
  ws: Workspace,
  opts: { packages?: string[]; signal: AbortSignal; timeoutMs?: number; onProgress?: (msg: string) => void },
): Promise<ShellResult> {
  const shell = shellFor(ws.botId, opts.onProgress)
  const sb = await shell.sandbox

  for (const pkg of opts.packages ?? []) {
    if (shell.installed.has(pkg)) continue
    opts.onProgress?.(`Installing ${pkg}`)
    await sb.installPackage(pkg, { signal: opts.signal })
    shell.installed.add(pkg)
  }

  // Workspace -> sandbox, skipping files the sandbox already has.
  const wsFiles = await ws.list()
  const wsPaths = new Set(wsFiles.map((f) => f.path))
  let total = 0
  for (const f of wsFiles) {
    total += f.size
    if (total > MAX_SYNC_BYTES) break
    const stamp = `${f.size}:${f.modified}`
    if (shell.synced.get(f.path) === stamp) continue
    const dir = parentDir(f.path)
    if (dir) await sb.fs.mkdir(`/workspace/${dir}`, { recursive: true })
    await sb.fs.writeFile(`/workspace/${f.path}`, await ws.readBytes(f.path))
    shell.synced.set(f.path, stamp)
  }
  // Files the user deleted from the workspace disappear from the sandbox too.
  for (const path of [...shell.synced.keys()]) {
    if (!wsPaths.has(path)) {
      await sb.fs.remove(`/workspace/${path}`).catch(() => {})
      shell.synced.delete(path)
    }
  }
  const before = new Map<string, number>()
  for (const f of await listSandbox(sb, '/workspace')) before.set(f.path, f.size)

  opts.onProgress?.('Running')
  const output = await sb.shell(command, { cwd: '/workspace' }).run({
    check: false,
    timeoutMs: opts.timeoutMs ?? 120_000,
    outputBytes: OUTPUT_LIMIT * 2,
  })

  // Sandbox -> workspace: new, grown, shrunk or rewritten files, and deletions.
  const changed: string[] = []
  const after = await listSandbox(sb, '/workspace')
  const afterPaths = new Set(after.map((f) => f.path))
  for (const f of after) {
    const data = await sb.fs.readFile(`/workspace/${f.path}`)
    const known = shell.synced.has(f.path) && before.get(f.path) === f.size
    if (known && wsPaths.has(f.path)) {
      // Same size as before: compare bytes to catch in-place rewrites.
      const old = await ws.readBytes(f.path)
      if (old.length === data.length && old.every((b, i) => b === data[i])) continue
    }
    await ws.write(f.path, data)
    changed.push(f.path)
  }
  for (const path of before.keys()) {
    if (!afterPaths.has(path) && wsPaths.has(path)) {
      await ws.remove(path).catch(() => {})
      changed.push(`${path} (deleted)`)
      shell.synced.delete(path)
    }
  }
  // Re-stamp everything so the next run only copies what changed in OPFS.
  for (const f of await ws.list()) shell.synced.set(f.path, `${f.size}:${f.modified}`)

  const parts: string[] = []
  const stdout = output.stdout.text()
  const stderr = output.stderr.text()
  if (stdout.trim()) parts.push(clip(stdout.trimEnd()))
  if (stderr.trim()) parts.push(`[stderr]\n${clip(stderr.trimEnd())}`)
  if (output.reason === 'timeout') parts.push('[timed out]')
  parts.push(`[exit ${output.exitCode}]`)
  if (changed.length) parts.push(`[files changed] ${changed.join(', ')}`)
  return { ok: output.ok, output: parts.join('\n\n'), exitCode: output.exitCode, changedFiles: changed }
}

function clip(s: string) {
  return s.length > OUTPUT_LIMIT ? `${s.slice(0, OUTPUT_LIMIT)}\n…[output truncated]` : s
}

/** Forgets a bot's sandbox (when the bot is deleted). */
export async function closeShell(botId: string) {
  const s = shells.get(botId)
  shells.delete(botId)
  await (await s?.sandbox.catch(() => null))?.close()
}
