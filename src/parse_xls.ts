// src/parse_xls.ts
// Browser-only Excel (XLS/XLSX) -> UnifiedPolicy[]
// Exports BOTH: `parseXlsToUnified` and legacy alias `parsePoliciesXls`.
// Also provides a default export for convenience.

import type { UnifiedPolicy } from './xml_to_upolicy';
import * as XLSX from 'xlsx';

type Row = Record<string, any>;

function getFirstHeader(row: Row, options: string[]): string | undefined {
  const keys = Object.keys(row).map(k => k.trim().toLowerCase());
  for (const opt of options) {
    const idx = keys.indexOf(opt.toLowerCase());
    if (idx >= 0) return Object.keys(row)[idx];
  }
  return undefined;
}

function splitList(v: any): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  return String(v)
    .split(/[;, \n]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function isIp(s: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(s);
}

function toCidrOrHost(s: string): { cidr?: string; host?: string } {
  if (!s) return {};
  const t = s.trim();
  if (t.includes('/')) return { cidr: t };
  if (isIp(t)) return { host: t };
  return {};
}

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

function toUnified(row: Row): UnifiedPolicy | null {
  const nameKey = getFirstHeader(row, ['Name', 'Policy', 'Policy Name']) as string | undefined;
  const svcKey = getFirstHeader(row, ['Service', 'Application', 'App']) as string | undefined;

  const fromKey = getFirstHeader(row, ['From', 'Src', 'Source']) as string | undefined;
  const toKey = getFirstHeader(row, ['To', 'Dst', 'Destination']) as string | undefined;

  const srcCidrsKey = getFirstHeader(row, ['SrcCIDRs', 'SrcCIDR', 'Source CIDRs']) as string | undefined;
  const dstCidrsKey = getFirstHeader(row, ['DstCIDRs', 'DstCIDR', 'Destination CIDRs']) as string | undefined;
  const srcHostsKey = getFirstHeader(row, ['SrcHosts', 'Source Hosts']) as string | undefined;
  const dstHostsKey = getFirstHeader(row, ['DstHosts', 'Destination Hosts']) as string | undefined;

  const name = (nameKey && row[nameKey]) ? String(row[nameKey]) : undefined;
  if (!name) return null;

  const service = (svcKey && row[svcKey]) ? String(row[svcKey]) : undefined;

  const fromVals = fromKey ? splitList(row[fromKey]) : [];
  const toVals = toKey ? splitList(row[toKey]) : [];

  // Prefer explicit CIDR columns if present
  let srcCidrs: string[] = srcCidrsKey ? splitList(row[srcCidrsKey]) : [];
  let dstCidrs: string[] = dstCidrsKey ? splitList(row[dstCidrsKey]) : [];
  let srcHosts: string[] = srcHostsKey ? splitList(row[srcHostsKey]) : [];
  let dstHosts: string[] = dstHostsKey ? splitList(row[dstHostsKey]) : [];

  // If From/To contain IPs/CIDRs, fold them in
  for (const v of fromVals) {
    const { cidr, host } = toCidrOrHost(v);
    if (cidr) srcCidrs.push(cidr);
    if (host) { srcHosts.push(host); srcCidrs.push(host + '/32'); }
  }
  for (const v of toVals) {
    const { cidr, host } = toCidrOrHost(v);
    if (cidr) dstCidrs.push(cidr);
    if (host) { dstHosts.push(host); dstCidrs.push(host + '/32'); }
  }

  srcCidrs = uniq(srcCidrs);
  dstCidrs = uniq(dstCidrs);
  srcHosts = uniq(srcHosts);
  dstHosts = uniq(dstHosts);

  const up: UnifiedPolicy = {
    id: 'xls_' + Math.random().toString(36).slice(2),
    name,
    service,
    fromAliases: [],
    toAliases: [],
    srcCidrs,
    dstCidrs,
    srcHosts,
    dstHosts,
    source: 'XLS',
    tags: [],
  };

  return up;
}

export async function parseXlsToUnified(file: File): Promise<UnifiedPolicy[]> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });

  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows: Row[] = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  const out: UnifiedPolicy[] = [];
  for (const row of rows) {
    const u = toUnified(row);
    if (u) out.push(u);
  }
  return out;
}

// Legacy named export expected by some App.tsx versions
export const parsePoliciesXls = parseXlsToUnified;

// Also provide a default export for convenience
export default parseXlsToUnified;
