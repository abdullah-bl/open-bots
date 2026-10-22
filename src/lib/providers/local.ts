// Both engines are large, so each is imported only once a local model is used.
import type { WebWorkerMLCEngine } from '@mlc-ai/web-llm'
import type { Wllama } from '@wllama/wllama'

/**
 * Two on-device engines:
 * - gpu: WebLLM (MLC) on WebGPU. Fast, needs a real GPU adapter.
 * - cpu: wllama, llama.cpp compiled to WebAssembly (SIMD + threads). Runs anywhere.
 */
export type Backend = 'gpu' | 'cpu'

export interface LocalModel {
  id: string
  label: string
  note: string
  /** GPU models: VRAM needed. CPU models: download size. */
  sizeMB: number
  /** Qwen-style models that can write <think> reasoning. */
  thinks: boolean
  hf?: { repo: string; file: string }
}

export const GPU_MODELS: LocalModel[] = [
  { id: 'Qwen3.5-2B-q4f16_1-MLC', label: 'Qwen 3.5 2B', note: 'Balanced default', sizeMB: 2245, thinks: true },
  { id: 'Qwen3.5-4B-q4f16_1-MLC', label: 'Qwen 3.5 4B', note: 'Smarter, needs a good GPU', sizeMB: 3867, thinks: true },
  { id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 3B', note: 'Solid all-rounder', sizeMB: 2263, thinks: false },
  { id: 'gemma-4-E2B-it-q4f16_1-MLC', label: 'Gemma 4 E2B', note: "Google's small model", sizeMB: 3387, thinks: false },
  { id: 'Qwen3-0.6B-q4f16_1-MLC', label: 'Qwen 3 0.6B', note: 'Fast, low memory', sizeMB: 1403, thinks: true },
  { id: 'SmolLM2-360M-Instruct-q4f16_1-MLC', label: 'SmolLM2 360M', note: 'Tiny, for testing', sizeMB: 376, thinks: false },
]

export const CPU_MODELS: LocalModel[] = [
  {
    id: 'qwen3-0.6b-q4km',
    label: 'Qwen 3 0.6B',
    note: 'Best default on CPU',
    sizeMB: 397,
    thinks: true,
    hf: { repo: 'unsloth/Qwen3-0.6B-GGUF', file: 'Qwen3-0.6B-Q4_K_M.gguf' },
  },
  {
    id: 'llama3.2-1b-q4km',
    label: 'Llama 3.2 1B',
    note: 'Good chat quality',
    sizeMB: 808,
    thinks: false,
    hf: { repo: 'bartowski/Llama-3.2-1B-Instruct-GGUF', file: 'Llama-3.2-1B-Instruct-Q4_K_M.gguf' },
  },
  {
    id: 'gemma3-1b-q4km',
    label: 'Gemma 3 1B',
    note: "Google's small model",
    sizeMB: 806,
    thinks: false,
    hf: { repo: 'ggml-org/gemma-3-1b-it-GGUF', file: 'gemma-3-1b-it-Q4_K_M.gguf' },
  },
  {
    id: 'qwen3-1.7b-q4km',
    label: 'Qwen 3 1.7B',
    note: 'Smarter, slower on CPU',
    sizeMB: 1107,
    thinks: true,
    hf: { repo: 'unsloth/Qwen3-1.7B-GGUF', file: 'Qwen3-1.7B-Q4_K_M.gguf' },
  },
  {
    id: 'smollm2-360m-q8',
    label: 'SmolLM2 360M',
    note: 'Tiny, for testing',
    sizeMB: 386,
    thinks: false,
    hf: { repo: 'HuggingFaceTB/SmolLM2-360M-Instruct-GGUF', file: 'smollm2-360m-instruct-q8_0.gguf' },
  },
]

export const ALL_LOCAL_MODELS = [...GPU_MODELS, ...CPU_MODELS]

export type LocalStatus =
  | { state: 'detecting' }
  | { state: 'idle'; backend: Backend }
  | { state: 'loading'; backend: Backend; modelId: string; progress: number; text: string }
  | { state: 'ready'; backend: Backend; modelId: string }
  | { state: 'error'; backend: Backend; modelId: string; message: string }

type Listener = (s: LocalStatus) => void

async function detectBackend(): Promise<Backend> {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
    if (gpu && (await gpu.requestAdapter())) return 'gpu'
  } catch {
    // Fall through to CPU.
  }
  return 'cpu'
}

/** Owns the single on-device engine (one model in memory at a time). */
class LocalEngine {
  private webllm: WebWorkerMLCEngine | null = null
  private webllmWorker: Worker | null = null
  private wllama: Wllama | null = null
  private listeners = new Set<Listener>()
  backend: Backend = 'cpu'
  status: LocalStatus = { state: 'detecting' }
  readonly ready: Promise<Backend>

  constructor() {
    this.ready = detectBackend().then((b) => {
      this.backend = b
      this.set({ state: 'idle', backend: b })
      return b
    })
  }

  models() {
    return this.backend === 'gpu' ? GPU_MODELS : CPU_MODELS
  }

  /** The chosen model if it belongs to this backend, else the backend's default. */
  pick(modelId: string) {
    const list = this.models()
    return list.find((m) => m.id === modelId) ?? list[0]
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private set(s: LocalStatus) {
    this.status = s
    this.listeners.forEach((fn) => fn(s))
  }

  /** Resolves once any in-progress load finishes, successfully or not. */
  settled(): Promise<void> {
    if (this.status.state !== 'loading' && this.status.state !== 'detecting') return Promise.resolve()
    return new Promise((resolve) => {
      const off = this.subscribe((s) => {
        if (s.state !== 'loading' && s.state !== 'detecting') {
          off()
          resolve()
        }
      })
    })
  }

  async isCached(modelId: string): Promise<boolean> {
    await this.ready
    const model = ALL_LOCAL_MODELS.find((m) => m.id === modelId)
    if (!model) return false
    if (!model.hf) {
      const { hasModelInCache } = await import('@mlc-ai/web-llm')
      return hasModelInCache(modelId)
    }
    const { ModelManager } = await import('@wllama/wllama')
    const cached = await (this.wllama?.modelManager ?? new ModelManager()).getModels()
    return cached.some((m) => m.url.includes(model.hf!.repo) && m.url.endsWith(model.hf!.file))
  }

  async load(modelId: string) {
    const backend = await this.ready
    const model = this.pick(modelId)
    if (this.status.state === 'ready' && this.status.modelId === model.id) return
    await this.unload()
    const progress = (p: number, text: string) =>
      this.set({ state: 'loading', backend, modelId: model.id, progress: p, text })
    progress(0, 'Starting…')
    try {
      if (backend === 'gpu') {
        const { CreateWebWorkerMLCEngine } = await import('@mlc-ai/web-llm')
        this.webllmWorker = new Worker(new URL('../workers/webllm.worker.ts', import.meta.url), { type: 'module' })
        this.webllm = await CreateWebWorkerMLCEngine(this.webllmWorker, model.id, {
          initProgressCallback: (r) => progress(r.progress, r.text),
        })
      } else {
        const { Wllama } = await import('@wllama/wllama')
        const { default: wasmUrl } = await import('@wllama/wllama/esm/wasm/wllama.wasm?url')
        this.wllama = new Wllama({ default: wasmUrl }, { suppressNativeLog: true })
        await this.wllama.loadModelFromHF(model.hf!, {
          n_ctx: 4096,
          n_gpu_layers: 0,
          // Keep <think> tags inline so the same splitter handles both engines.
          reasoning_format: 'none',
          progressCallback: ({ loaded, total }) =>
            loaded >= total
              ? progress(1, 'Loading into memory…')
              : progress(total ? loaded / total : 0, `Downloading ${mb(loaded)} of ${mb(total)}`),
        })
      }
      this.set({ state: 'ready', backend, modelId: model.id })
    } catch (err) {
      await this.unload(false)
      this.set({ state: 'error', backend, modelId: model.id, message: err instanceof Error ? err.message : String(err) })
    }
  }

  async unload(announce = true) {
    await this.webllm?.unload().catch(() => {})
    this.webllmWorker?.terminate()
    await this.wllama?.exit().catch(() => {})
    this.webllm = null
    this.webllmWorker = null
    this.wllama = null
    if (announce) this.set({ state: 'idle', backend: this.backend })
  }

  /** Threads in use by the CPU engine (needs cross-origin isolation for more than one). */
  cpuThreads() {
    return this.wllama?.isMultithread() ? navigator.hardwareConcurrency : 1
  }

  /**
   * Streaming chat for the agent loop, in OpenAI chunk shape. llama.cpp (CPU)
   * understands tool calls; WebLLM's prebuilt models run the agent without tools.
   */
  agentStream() {
    if (this.status.state !== 'ready') return null
    const modelId = this.status.modelId
    const model = ALL_LOCAL_MODELS.find((m) => m.id === modelId)!
    const wllama = this.wllama
    const webllm = this.webllm
    type Params = { messages: unknown[]; tools?: unknown[] }
    if (wllama) {
      return {
        tools: true,
        fn: (p: Params, signal: AbortSignal) =>
          wllama.createChatCompletion({
            stream: true,
            messages: p.messages as never,
            tools: p.tools as never,
            max_tokens: 2048,
            abortSignal: signal,
            // Reasoning on a CPU is slow; agent runs skip it.
            ...(model.thinks ? { chat_template_kwargs: { enable_thinking: false } } : {}),
          }) as never,
      }
    }
    if (webllm) {
      return {
        tools: false,
        fn: async (p: Params, signal: AbortSignal) => {
          signal.addEventListener('abort', () => webllm.interruptGenerate(), { once: true })
          return webllm.chat.completions.create({
            stream: true,
            messages: flattenToolTurns(p.messages) as never,
            ...(model.thinks ? { extra_body: { enable_thinking: false } } : {}),
          }) as never
        },
      }
    }
    return null
  }
}

/** WebLLM accepts only system/user/assistant text, so earlier tool steps become plain text. */
function flattenToolTurns(messages: unknown[]) {
  const out: { role: string; content: string }[] = []
  for (const raw of messages as { role: string; content?: string | null; tool_calls?: { function: { name: string } }[] }[]) {
    const role = raw.role === 'tool' ? 'user' : raw.role
    let content = raw.content ?? ''
    if (raw.role === 'tool') content = `Tool result:\n${content}`
    if (raw.tool_calls?.length) content += `\n(Called tools: ${raw.tool_calls.map((c) => c.function.name).join(', ')})`
    const last = out[out.length - 1]
    if (last && last.role === role && role !== 'system') last.content += `\n\n${content}`
    else out.push({ role, content })
  }
  return out
}

function mb(bytes: number) {
  return `${Math.round(bytes / 1e6)} MB`
}

export const localEngine = new LocalEngine()

/**
 * Qwen-style models write reasoning inline as <think>…</think>. This splits the
 * stream into thinking and answer chunks, even when a tag is cut across chunks.
 */
export type Chunk = { type: 'text' | 'thinking'; text: string }

export class ThinkTagSplitter {
  // A semicolon keeps `false` and `*push` from parsing as a multiplication.
  private buf = ''
  private inThink = false;

  *push(text: string): Generator<Chunk> {
    this.buf += text
    while (this.buf) {
      const tag = this.inThink ? '</think>' : '<think>'
      const at = this.buf.indexOf(tag)
      if (at >= 0) {
        if (at > 0) yield this.chunk(this.buf.slice(0, at))
        this.buf = this.buf.slice(at + tag.length)
        this.inThink = !this.inThink
        continue
      }
      // Hold back a possible partial tag at the end of the buffer.
      const keep = partialSuffix(this.buf, tag)
      const out = this.buf.slice(0, this.buf.length - keep)
      if (out) yield this.chunk(out)
      this.buf = this.buf.slice(this.buf.length - keep)
      return
    }
  }

  *flush(): Generator<Chunk> {
    if (this.buf) yield this.chunk(this.buf)
    this.buf = ''
  }

  private chunk(text: string): Chunk {
    return { type: this.inThink ? 'thinking' : 'text', text }
  }
}

function partialSuffix(s: string, tag: string) {
  for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) {
    if (s.endsWith(tag.slice(0, n))) return n
  }
  return 0
}
