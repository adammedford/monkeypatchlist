// The addresses the safety floor refuses to connect to (§17 Safety floor: Addresses).

import { isIPv4, isIPv6 } from 'node:net'

/** An IPv4 range: its first address as a 32-bit number, its prefix length, and what it is. */
type Range4 = readonly [first: number, prefix: number, name: string]

/** Refused IPv4 ranges. A single cloud-metadata address comes before the range that holds it, so that it is named. */
const refused4: readonly Range4[] = [
  [ipv4('169.254.169.254'), 32, 'cloud-metadata'],
  [ipv4('100.100.100.200'), 32, 'cloud-metadata'],
  [ipv4('168.63.129.16'), 32, 'cloud-metadata'],
  [ipv4('192.0.0.192'), 32, 'cloud-metadata'],
  [ipv4('0.0.0.0'), 8, 'unspecified'],
  [ipv4('127.0.0.0'), 8, 'loopback'],
  [ipv4('10.0.0.0'), 8, 'private'],
  [ipv4('172.16.0.0'), 12, 'private'],
  [ipv4('192.168.0.0'), 16, 'private'],
  [ipv4('169.254.0.0'), 16, 'link-local'],
  [ipv4('100.64.0.0'), 10, 'carrier-grade NAT'],
  [ipv4('224.0.0.0'), 4, 'multicast'],
  [ipv4('255.255.255.255'), 32, 'broadcast'],
]

/**
 * Why the floor refuses to connect to `address`, as the kind of address it is, or null when it doesn't. Refused:
 * loopback, private, link-local, unique-local, carrier-grade NAT, multicast, cloud-metadata and unspecified addresses,
 * and an IPv6 address that carries a refused IPv4 one (IPv4-mapped, IPv4-compatible, NAT64 or 6to4).
 */
export function refusedAddress(scoped: string): string | null {
  // A link-local IPv6 address may carry a zone (`fe80::1%en0`).
  const address = scoped.replace(/%.*$/, '')
  if (isIPv4(address)) return refused4Of(ipv4(address))
  if (!isIPv6(address)) return 'not an IP'
  const words = ipv6(address)
  const all = (from: number, to: number, value: number) => words.slice(from, to).every((word) => word === value)
  const embedded = (high: number, low: number) => (((words[high]! << 16) | words[low]!) >>> 0) as number
  if (all(0, 8, 0)) return 'unspecified'
  if (all(0, 7, 0) && words[7] === 1) return 'loopback'
  // An IPv4 address in IPv6 form: IPv4-mapped (::ffff:0:0/96), IPv4-compatible (::/96), NAT64 (64:ff9b::/96) and
  // 6to4 (2002::/16).
  const carried: [string, number] | null =
    all(0, 5, 0) && words[5] === 0xffff
      ? ['IPv4-mapped', embedded(6, 7)]
      : all(0, 6, 0)
        ? ['IPv4-compatible', embedded(6, 7)]
        : words[0] === 0x64 && words[1] === 0xff9b && all(2, 6, 0)
          ? ['NAT64', embedded(6, 7)]
          : words[0] === 0x2002
            ? ['6to4', embedded(1, 2)]
            : null
  if (carried !== null) {
    const inner = refused4Of(carried[1])
    return inner === null ? null : `${carried[0]} ${inner}`
  }
  const first = words[0]!
  if (first === 0xfd00 && words[1] === 0x0ec2 && all(2, 7, 0) && words[7] === 0x254) return 'cloud-metadata'
  if ((first & 0xfe00) === 0xfc00) return 'unique-local'
  if ((first & 0xffc0) === 0xfe80) return 'link-local'
  if ((first & 0xffc0) === 0xfec0) return 'site-local'
  if ((first & 0xff00) === 0xff00) return 'multicast'
  return null
}

function refused4Of(value: number): string | null {
  for (const [first, prefix, name] of refused4) {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
    if (((value & mask) >>> 0) === first) return name
  }
  return null
}

/** A dotted-quad IPv4 address as a 32-bit number. */
function ipv4(address: string): number {
  return address.split('.').reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0)
}

/** An IPv6 address as its eight 16-bit words. A trailing dotted quad is two words. */
function ipv6(address: string): number[] {
  const quad = /(\d+\.\d+\.\d+\.\d+)$/.exec(address)
  let text = address
  if (quad !== null) {
    const value = ipv4(quad[1]!)
    text = `${address.slice(0, quad.index)}${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`
  }
  const [head = '', tail] = text.split('::')
  const parse = (part: string) => (part === '' ? [] : part.split(':').map((word) => parseInt(word, 16)))
  const [before, after] = [parse(head), parse(tail ?? '')]
  const zeros = tail === undefined ? [] : new Array<number>(8 - before.length - after.length).fill(0)
  return [...before, ...zeros, ...after]
}
