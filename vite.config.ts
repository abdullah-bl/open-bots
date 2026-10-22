import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Connect, type Plugin } from 'vite'
import { handleProxy, type ProxyEnv } from './server/proxy.ts'

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
    try {
      const out = await handleProxy(new Request(new URL(req.url, 'http://localhost')), env)
      if (!out) return next()
      res.statusCode = out.status
      out.headers.forEach((v: string, k: string) => res.setHeader(k, v))
      res.end(Buffer.from(await out.arrayBuffer()))
    } catch (e) {
      res.statusCode = 500
      res.end(String(e))
    }
  }
  return {
    name: 'open-bot-web-proxy',
    configureServer: (s) => void s.middlewares.use(middleware),
    configurePreviewServer: (s) => void s.middlewares.use(middleware),
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
