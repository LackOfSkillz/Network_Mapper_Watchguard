// src/policy_match.ts
// Helpers to attach policies to subnets/hosts for the UI panel filtering.

import type { UnifiedPolicy } from './xml_to_upolicy';

// IPv4 helpers (mirror of your src/ip.ts, but only what's needed here)
function ipToInt(ip: string): number {
  return ip.split('.').reduce((a, o) => (a << 8) + (parseInt(o, 10) & 0xff), 0) >>> 0;
}

function cidrContainsIp(cidr: string, ip: string): boolean {
  const [net, bitsStr] = cidr.split('/');
  const bits = parseInt(bitsStr, 10);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipToInt(ip) & mask) === (ipToInt(net) & mask);
}

function overlaps(cidrA: string, cidrB: string): boolean {
  const [aNet, aBitsStr] = cidrA.split('/');
  const [bNet, bBitsStr] = cidrB.split('/');
  const aBits = parseInt(aBitsStr, 10);
  const bBits = parseInt(bBitsStr, 10);
  const aMask = aBits === 0 ? 0 : (~0 << (32 - aBits)) >>> 0;
  const bMask = bBits === 0 ? 0 : (~0 << (32 - bBits)) >>> 0;
  const aBase = ipToInt(aNet) & aMask;
  const bBase = ipToInt(bNet) & bMask;
  const maxStart = Math.max(aBase, bBase) >>> 0;
  const minEnd = Math.min(aBase | (~aMask >>> 0), bBase | (~bMask >>> 0)) >>> 0;
  return maxStart <= minEnd;
}

export function policiesForSubnet(policies: UnifiedPolicy[], subnetCidr: string): UnifiedPolicy[] {
  return policies.filter(p =>
    p.srcCidrs.some(c => overlaps(c, subnetCidr)) ||
    p.dstCidrs.some(c => overlaps(c, subnetCidr))
  );
}

export function policiesForHost(policies: UnifiedPolicy[], ip: string): UnifiedPolicy[] {
  return policies.filter(p =>
    p.srcHosts.includes(ip) ||
    p.dstHosts.includes(ip) ||
    p.srcCidrs.some(c => cidrContainsIp(c, ip)) ||
    p.dstCidrs.some(c => cidrContainsIp(c, ip))
  );
}
