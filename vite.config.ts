import { Readable } from 'node:stream'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Connect, type Plugin } from 'vite'
import { handleProxy, type ProxyEnv } from './server/proxy.ts'
import { resolvePublic } from './server/netpolicy.ts'
import { wispUpgradeHandler } from './server/wisp.ts'

// Cross-origin isolation unlocks SharedArrayBuffer, which the llama.cpp WASM
// engine needs to run on several CPU threads. "credentialless" still allows
// CORS requests to model hosts and cloud APIs. Your production host must send
// these same headers.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
}

/** Serves the web proxy (server/proxy.ts) from the dev and preview servers. */
function webProxy(env: ProxyEnv): Plugin {
  const middleware: Connect.NextHandleFunction = async (req, res, next) => {
    if (!req.url?.startsWith('/api/')) return next()
    const abort = new AbortController()
    res.on('close', () => abort.abort())
    try {
      const headers = new Headers()
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
      const request = new Request(new URL(req.url, 'http://localhost'), {
        method: req.method,
        headers,
        body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
        signal: abort.signal,
        ...(hasBody ? { duplex: 'half' } : {}),
      } as RequestInit)
      const out = await handleProxy(request, env, {
        // In Node we can resolve names, so private addresses behind public names are caught too.
        isAllowedHost: async (host) => (await resolvePublic(host)).ok,
      })
      if (!out) return next()
      res.statusCode = out.status
      out.headers.forEach((v: string, k: string) => res.setHeader(k, v))
      // Stream, so chat completions (server-sent events) arrive as they are generated.
      if (out.body) for await (const chunk of out.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk)
      res.end()
    } catch (e) {
      if (abort.signal.aborted) return
      if (!res.headersSent) res.statusCode = 500
      res.end(String(e))
    }
  }
  // Internet for the in-browser computer and shell: a WISP relay on the same origin.
  const wisp = wispUpgradeHandler('/wisp/', { log: (line) => console.log(`[wisp] ${line}`) })
  const attach = (http: import('node:http').Server | null | undefined) => http?.on('upgrade', wisp)
  return {
    name: 'open-bot-web-proxy',
    configureServer: (s) => {
      s.middlewares.use(middleware)
      attach(s.httpServer as import('node:http').Server | null)
    },
    configurePreviewServer: (s) => {
      s.middlewares.use(middleware)
      attach(s.httpServer as import('node:http').Server | null)
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), webProxy({ BRAVE_API_KEY: env.BRAVE_API_KEY, SEARXNG_URL: env.SEARXNG_URL })],
    server: { headers: isolation },
    preview: { headers: isolation },
    worker: { format: 'es' },
    optimizeDeps: { exclude: ['@mlc-ai/web-llm', '@wllama/wllama'] },
  }
})
