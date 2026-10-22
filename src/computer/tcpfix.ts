// Fixes two problems in v86's built-in TCP (the stack between the guest and
// the WISP relay, in v86's network adapter):
//
// 1. Stop-and-wait: it sends one segment, then waits for the guest's ACK.
//    Linux delays ACKs for a lone segment by up to 40 ms, so downloads crawl
//    at ~35 KB/s. We keep up to WINDOW_SEGMENTS segments in flight instead.
// 2. No retransmission: a segment the guest drops is never resent, and the
//    connection stalls forever. We resend from the last acknowledged byte
//    (go-back-N) after 3 duplicate ACKs or RTO_MS without progress.
//
// This patches the connection prototype at runtime, the first time a TCP
// connection appears. It relies on v86 internals (the fields below) and is
// tied to the v86 version pinned in package.json.

interface TcpConn {
  seq: number
  pending: boolean
  send_buffer: { buffer: Uint8Array; tail: number; length: number }
  send_chunk_buf: Uint8Array
  last?: { tcp: { winsize: number } }
  pump(): void
  process(packet: { tcp: { ackn: number; ack?: boolean; syn?: boolean; fin?: boolean }; tcp_data?: Uint8Array }): void
  // Ours:
  _next?: number
  _dupAcks?: number
  _progressAt?: number
}

const WINDOW_SEGMENTS = 32
const RTO_MS = 250

/** a - b for 32-bit TCP sequence numbers. */
const diff = (a: number, b: number) => (a - b) >>> 0

function install(proto: TcpConn) {
  // v86's pump sends one segment from the start of the buffer at `seq`. We
  // reuse it per segment by pointing its view of the buffer at an offset.
  const sendOne = proto.pump
  const originalProcess = proto.process

  proto.pump = function (this: TcpConn) {
    if (this._next === undefined) this._next = this.seq
    const rb = this.send_buffer
    let inflight = diff(this._next, this.seq)
    // The buffer shrank under us (a reset or close): restart from the last ACK.
    if (inflight > rb.length) inflight = 0
    const mss = this.send_chunk_buf.length
    const limit = Math.max(mss, Math.min(this.last?.tcp.winsize ?? 65535, WINDOW_SEGMENTS * mss))
    while (rb.length > inflight && inflight < limit) {
      const len = Math.min(mss, rb.length - inflight, limit - inflight)
      const saved = { tail: rb.tail, length: rb.length, seq: this.seq }
      rb.tail = (rb.tail + inflight) % rb.buffer.length
      rb.length = len
      this.seq = (saved.seq + inflight) >>> 0
      this.pending = false
      try {
        sendOne.call(this)
      } finally {
        rb.tail = saved.tail
        rb.length = saved.length
        this.seq = saved.seq
      }
      inflight += len
    }
    this._next = (this.seq + inflight) >>> 0
    // v86 reads `pending` to know whether data is unacknowledged (e.g. before sending FIN).
    this.pending = inflight > 0
    if (inflight === 0) this._progressAt = undefined
    else this._progressAt ??= Date.now()
  }

  proto.process = function (this: TcpConn, packet) {
    const before = this.seq
    const pureAck = !!packet.tcp.ack && !packet.tcp.syn && !packet.tcp.fin && !packet.tcp_data?.length
    originalProcess.call(this, packet)
    if (this.seq !== before) {
      this._dupAcks = 0
      this._progressAt = Date.now()
    } else if (pureAck && this.pending && packet.tcp.ackn === this.seq) {
      // The guest keeps acknowledging the same byte: a segment was lost.
      this._dupAcks = (this._dupAcks ?? 0) + 1
      if (this._dupAcks >= 3) {
        this._dupAcks = 0
        this._next = this.seq
        this.pump()
      }
    }
  }
}

/**
 * Fixes the adapter's TCP connections (installing on first sight) and runs the
 * retransmission timer. Call it periodically, e.g. every 100 ms.
 */
export function tcpTick(adapter: { tcp_conn?: Record<string, TcpConn> } | undefined, installed: WeakSet<object>) {
  const conns = adapter?.tcp_conn
  if (!conns) return
  const now = Date.now()
  for (const c of Object.values(conns)) {
    const proto = Object.getPrototypeOf(c) as TcpConn
    if (!installed.has(proto)) {
      installed.add(proto)
      install(proto)
    }
    // Retransmission timeout: nothing acknowledged for a while, resend from the last ACK.
    if (c.pending && c._progressAt !== undefined && now - c._progressAt > RTO_MS) {
      c._next = c.seq
      c._progressAt = now
      c.pump()
    }
  }
}
