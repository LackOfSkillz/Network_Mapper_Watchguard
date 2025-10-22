// src/merge_policies.ts
// Merge XML + XLS unified policies, tag sources, and dedupe robustly.
// Backward-compatible with older shapes that used { from, to } arrays.
// New shape (from xml_to_upolicy.ts) uses fromAliases/toAliases and resolved src/dstCidrs + hosts.

import type { UnifiedPolicy } from './xml_to_upolicy';

type AnyPolicy = Partial<UnifiedPolicy> & {
  // legacy compat
  from?: string[];
  to?: string[];
  source?: 'XML' | 'XLS';
};

function arr(x: any): string[] {
  if (!x) return [];
  if (Array.isArray(x)) return x.filter(Boolean).map(String);
  return [String(x)];
}

// Normalize any incoming policy-like object into the new UnifiedPolicy shape
function normalize(p: AnyPolicy): UnifiedPolicy {
  const fromAliases = p.fromAliases ?? p.from ?? [];
  const toAliases = p.toAliases ?? p.to ?? [];

  const srcCidrs = Array.isArray(p.srcCidrs) ? p.srcCidrs : [];
  const dstCidrs = Array.isArray(p.dstCidrs) ? p.dstCidrs : [];
  const srcHosts = Array.isArray(p.srcHosts) ? p.srcHosts : [];
  const dstHosts = Array.isArray(p.dstHosts) ? p.dstHosts : [];

  return {
    id: String(p.id ?? p.name ?? cryptoRandomId()),
    name: String(p.name ?? 'Unnamed'),
    service: p.service,
    fromAliases: arr(fromAliases),
    toAliases: arr(toAliases),
    srcCidrs,
    dstCidrs,
    srcHosts,
    dstHosts,
    source: p.source ?? 'XML',
    tags: p.tags ?? [],
    nat: p.nat,
    debug: p.debug ?? [],
  };
}

function cryptoRandomId(): string {
  // lightweight unique id for browser
  return 'p_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function keyOf(p: UnifiedPolicy): string {
  // Signature considers name, service, and resolved match space
  const f = [...p.srcCidrs].sort().join(',');
  const t = [...p.dstCidrs].sort().join(',');
  const fh = [...p.srcHosts].sort().join(',');
  const th = [...p.dstHosts].sort().join(',');
  return JSON.stringify({ n: p.name, s: p.service ?? '', f, t, fh, th });
}

export function mergePolicies(xmlPolicies: AnyPolicy[], xlsPolicies: AnyPolicy[]): UnifiedPolicy[] {
  const out: UnifiedPolicy[] = [];
  const seen = new Set<string>();

  const push = (raw: AnyPolicy, source: 'XML' | 'XLS') => {
    const norm = normalize({ ...raw, source });
    const k = keyOf(norm);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(norm);
    }
  };

  (xmlPolicies || []).forEach(p => push(p, 'XML'));
  (xlsPolicies || []).forEach(p => push(p, 'XLS'));

  return out;
}
