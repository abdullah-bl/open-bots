# open-bot

**Agents that live in your browser.** Give a bot a goal and it plans, searches the web, reads pages, writes files, runs Python, remembers what matters, and works on a schedule, showing every step as it goes.

It's in the same family as xAI's Grok Bot and OpenAI's Dots, with one difference: there's no cloud computer. The bot's computer is **your browser**.

| | Hosted agents | open-bot |
|---|---|---|
| Computer | A VM on the vendor's servers | A private workspace in your browser (OPFS), with a real Unix shell (bash, Python, SQLite, Node) and scientific Python compiled to WebAssembly |
| Model | The vendor's | Any: Claude, Grok, NVIDIA, OpenAI, Groq, OpenRouter, Ollama, any OpenAI-compatible endpoint, or fully on-device (WebGPU / WASM) |
| Control | Vendor policy | Per-bot rules for every tool: **Allow**, **Ask** (approve in the timeline), or **Block** |
| Data | Their servers | Your device, your keys |

```bash
npm install
npm run vm:fetch     # once: Tiny Core Linux + BIOS for the in-browser computer (~20 MB)
npm run dev          # http://localhost:5173
```

Pick a model in Settings, then create a bot from a template. If you already run [Ollama](https://ollama.com), choose "Ollama (this computer)" for a free, key-less setup.

## Bots have faces

Every bot has an animated avatar in its own color: a little robot whose head, eyes and top you can change in its **Setup** tab. Each new bot gets a stable default look. The avatar shows what the bot is doing:
- **Idle:** floats, blinks, and follows your pointer with its eyes.
- **Thinking:** thought dots.
- **Working:** scanning eyes and a glowing antenna.
- **Writing:** its mouth moves while text streams.
- **Needs your OK:** a bouncing "?".
- **Error:** X eyes.
- **Done:** a happy hop.

The open bot's color tints its whole view. Everything respects `prefers-reduced-motion` (`src/components/BotAvatar.tsx`, `src/agent/avatar.ts`).

## Model providers

Claude, xAI, OpenAI, Groq and OpenRouter accept requests straight from the browser. Some providers don't (they send no CORS headers), **NVIDIA** included, along with many self-hosted gateways. For those, open-bot sends calls through its own server at `/api/llm`, which forwards them to the provider's HTTPS base URL and streams the reply back. It's on by default for the NVIDIA preset and for custom endpoints, and can be switched per provider in Settings. The passthrough refuses non-HTTPS and private or local targets, and forwards only API headers (your key, content type), never cookies. Local servers such as Ollama are always called directly.

## What a bot can do

| Tool | What it does | Default rule |
|---|---|---|
| `list_files` `read_file` `write_file` | Work with files in the bot's private workspace | Allow |
| `delete_file` | Remove workspace files | **Ask** |
| `bash` | A Unix shell compiled to WebAssembly (Wasmer + WASIX): bash, coreutils, grep and sed, plus on-demand `python` 3.13, `sqlite`, `node` (EdgeJS, Node 24 compatible), `quickjs`, `ripgrep` and `php`. The workspace is the working directory, and there's no network access | Allow |
| `run_python` | Scientific Python (Pyodide): numpy, pandas and matplotlib load on import, and the workspace is the working directory | Allow |
| `web_search` `fetch_url` | Web search and readable page text through the proxy (Claude uses its own server-side search and fetch instead) | Allow |
| `remember` | Long-term memory, shown to the bot at the start of each thread | Allow |
| `schedule_task` `list_schedules` `cancel_schedule` | The bot schedules itself (every N minutes, or daily at a time) | **Ask** |
| `notify_user` | Desktop notification, for example when a scheduled run finishes | Allow |
| **Computer use** | Screenshots, zoom, clicks, drags, scrolling, typing and key presses on a real Linux desktop (see below). Claude uses its native `computer_toolset_20260801`; other vision models get equivalent `computer_*` tools | Allow (one rule for all actions) |

## The computer

Bots with **Computer use** turned on (Setup tab, or the **Operator** template) share one real computer: **Tiny Core Linux 11** with an X11 desktop, on [v86](https://github.com/copy/v86), an x86 PC emulator compiled to WebAssembly, running in your tab.

- **Boots once, then resumes in about a second.** The first start boots Linux (about 30 s) and saves a snapshot of the whole machine (~180 MB) to browser storage. A snapshot is also saved after every bot run that used the computer and when you press **Stop**, so installed software stays. **Reset to a fresh Linux** throws it away.
- **Internet and a web browser.** The computer has a virtio network card. v86 turns its traffic into WISP streams to open-bot's relay, which connects to public addresses only. Install the browser once with `tce-load -wi netsurf` (about 2 minutes), then run `netsurf-gtk https://…`; bots are told how. Any other Tiny Core package installs the same way.
- **Watch it or drive it.** The **Computer** tab shows the live screen. **Take over** sends your mouse and keyboard to Linux, and **Give control back** returns it to the bot. While a bot works, its latest screenshot also appears in its activity log.
- **How input works.** Screenshots are the emulator's 1024×768 framebuffer. Typing and keys go in as PC scancodes on a US layout. The guest has no absolute-pointer driver, so the mouse is relative PS/2: the pointer is pinned to a corner and then stepped to the target, and that is exact because Tiny Core's X server moves motion events of 4 px or less 1:1 and doubles larger ones. Events are spaced 25 ms apart so the guest never merges them.

Each task shows as a **run**: your message, a collapsible activity log ("Worked for 36s · 3 steps · 1 file") with every command, its code and its output, then the answer with previews of the images it made and chips for the files it wrote. Attach files from the composer (or drop them on it) and they land in the bot's workspace. The **Workspace** panel has tabs for files (preview, download, upload), memory, schedules, rules and setup. In the sidebar, a bot's dot breathes while it works and gets a ring when it needs your OK.

## How it works

```
Bot ── thread (append-only) ──► runner ──► model adapter ──► Claude (Anthropic SDK, adaptive thinking, server web tools)
          │                       │                      └─► OpenAI-style: Grok, OpenAI, Groq, OpenRouter, Ollama, wllama
          │                       └─► tools ──► OPFS workspace · WASIX shell (Wasmer) · Pyodide worker · /api proxy · memory · schedules
          └─ scheduler (in the tab) fires due schedules and catches up on missed runs when the app reopens
```

- `src/agent/runner.ts` is the loop: model step → rule check (and approval if needed) → run tools → feed results back, for up to 30 steps.
- `src/agent/models.ts` converts the thread to each provider's format. Threads are **append-only**, and each thread's system prompt and tool list are fixed when it starts. That keeps prompt caches warm and keeps Claude's reasoning blocks valid across turns. Editing a bot's goal, instructions or memory takes effect when you start a new thread.
- `src/lib/providers/local.ts` handles on-device models: WebLLM on WebGPU, or wllama (llama.cpp → WASM, multi-threaded) on the CPU. The CPU engine supports tool calls, but small models are weak at them. Use a cloud model or Ollama for real agent work.
- `src/computer/` holds the in-browser computer: `vm.ts` (boot, snapshots, screenshots, input), `keys.ts` (scancodes), `actions.ts` (computer-use actions) and `tcpfix.ts` (v86 TCP fix).
- `server/proxy.ts` holds the HTTP endpoints: page fetch, search, and the `/api/llm` provider passthrough. It's a plain fetch handler for `/api/fetch` (blocks private addresses) and `/api/search`. It runs inside the Vite dev server, or as a Cloudflare Worker (`server/worker.ts`).

## Internet for the computer and the shell

`server/wisp.ts` is a [WISP](https://github.com/MercuryWorkshop/wisp-protocol) v1 relay served at `/wisp/` by the dev and preview servers. WISP carries many TCP streams over one WebSocket. The Linux computer (v86) and the shell (Wasmer SDK) both use it, so `curl`, Python's `urllib`, `wget`, `tce-load` and NetSurf all reach the internet.

- **Public addresses only** (`server/netpolicy.ts`): the relay resolves every hostname itself and refuses the connection if *any* address it resolves to is private, loopback, link-local (including cloud metadata at 169.254.169.254), CGNAT, multicast or reserved, for IPv4, IPv6 and IPv4-mapped IPv6. It then connects to the vetted IP, so DNS rebinding can't swap in a private address. Mail ports (25, 465, 587) are blocked, and UDP is allowed for DNS only. The page-fetch proxy (`/api/fetch`) uses the same DNS check and re-checks every redirect hop.
- **DNS** for the computer and the shell is resolved in the browser over HTTPS (Cloudflare), the default for both v86 and the Wasmer SDK.
- **Off switch:** Settings → *Internet for the computer and shell*. The shell then gets no network, and the computer connects to the relay in a mode that refuses every stream (its network card stays, so snapshots remain valid).
- **v86 TCP fix** (`src/computer/tcpfix.ts`): v86's guest-facing TCP is stop-and-wait with no retransmission, so downloads crawled (Linux delays ACKs for single segments) and stalled forever after one lost segment. A runtime patch keeps up to 32 segments in flight and resends after 3 duplicate ACKs or 250 ms without progress. A 2.4 MB download went from 63 s to 6 s, and the NetSurf install from over 10 minutes to about 2.

The relay runs inside Node (Vite dev/preview). The Cloudflare Worker in `server/worker.ts` still serves `/api/*` only; a Worker WISP relay using `connect()` is future work.

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
- Shell packages download from the Wasmer registry the first time a bot uses them, then come from the browser cache.
- The in-Linux browser is NetSurf 3.9: good for reading and simple sites, without full modern JavaScript.

## Roadmap

- WISP relay as a Cloudflare Worker (`connect()` sockets), so deployed sites get internet for the computer too
- Browser extension build: let a bot read and act on the page you're viewing
- Chat with your files: chunking and a vector index in a Rust crate compiled to WASM, with local embeddings
- MCP client, so bots can use your existing tool servers
- Voice: Whisper speech-to-text and text-to-speech, in the browser
- Multi-bot teams: one bot hands sub-tasks to others
