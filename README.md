# open-bot

**Agents that live in your browser.** Give a bot a goal and it plans, searches the web, reads pages, writes files, runs Python, remembers what matters, and works on a schedule, showing every step as it goes.

It's in the same family as xAI's Grok Bot and OpenAI's Dots, with one difference: there's no cloud computer. The bot's computer is **your browser**.

| | Hosted agents | open-bot |
|---|---|---|
| Computer | A VM on the vendor's servers | A private workspace in your browser (OPFS), with Python and JS in WebAssembly sandboxes |
| Model | The vendor's | Any: Claude, Grok, OpenAI, Groq, OpenRouter, Ollama, or fully on-device (WebGPU / WASM) |
| Control | Vendor policy | Per-bot rules for every tool: **Allow**, **Ask** (approve in the timeline), or **Block** |
| Data | Their servers | Your device, your keys |

```bash
npm install
npm run dev          # http://localhost:5173
```

Pick a model in Settings, then create a bot from a template. If you already run [Ollama](https://ollama.com), choose "Ollama (this computer)" for a free, key-less setup.

## What a bot can do

| Tool | What it does | Default rule |
|---|---|---|
| `list_files` `read_file` `write_file` | Work with files in the bot's private workspace | Allow |
| `delete_file` | Remove workspace files | **Ask** |
| `run_python` | CPython (Pyodide) in a worker: numpy, pandas and matplotlib load on import, and the workspace is the working directory | Allow |
| `run_javascript` | Code in a throwaway worker with a 30 s limit and no DOM | **Ask** |
| `web_search` `fetch_url` | Web search and readable page text through the proxy (Claude uses its own server-side search and fetch instead) | Allow |
| `remember` | Long-term memory, shown to the bot at the start of each thread | Allow |
| `schedule_task` `list_schedules` `cancel_schedule` | The bot schedules itself (every N minutes, or daily at a time) | **Ask** |
| `notify_user` | Desktop notification, for example when a scheduled run finishes | Allow |

Each bot has a **Workspace** panel with tabs for files (preview, download, drag-and-drop upload), memory, schedules, rules and setup. In the sidebar, a bot's dot breathes while it works and gets a ring when it needs your OK.

## How it works

```
Bot ── thread (append-only) ──► runner ──► model adapter ──► Claude (Anthropic SDK, adaptive thinking, server web tools)
          │                       │                      └─► OpenAI-style: Grok, OpenAI, Groq, OpenRouter, Ollama, wllama
          │                       └─► tools ──► OPFS workspace · Pyodide worker · JS worker · /api proxy · memory · schedules
          └─ scheduler (in the tab) fires due schedules and catches up on missed runs when the app reopens
```

- `src/agent/runner.ts` is the loop: model step → rule check (and approval if needed) → run tools → feed results back, for up to 30 steps.
- `src/agent/models.ts` converts the thread to each provider's format. Threads are **append-only**, and each thread's system prompt and tool list are fixed when it starts. That keeps prompt caches warm and keeps Claude's reasoning blocks valid across turns. Editing a bot's goal, instructions or memory takes effect when you start a new thread.
- `src/lib/providers/local.ts` handles on-device models: WebLLM on WebGPU, or wllama (llama.cpp → WASM, multi-threaded) on the CPU. The CPU engine supports tool calls, but small models are weak at them. Use a cloud model or Ollama for real agent work.
- `server/proxy.ts` is the only server code. It's a plain fetch handler for `/api/fetch` (blocks private addresses) and `/api/search`. It runs inside the Vite dev server, or as a Cloudflare Worker (`server/worker.ts`).

## Configuration

Web search for non-Claude models uses the first of these that's configured, set in `.env.local`:

```bash
BRAVE_API_KEY=...                 # Brave Search API
SEARXNG_URL=https://searx.example # or a SearXNG instance
# neither set: falls back to Wikipedia search
```

## Deploying

- Serve the built `dist/` with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless`. The CPU engine needs these headers to use more than one thread.
- Deploy `server/worker.ts` on the same origin, under `/api/*`.
- API keys are stored in the browser and sent straight to each provider. That's fine for personal use; a shared deployment should keep cloud keys in the proxy instead.

## Limits

- Schedules only run while open-bot is open in a tab (pin it). Runs missed while it was closed happen when it reopens.
- Bots can't drive other websites (clicking or logging in). That would need a browser-extension build, which is on the roadmap.

## Roadmap

- Browser extension build: let a bot read and act on the page you're viewing
- Chat with your files: chunking and a vector index in a Rust crate compiled to WASM, with local embeddings
- MCP client, so bots can use your existing tool servers
- Voice: Whisper speech-to-text and text-to-speech, in the browser
- Multi-bot teams: one bot hands sub-tasks to others
