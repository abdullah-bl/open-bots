// On hosts that can't send COOP/COEP headers, a service worker (public/coi-sw.js)
// adds them. The first visit registers it and reloads once so the page is served
// through it. Browsers that still can't isolate (Safari has no "credentialless")
// keep running without threads instead of reloading forever.

const RELOADED = 'open-bot.coi-reloaded'

/** Resolves when the app may render; never resolves when a reload is on its way. */
export async function ensureIsolation(): Promise<void> {
  if (window.crossOriginIsolated || !import.meta.env.PROD || !('serviceWorker' in navigator)) return
  const session = (() => {
    try {
      return sessionStorage
    } catch {
      return null
    }
  })()
  const reloaded = session?.getItem(RELOADED)
  try {
    await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}coi-sw.js`, { scope: import.meta.env.BASE_URL })
    await navigator.serviceWorker.ready
  } catch {
    return // Service workers blocked (private mode, policy): run without threads.
  }
  // Already served through the worker but still not isolated: this browser can't, so don't reload.
  if (reloaded || navigator.serviceWorker.controller) return
  if (!session) return // Without storage a reload loop can't be ruled out.
  session.setItem(RELOADED, '1')
  location.reload()
  return new Promise(() => {})
}
