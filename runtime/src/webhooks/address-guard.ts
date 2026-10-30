/**
 * Numeric public-address check for webhook egress. Parses an IP literal to bytes and compares it
 * against the blocked CIDR ranges (no string-prefix or regex range checks). Embedded IPv4 in
 * IPv4-mapped, IPv4-compatible, NAT64 and 6to4 IPv6 addresses is decoded and re-checked; Teredo is
 * blocked outright. Anything that does not parse is refused (fail closed).
 */

import { isIP } from "node:net";

type Cidr = readonly [prefix: readonly number[], bits: number];

const V4_BLOCKED: readonly Cidr[] = [
  [[0], 8], // "this network", includes 0.0.0.0
  [[10], 8],
  [[100, 64], 10], // CGNAT
  [[127], 8],
  [[169, 254], 16], // link-local, cloud metadata
  [[172, 16], 12],
  [[192, 0, 0], 24], // IETF protocol assignments
  [[192, 168], 16],
  [[198, 18], 15], // benchmarking
  [[224], 4], // multicast
  [[240], 4], // reserved, includes 255.255.255.255
];

const V6_BLOCKED: readonly Cidr[] = [
  [[0xfc], 7], // ULA fc00::/7
  [[0xfe, 0x80], 10], // link-local
  [[0xff], 8], // multicast
  [[0x20, 0x01, 0x00, 0x00], 32], // Teredo 2001::/32
];

function inCidr(bytes: readonly number[], [prefix, bits]: Cidr): boolean {
  let remaining = bits;
  for (let i = 0; remaining > 0; i++, remaining -= 8) {
    const mask = remaining >= 8 ? 0xff : (0xff << (8 - remaining)) & 0xff;
    const want = prefix[i] ?? 0;
    if (((bytes[i] ?? 0) & mask) !== (want & mask)) return false;
  }
  return true;
}

function parseV4(s: string): number[] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

function parseV6(raw: string): number[] | null {
  let s = raw;
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  // A dotted IPv4 tail occupies the last two groups.
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseV4(tail);
    if (!v4) return null;
    s = `${s.slice(0, lastColon + 1)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const toGroups = (h: string): number[] | null => {
    if (h === "") return [];
    const groups: number[] = [];
    for (const g of h.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      groups.push(parseInt(g, 16));
    }
    return groups;
  };
  const head = toGroups(halves[0]!);
  const rest = halves.length === 2 ? toGroups(halves[1]!) : [];
  if (!head || !rest) return null;
  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  return groups.flatMap((g) => [g >> 8, g & 0xff]);
}

function isPublicV4(bytes: readonly number[]): boolean {
  return !V4_BLOCKED.some((c) => inCidr(bytes, c));
}

function isPublicV6(b: readonly number[]): boolean {
  const zeros = (from: number, to: number): boolean => b.slice(from, to).every((x) => x === 0);
  if (zeros(0, 15) && (b[15] === 0 || b[15] === 1)) return false; // :: and ::1
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return isPublicV4(b.slice(12)); // ::ffff:0:0/96
  if (zeros(0, 12)) return isPublicV4(b.slice(12)); // ::/96 IPv4-compatible
  if (inCidr(b, [[0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0], 96])) return isPublicV4(b.slice(12)); // 64:ff9b::/96 NAT64
  if (b[0] === 0x20 && b[1] === 0x02) return isPublicV4(b.slice(2, 6)); // 2002::/16 6to4
  return !V6_BLOCKED.some((c) => inCidr(b, c));
}

/** True only for a syntactically valid IP literal outside every blocked range. */
export function isPublicAddress(addr: string): boolean {
  const kind = isIP(addr);
  if (kind === 4) {
    const b = parseV4(addr);
    return b !== null && isPublicV4(b);
  }
  if (kind === 6) {
    const b = parseV6(addr);
    return b !== null && isPublicV6(b);
  }
  return false;
}
