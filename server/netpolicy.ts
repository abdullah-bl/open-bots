// Where bots may connect: the public internet only. Node-only (uses dns and net).
import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'

const blocked = new BlockList()
for (const [net, bits] of [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including cloud metadata (169.254.169.254)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 3], // multicast and reserved, through 255.255.255.255
] as const) {
  blocked.addSubnet(net, bits, 'ipv4')
}
for (const [net, bits] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['64:ff9b:1::', 48], // local NAT64
  ['100::', 64], // discard
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  blocked.addSubnet(net, bits, 'ipv6')
}

/** Ports that are almost only useful for abuse from a relay (mail submission). */
const BLOCKED_PORTS = new Set([0, 25, 465, 587])

export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip)
  if (family === 4) return blocked.check(ip, 'ipv4')
  if (family === 6) {
    // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible forms hide an IPv4 address.
    const mapped = ip.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/i)
    if (mapped) return blocked.check(mapped[1], 'ipv4')
    return blocked.check(ip, 'ipv6')
  }
  return true
}

export function isBlockedPort(port: number) {
  return BLOCKED_PORTS.has(port) || port < 1 || port > 65535
}

export type Resolved = { ok: true; address: string; family: 4 | 6 } | { ok: false; reason: 'blocked' | 'unresolvable' }

/**
 * Resolves `host` and returns an address that is safe to connect to. If any
 * address it resolves to is private, the whole name is refused, so a name that
 * mixes public and private records can't be used to reach the private one.
 */
export async function resolvePublic(host: string): Promise<Resolved> {
  const bare = host.replace(/^\[|\]$/g, '')
  if (isIP(bare)) return isBlockedAddress(bare) ? { ok: false, reason: 'blocked' } : { ok: true, address: bare, family: isIP(bare) as 4 | 6 }
  if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(bare)) return { ok: false, reason: 'blocked' }
  let records: { address: string; family: number }[]
  try {
    records = await lookup(bare, { all: true, verbatim: true })
  } catch {
    return { ok: false, reason: 'unresolvable' }
  }
  if (!records.length) return { ok: false, reason: 'unresolvable' }
  if (records.some((r) => isBlockedAddress(r.address))) return { ok: false, reason: 'blocked' }
  // Prefer IPv4: many hosts serving this relay have no IPv6 route.
  const pick = records.find((r) => r.family === 4) ?? records[0]
  return { ok: true, address: pick.address, family: pick.family as 4 | 6 }
}
