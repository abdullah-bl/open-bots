// Deploy the web proxy as a Cloudflare Worker (or any fetch-handler runtime):
//   npx wrangler deploy server/worker.ts --name open-bot-proxy
// then serve the built app from the same origin, or point the app at it.
import { handleProxy, type ProxyEnv } from './proxy.ts'

export default {
  async fetch(req: Request, env: ProxyEnv): Promise<Response> {
    return (await handleProxy(req, env)) ?? new Response('Not found', { status: 404 })
  },
}
