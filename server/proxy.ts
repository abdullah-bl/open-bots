/**
 * The only server piece open-bot needs: browsers can't fetch arbitrary sites
 * (CORS) or hold search API keys, so agents reach the web through these two
 * endpoints. Plain Request -> Response, so it runs in the Vite dev server, a
 * Cloudflare Worker, Deno, or Bun unchanged.
 *
 *   GET /api/fetch?url=https://…   raw page body (the browser extracts the text)
 *   GET /api/search?q=…            { source, results: [{ title, url, snippet }] }
 *
 * Search uses Brave (BRAVE_API_KEY) or SearXNG (SEARXNG_URL) when configured,
 * otherwise falls back to Wikipedia search, which needs no key.
 */

export interface ProxyEnv {
  BRAVE_API_KEY?: string
  SEARXNG_URL?: string
}

const MAX_BYTES = 3_000_000
const UA = 'open-bot/0.1 (personal AI agent; https://github.com/open-bot)'

export async function handleProxy(req: Request, env: ProxyEnv): Promise<Response | null> {
  const url = new URL(req.url)
  if (url.pathname === '/api/fetch') return fetchPage(url.searchParams.get('url') ?? '')
  if (url.pathname === '/api/search') return search(url.searchParams.get('q') ?? '', env)
  return null
}

async function fetchPage(target: string): Promise<Response> {
  let parsed: URL
  try {
    parsed = new URL(target)
  } catch {
    return json({ error: 'Invalid URL' }, 400)
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return json({ error: 'Only http(s) URLs are allowed' }, 400)
  if (isPrivateHost(parsed.hostname)) return json({ error: 'Private and local addresses are blocked' }, 403)

  const res = await fetch(parsed, {
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5' },
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000),
  }).catch((e: unknown) => e as Error)
  if (res instanceof Error) return json({ error: `Fetch failed: ${res.message}` }, 502)
  // A redirect may have landed somewhere private.
  if (isPrivateHost(new URL(res.url).hostname)) return json({ error: 'Redirected to a private address' }, 403)

  const body = await readLimited(res)
  return new Response(body, {
    status: res.status,
    headers: {
      'content-type': res.headers.get('content-type') ?? 'text/plain',
      'x-final-url': res.url,
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
