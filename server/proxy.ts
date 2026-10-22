/**
 * The only server piece open-bot needs: browsers can't fetch arbitrary sites
 * (CORS) or hold search API keys, so agents reach the web through these
 * endpoints. Plain Request -> Response, so it runs in the Vite dev server, a
 * Cloudflare Worker, Deno, or Bun unchanged.
 *
 *   GET  /api/health                { ok: true }, so the app can tell the server is up
 *   GET  /api/fetch?url=https://…   raw page body (the browser extracts the text)
 *   GET  /api/search?q=…            { source, results: [{ title, url, snippet }] }
 *   POST /api/llm/<path>            forwards an OpenAI-style API call to the base URL
 *                                   in the x-openbot-target header, for providers
 *                                   (like NVIDIA) that don't allow browser requests
 *
 * Search uses Brave (BRAVE_API_KEY) or SearXNG (SEARXNG_URL) when configured,
 * otherwise falls back to Wikipedia search, which needs no key.
 *
 * When the app is hosted elsewhere (GitHub Pages), it calls this server
 * cross-origin; ALLOWED_ORIGINS limits which sites may do that.
 */

export interface ProxyEnv {
  BRAVE_API_KEY?: string
  SEARXNG_URL?: string
  /** Comma-separated origins allowed to call this server from other sites; "*" or unset allows any, "" none. */
  ALLOWED_ORIGINS?: string
}

const MAX_BYTES = 3_000_000
const UA = 'open-bot/0.1 (personal AI agent; https://github.com/open-bot)'

export interface ProxyOptions {
  /** Extra check on a hostname, e.g. resolving it and refusing private addresses (Node). */
  isAllowedHost?: (host: string) => Promise<boolean>
}

export async function handleProxy(req: Request, env: ProxyEnv, opts: ProxyOptions = {}): Promise<Response | null> {
  const url = new URL(req.url)
  if (!url.pathname.startsWith('/api/')) return null
  const origin = req.headers.get('origin')
  if (!originAllowed(origin, url.origin, env.ALLOWED_ORIGINS)) return json({ error: 'This site may not use this server' }, 403)
  const cors = new Headers({ vary: 'origin' })
  if (origin && new URL(origin).host !== url.host) {
    cors.set('access-control-allow-origin', origin)
    cors.set('access-control-expose-headers', 'x-final-url, x-request-id, retry-after')
  }
  if (req.method === 'OPTIONS') {
    cors.set('access-control-allow-methods', 'GET, POST, OPTIONS')
    cors.set('access-control-allow-headers', req.headers.get('access-control-request-headers') ?? '*')
    cors.set('access-control-max-age', '86400')
    return new Response(null, { status: 204, headers: cors })
  }
  const res = await route(req, url, env, opts)
  cors.forEach((v, k) => res?.headers.set(k, v))
  return res
}

/** Whether a page on `origin` may call the server at `self` (same site always may). */
export function originAllowed(origin: string | null | undefined, self: string, allowed: string | undefined): boolean {
  if (!origin) return true
  try {
    if (new URL(origin).host === new URL(self).host) return true
  } catch {
    return false
  }
  const list = (allowed ?? '*').split(',').map((o) => o.trim().replace(/\/+$/, ''))
  return list.includes('*') || list.includes(origin)
}

async function route(req: Request, url: URL, env: ProxyEnv, opts: ProxyOptions): Promise<Response | null> {
  if (url.pathname === '/api/health') return json({ ok: true })
  if (url.pathname === '/api/fetch') return fetchPage(url.searchParams.get('url') ?? '', opts)
  if (url.pathname === '/api/search') return search(url.searchParams.get('q') ?? '', env)
  if (url.pathname.startsWith('/api/llm/')) return forwardLlm(req, url, opts)
  return null
}

/** Headers worth passing to an LLM provider; cookies and browser-identifying headers stay behind. */
const LLM_REQUEST_HEADERS = ['authorization', 'content-type', 'accept', 'x-api-key', 'openai-organization', 'openai-project', 'http-referer', 'x-title']

async function forwardLlm(req: Request, url: URL, opts: ProxyOptions): Promise<Response> {
  const base = req.headers.get('x-openbot-target') ?? ''
  let target: URL
  try {
    target = new URL(base.replace(/\/+$/, '') + url.pathname.slice('/api/llm'.length) + url.search)
  } catch {
    return json({ error: 'Missing or invalid x-openbot-target header' }, 400)
  }
  if (target.protocol !== 'https:') return json({ error: 'Only https providers can be reached through the server' }, 400)
  if (isPrivateHost(target.hostname) || (opts.isAllowedHost && !(await opts.isAllowedHost(target.hostname)))) {
    return json({ error: 'Private, local or unresolvable provider addresses are blocked' }, 403)
  }
  const headers = new Headers()
  for (const h of LLM_REQUEST_HEADERS) {
    const v = req.headers.get(h)
    if (v) headers.set(h, v)
  }
  const res = await fetch(target, {
    method: req.method,
    headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer(),
    redirect: 'manual',
    signal: req.signal,
  }).catch((e: unknown) => e as Error)
  if (res instanceof Error) return json({ error: `Could not reach the provider: ${res.message}` }, 502)
  // Stream the body straight through (chat completions arrive as server-sent events).
  const out = new Headers({ 'cache-control': 'no-store' })
  for (const h of ['content-type', 'x-request-id', 'retry-after']) {
    const v = res.headers.get(h)
    if (v) out.set(h, v)
  }
  return new Response(res.body, { status: res.status, headers: out })
}

async function fetchPage(target: string, opts: ProxyOptions): Promise<Response> {
  let parsed: URL
  try {
    parsed = new URL(target)
  } catch {
    return json({ error: 'Invalid URL' }, 400)
  }

  // Follow redirects one hop at a time so every hop is checked before it is requested.
  let res: Response | Error = new Error('no request')
  for (let hop = 0; hop <= 5; hop++) {
    if (!['http:', 'https:'].includes(parsed.protocol)) return json({ error: 'Only http(s) URLs are allowed' }, 400)
    if (isPrivateHost(parsed.hostname) || (opts.isAllowedHost && !(await opts.isAllowedHost(parsed.hostname)))) {
      return json({ error: hop ? 'Redirected to a private or unresolvable address' : 'Private, local or unresolvable addresses are blocked' }, 403)
    }
    res = await fetch(parsed, {
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5' },
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    }).catch((e: unknown) => e as Error)
    if (res instanceof Error) return json({ error: `Fetch failed: ${res.message}` }, 502)
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
    if (!location) break
    parsed = new URL(location, parsed)
  }
  if (res instanceof Error) return json({ error: res.message }, 502)

  const body = await readLimited(res)
  return new Response(body, {
    status: res.status,
    headers: {
      'content-type': res.headers.get('content-type') ?? 'text/plain',
      'x-final-url': parsed.href,
      'cache-control': 'no-store',
    },
  })
}

async function search(q: string, env: ProxyEnv): Promise<Response> {
  q = q.trim()
  if (!q) return json({ error: 'Empty query' }, 400)
  try {
    if (env.BRAVE_API_KEY) {
      const r = await fetch(`https://api.search.brave.com/res/v1/web/search?count=8&q=${encodeURIComponent(q)}`, {
        headers: { accept: 'application/json', 'x-subscription-token': env.BRAVE_API_KEY },
      })
      const data = (await r.json()) as { web?: { results?: { title: string; url: string; description?: string }[] } }
      return json({
        source: 'brave',
        results: (data.web?.results ?? []).map((x) => ({ title: x.title, url: x.url, snippet: stripTags(x.description ?? '') })),
      })
    }
    if (env.SEARXNG_URL) {
      const r = await fetch(`${env.SEARXNG_URL.replace(/\/$/, '')}/search?format=json&q=${encodeURIComponent(q)}`)
      const data = (await r.json()) as { results?: { title: string; url: string; content?: string }[] }
      return json({
        source: 'searxng',
        results: (data.results ?? []).slice(0, 8).map((x) => ({ title: x.title, url: x.url, snippet: x.content ?? '' })),
      })
    }
    const r = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=8&srsearch=${encodeURIComponent(q)}`,
      { headers: { 'user-agent': UA } },
    )
    if (!r.ok) return json({ error: `Wikipedia search failed (${r.status}): ${(await r.text()).slice(0, 200)}` }, 502)
    const data = (await r.json()) as { query?: { search?: { title: string; snippet: string }[] } }
    return json({
      source: 'wikipedia',
      note: 'General web search is not configured; these are Wikipedia results. Set BRAVE_API_KEY or SEARXNG_URL for full web search.',
      results: (data.query?.search ?? []).map((x) => ({
        title: x.title,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(x.title.replace(/ /g, '_'))}`,
        snippet: stripTags(x.snippet),
      })),
    })
  } catch (e) {
    return json({ error: `Search failed: ${(e as Error).message}` }, 502)
  }
}

async function readLimited(res: Response): Promise<Uint8Array> {
  const reader = res.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let size = 0
  while (size < MAX_BYTES) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.length
  }
  await reader.cancel().catch(() => {})
  const out = new Uint8Array(Math.min(size, MAX_BYTES))
  let at = 0
  for (const c of chunks) {
    const part = c.subarray(0, Math.max(0, out.length - at))
    out.set(part, at)
    at += part.length
  }
  return out
}

/** Literal-hostname check. It does not catch DNS names that resolve to private IPs. */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true
  if (h === '::1' || h === '::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
}

function stripTags(s: string) {
  return s.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}
