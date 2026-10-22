/**
 * Each bot's "computer" is a folder in the browser's Origin Private File
 * System: real files that persist, never leave the device, and that Python
 * and JS tools can read and write.
 */

export interface FileInfo {
  path: string
  size: number
  modified: number
}

const ROOT = 'bots'

/** Normalizes a model-supplied path and refuses anything that escapes the workspace. */
export function cleanPath(p: string): string {
  const parts: string[] = []
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') throw new Error(`Path "${p}" leaves the workspace`)
    parts.push(seg)
  }
  if (!parts.length) throw new Error('Empty path')
  return parts.join('/')
}

async function botDir(botId: string, create = true) {
  const root = await navigator.storage.getDirectory()
  const bots = await root.getDirectoryHandle(ROOT, { create })
  return bots.getDirectoryHandle(botId, { create })
}

async function walk(path: string[], dir: FileSystemDirectoryHandle, create: boolean) {
  let d = dir
  for (const seg of path) d = await d.getDirectoryHandle(seg, { create })
  return d
}

export class Workspace {
  readonly botId: string

  constructor(botId: string) {
    this.botId = botId
  }

  private async parentOf(path: string, create: boolean) {
    const parts = cleanPath(path).split('/')
    const name = parts.pop()!
    const dir = await walk(parts, await botDir(this.botId), create)
    return { dir, name }
  }

  async list(): Promise<FileInfo[]> {
    const out: FileInfo[] = []
    const visit = async (dir: FileSystemDirectoryHandle, prefix: string) => {
      for await (const [name, handle] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
        if (handle.kind === 'directory') await visit(handle as FileSystemDirectoryHandle, `${prefix}${name}/`)
        else {
          const f = await (handle as FileSystemFileHandle).getFile()
          out.push({ path: prefix + name, size: f.size, modified: f.lastModified })
        }
      }
    }
    await visit(await botDir(this.botId), '')
    return out.sort((a, b) => a.path.localeCompare(b.path))
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const { dir, name } = await this.parentOf(path, false)
    const file = await (await dir.getFileHandle(name)).getFile()
    return new Uint8Array(await file.arrayBuffer())
  }

  async readText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readBytes(path))
  }

  async readBlob(path: string): Promise<Blob> {
    const { dir, name } = await this.parentOf(path, false)
    return (await dir.getFileHandle(name)).getFile()
  }

  async write(path: string, data: string | Uint8Array | Blob) {
    const { dir, name } = await this.parentOf(path, true)
    const handle = await dir.getFileHandle(name, { create: true })
    const w = await handle.createWritable()
    await w.write(data as FileSystemWriteChunkType)
    await w.close()
  }

  async remove(path: string) {
    const { dir, name } = await this.parentOf(path, false)
    await dir.removeEntry(name, { recursive: true })
  }

  /** Deletes the whole workspace (used when a bot is deleted). */
  async destroy() {
    const root = await navigator.storage.getDirectory()
    const bots = await root.getDirectoryHandle(ROOT, { create: true })
    await bots.removeEntry(this.botId, { recursive: true }).catch(() => {})
  }
}

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|ya?ml|xml|html?|css|js|mjs|ts|tsx|jsx|py|sh|sql|log|ini|toml|svg)$/i

export function isTextFile(path: string) {
  return TEXT_EXT.test(path)
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 ** 2).toFixed(1)} MB`
}
