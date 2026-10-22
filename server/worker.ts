// Deploy the web proxy as a Cloudflare Worker (or any fetch-handler runtime):
//   npx wrangler deploy server/worker.ts --name open-bot-proxy --compatibility-date 2026-10-01 \
//     --var ALLOWED_ORIGINS:https://<you>.github.io
// then serve the built app from the same origin, or point the app at it (the
// OPENBOT_SERVER_URL repository variable for the Pages build, or Settings in the app).
// It covers web search, page reading and the LLM passthrough; the WISP relay
// (internet for the computer and shell) needs the Node server (server/wisp.ts).
import { handleProxy, type ProxyEnv } from './proxy.ts'

export default {
  async fetch(req: Request, env: ProxyEnv): Promise<Response> {
    return (await handleProxy(req, env)) ?? new Response('Not found', { status: 404 })
  },
}
