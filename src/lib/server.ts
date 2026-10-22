// Where open-bot's server lives. The server (server/proxy.ts and server/wisp.ts)
// gives bots web search, page reading, the LLM passthrough, and internet for the
// computer and shell. The dev and preview servers run it on the same origin; a
// static host such as GitHub Pages has none, so the app either points at a
// separately hosted one or runs without those features.
//
// Build-time settings (Vite env):
//   VITE_STATIC_HOST=1   this site has no server of its own
//   VITE_SERVER_URL=…    the server to use by default (e.g. a Cloudflare Worker)
// The user can override both in Settings.

const STATIC_HOST = import.meta.env.VITE_STATIC_HOST === '1'
const BUILT_IN = (import.meta.env.VITE_SERVER_URL ?? '').trim()

const clean = (url: string) => url.trim().replace(/\/+$/, '')

/** The server this build uses when the user hasn't set one, or null. */
export function defaultServer(): string | null {
  if (BUILT_IN) return clean(BUILT_IN)
  return STATIC_HOST ? null : location.origin
}

/** The server for a Settings value: the user's choice, else the build's default. */
export function resolveServer(custom: string | undefined): string | null {
  return custom?.trim() ? clean(custom) : defaultServer()
}

let current: string | null = defaultServer()

/** Called when settings change, for code outside React (tools, models, sandboxes). */
export function setServer(url: string | null) {
  current = url
}

export function server(): string | null {
  return current
}

/** Full URL for an /api/… endpoint, or null when there is no server. */
export function apiUrl(path: string): string | null {
  return current ? current + path : null
}

/** The WISP relay as ws(s)://…/wisp/, or null; `offline` refuses every connection. */
export function wispUrl(offline = false): string | null {
  if (!current) return null
  return `${current.replace(/^http/, 'ws')}/wisp/${offline ? '?offline' : ''}`
}

export const NO_SERVER =
  'This needs an open-bot server, and none is set up. Ask the user to add one under Settings → open-bot server.'
