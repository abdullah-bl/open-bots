// Cross-origin isolation for static hosts that can't send headers (GitHub Pages).
// The app needs SharedArrayBuffer (multi-threaded WebAssembly for the shell and
// the CPU model engine), which browsers only allow on pages served with
// COOP/COEP headers. This worker adds them to every same-origin response; the
// page registers it and reloads once (see src/lib/isolation.ts).
// Cross-origin requests pass through untouched: "credentialless" lets them load
// without CORP headers, as long as they carry no cookies.

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (new URL(request.url).origin !== self.location.origin) return
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return
  event.respondWith(
    fetch(request).then((response) => {
      if (response.status === 0) return response
      const headers = new Headers(response.headers)
      headers.set('Cross-Origin-Opener-Policy', 'same-origin')
      headers.set('Cross-Origin-Embedder-Policy', 'credentialless')
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
    }),
  )
})
