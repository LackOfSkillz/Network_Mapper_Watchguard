// src/ip.ts

/** Parse dotted IPv4 to 32-bit unsigned integer */
function ipToInt(ip: string): number {
  const parts = ip.trim().split(".");
  if (parts.length !== 4) throw new Error(`Bad IPv4: ${ip}`);
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) throw new Error(`Bad IPv4: ${ip}`);
    n = (n << 8) | v;
  }
  return n >>> 0;
}

/** Convert dotted mask (e.g., 255.255.255.0) to prefix length; pass through if already "24" */
function maskToPrefix(mask: string): number {
  if (!mask.includes(".")) {
    const pref = Number(mask);
    if (Number.isFinite(pref)) return pref;
    throw new Error(`Bad mask: ${mask}`);
  }
  const m = ipToInt(mask);
  // count leading 1s
  let bits = 0;
  for (let i = 31; i >= 0; i--) {
    if ((m & (1 << i)) !== 0) bits++;
    else break;
  }
  return bits;
}

/** Build a mask integer from prefix length */
function prefixToMask(prefix: number): number {
  if (prefix <= 0) return 0 >>> 0;
  if (prefix >= 32) return 0xffffffff >>> 0;
  const m = (0xffffffff << (32 - prefix)) >>> 0;
  return m >>> 0;
}

/** Parse a CIDR "a.b.c.d/nn" to { ipInt, prefix, maskInt, networkInt } */
function parseCIDR(cidr: string) {
  const [ipStr, pStr] = cidr.trim().split("/");
  if (!ipStr || pStr === undefined) throw new Error(`Bad CIDR: ${cidr}`);
  const ipInt = ipToInt(ipStr);
  const prefix = Number(pStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) throw new Error(`Bad CIDR prefix: ${cidr}`);
  const maskInt = prefixToMask(prefix);
  const networkInt = (ipInt & maskInt) >>> 0;
  return { ipInt, prefix, maskInt, networkInt };
}

/** Return normalized network string "a.b.c.d/nn" from IP + dotted mask or prefix */
export function networkOf(ip: string, mask: string): string {
  const ipInt = ipToInt(ip);
  const prefix = maskToPrefix(mask);
  const maskInt = prefixToMask(prefix);
  const net = (ipInt & maskInt) >>> 0;
  const a = (net >>> 24) & 255;
  const b = (net >>> 16) & 255;
  const c = (net >>> 8) & 255;
  const d = net & 255;
  return `${a}.${b}.${c}.${d}/${prefix}`;
}

/** Do two CIDRs overlap at all? */
export function overlaps(cidrA: string, cidrB: string): boolean {
  try {
    const A = parseCIDR(cidrA);
    const B = parseCIDR(cidrB);

    // Use the shorter mask (smaller prefix) to compare network roots
    const prefix = Math.min(A.prefix, B.prefix);
    const mask = prefixToMask(prefix);
    const aNet = (A.ipInt & mask) >>> 0;
    const bNet = (B.ipInt & mask) >>> 0;
    return aNet === bNet;
  } catch {
    return false;
  }
}

/** Is a single IPv4 inside a CIDR? */
export function cidrContainsIp(cidr: string, ip: string): boolean {
  try {
    const { maskInt, networkInt } = parseCIDR(cidr);
    const ipInt = ipToInt(ip);
    return ((ipInt & maskInt) >>> 0) === networkInt;
  } catch {
    return false;
  }
}
