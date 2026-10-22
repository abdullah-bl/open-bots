// A WISP v1 relay (https://github.com/MercuryWorkshop/wisp-protocol): many TCP
// (and DNS-only UDP) streams multiplexed over one WebSocket. It gives the
// in-browser Linux computer (v86) and the WASIX shell real internet access,
// to public addresses only (see netpolicy.ts).
import { Socket, connect } from 'node:net'
import { createSocket, type Socket as UdpSocket } from 'node:dgram'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { isBlockedPort, resolvePublic } from './netpolicy.ts'

const CONNECT = 0x01
const DATA = 0x02
const CONTINUE = 0x03
const CLOSE = 0x04

const STREAM_TCP = 0x01
const STREAM_UDP = 0x02

// Close reasons from the spec.
const REASON = {
  voluntary: 0x02,
  networkError: 0x03,
  invalid: 0x41,
  unreachable: 0x42,
  timeout: 0x43,
  refused: 0x44,
  tcpTimeout: 0x47,
  blocked: 0x48,
  throttled: 0x49,
} as const

/** Packets a client may send per stream before it must wait for CONTINUE. */
const BUFFER = 128
const MAX_STREAMS = 128
const CONNECT_TIMEOUT_MS = 15_000
/** Stop reading from sockets while this much is queued on the WebSocket. */
const WS_HIGH_WATER = 8 * 1024 * 1024
const MAX_DATA_FRAME = 64 * 1024

export interface WispOptions {
  /** Called with a short line per connection decision. */
  log?: (line: string) => void
}

interface ConnectionOptions extends WispOptions {
  /** Refuse every stream: the client's internet access is switched off. */
  offline: boolean
}

interface Stream {
  kind: 'tcp' | 'udp'
  tcp?: Socket
  udp?: UdpSocket
  udpTarget?: { address: string; port: number }
  /** DATA that arrived before the TCP connection was open. */
  early: Buffer[]
  open: boolean
  /** DATA packets received since the last CONTINUE we sent. */
  received: number
  closed: boolean
}

function frame(type: number, id: number, payload?: Uint8Array) {
  const out = Buffer.allocUnsafe(5 + (payload?.length ?? 0))
  out[0] = type
  out.writeUInt32LE(id, 1)
  if (payload) out.set(payload, 5)
  return out
}

function u32(n: number) {
  const b = Buffer.allocUnsafe(4)
  b.writeUInt32LE(n, 0)
  return b
}

/** Serves one WebSocket as a WISP connection. */
function serve(ws: WebSocket, opts: ConnectionOptions) {
  const streams = new Map<number, Stream>()
  const log = opts.log ?? (() => {})

  const send = (buf: Buffer) => {
    if (ws.readyState === ws.OPEN) ws.send(buf)
  }

  const close = (id: number, reason: number, notify = true) => {
    const s = streams.get(id)
    if (!s || s.closed) return
    s.closed = true
    streams.delete(id)
    s.tcp?.destroy()
    s.udp?.close()
    if (notify) send(frame(CLOSE, id, Uint8Array.of(reason)))
  }

  // Pause every socket while the browser falls behind, resume when it catches up.
  const pump = setInterval(() => {
    const congested = ws.bufferedAmount > WS_HIGH_WATER
    for (const s of streams.values()) {
      if (!s.tcp) continue
      if (congested && !s.tcp.isPaused()) s.tcp.pause()
      else if (!congested && s.tcp.isPaused()) s.tcp.resume()
    }
  }, 50)

  const acknowledge = (id: number, s: Stream) => {
    s.received++
    // Top the client's allowance back up well before it runs out.
    if (s.received >= BUFFER / 2) {
      s.received = 0
      send(frame(CONTINUE, id, u32(BUFFER)))
    }
  }

  const openStream = async (id: number, type: number, port: number, host: string) => {
    if (streams.has(id) || id === 0) return send(frame(CLOSE, id, Uint8Array.of(REASON.invalid)))
    if (opts.offline) return send(frame(CLOSE, id, Uint8Array.of(REASON.blocked)))
    if (streams.size >= MAX_STREAMS) return send(frame(CLOSE, id, Uint8Array.of(REASON.throttled)))
    const kind = type === STREAM_UDP ? 'udp' : type === STREAM_TCP ? 'tcp' : null
    // UDP is only for DNS; everything else a bot needs runs over TCP.
    if (!kind || isBlockedPort(port) || (kind === 'udp' && port !== 53)) {
      log(`blocked ${kind ?? type} ${host}:${port} (port or stream type)`)
      return send(frame(CLOSE, id, Uint8Array.of(REASON.blocked)))
    }

    const s: Stream = { kind, early: [], open: false, received: 0, closed: false }
    streams.set(id, s)

    const target = await resolvePublic(host)
    if (s.closed) return
    if (!target.ok) {
      log(`${target.reason} ${host}:${port}`)
      return close(id, target.reason === 'blocked' ? REASON.blocked : REASON.unreachable)
    }

    if (kind === 'udp') {
      s.udp = createSocket(target.family === 6 ? 'udp6' : 'udp4')
      s.udpTarget = { address: target.address, port }
      s.udp.on('message', (msg) => send(frame(DATA, id, msg)))
      s.udp.on('error', () => close(id, REASON.networkError))
      s.open = true
      for (const d of s.early.splice(0)) s.udp.send(d, port, target.address)
      return
    }

    log(`connect ${host}:${port} -> ${target.address}`)
    const sock = connect({ host: target.address, port, family: target.family })
    s.tcp = sock
    sock.setNoDelay(true)
    const timer = setTimeout(() => close(id, REASON.timeout), CONNECT_TIMEOUT_MS)
    sock.once('connect', () => {
      clearTimeout(timer)
      s.open = true
      for (const d of s.early.splice(0)) sock.write(d)
    })
    sock.on('data', (chunk: Buffer) => {
      for (let i = 0; i < chunk.length; i += MAX_DATA_FRAME) send(frame(DATA, id, chunk.subarray(i, i + MAX_DATA_FRAME)))
    })
    sock.on('end', () => close(id, REASON.voluntary))
    sock.on('close', () => close(id, REASON.voluntary))
    sock.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      const reason =
        err.code === 'ECONNREFUSED' ? REASON.refused
        : err.code === 'ETIMEDOUT' ? REASON.tcpTimeout
        : err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH' ? REASON.unreachable
        : REASON.networkError
      close(id, reason)
    })
  }

  ws.on('message', (raw: Buffer, isBinary: boolean) => {
    if (!isBinary || raw.length < 5) return
    const type = raw[0]
    const id = raw.readUInt32LE(1)
    const payload = raw.subarray(5)
    if (type === CONNECT) {
      if (payload.length < 3) return send(frame(CLOSE, id, Uint8Array.of(REASON.invalid)))
      const port = payload.readUInt16LE(1)
      const host = payload.subarray(3).toString('utf8').trim()
      void openStream(id, payload[0], port, host)
    } else if (type === DATA) {
      const s = streams.get(id)
      if (!s) return
      const data = Buffer.from(payload)
      if (!s.open) s.early.push(data)
      else if (s.tcp) s.tcp.write(data)
      else if (s.udp && s.udpTarget) s.udp.send(data, s.udpTarget.port, s.udpTarget.address)
      acknowledge(id, s)
    } else if (type === CLOSE) {
      close(id, REASON.voluntary, false)
    }
  })

  ws.on('close', () => {
    clearInterval(pump)
    for (const id of [...streams.keys()]) close(id, REASON.voluntary, false)
  })
  ws.on('error', () => ws.terminate())

  // The handshake: stream 0's CONTINUE tells the client its initial allowance.
  send(frame(CONTINUE, 0, u32(BUFFER)))
}

/**
 * Returns an `upgrade` handler for a Node HTTP server that turns WebSocket
 * requests under `path` into WISP connections and ignores everything else
 * (so Vite's own hot-reload socket keeps working).
 */
export function wispUpgradeHandler(path: string, opts: WispOptions = {}) {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1024 * 1024 })
  return (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://relay')
    if (!url.pathname.startsWith(path)) return false
    // "?offline" keeps the client's network card working but refuses every connection.
    const offline = url.searchParams.has('offline')
    wss.handleUpgrade(req, socket, head, (ws) => serve(ws, { ...opts, offline }))
    return true
  }
}
