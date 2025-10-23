// src/xml_to_upolicy.ts
// Converts WatchGuard XML policies/abs-policies to a unified policy shape,
// matching the City of Ocala export format.
//
// Policies use:
//   <from-alias-list><alias>NAME</alias>…</from-alias-list>
//   <to-alias-list><alias>NAME</alias>…</to-alias-list>
// Aliases/Address groups are resolved by parse_watchguard.ts.

import type { RawConfig, AliasUniverse, ResolvedAlias } from './parse_watchguard';

export type UnifiedPolicy = {
  id: string;
  name: string;
  service?: string;
  fromAliases: string[]; // as read from XML (alias names)
  toAliases: string[];
  srcCidrs: string[];
  dstCidrs: string[];
  srcHosts: string[];
  dstHosts: string[];
  source: 'XML' | 'XLS' | 'PDF';
  tags?: string[];
  nat?: { dnat?: boolean; oneToOne?: boolean };
  debug?: string[];
};

type PolicyNode = {
  name: string;
  id: string;
  service?: string;
  fromNames: string[];
  toNames: string[];
  nat?: { dnat?: boolean; oneToOne?: boolean };
};

type AbsPolicyNode = {
  name: string;
  fromNames: string[];
  toNames: string[];
  policyNames: string[];
};

// ---------------- helpers ----------------

function els(el: Element | Document, selector: string): Element[] {
  return Array.from(el.querySelectorAll(selector));
}
function textContent(el: Element | null, tag: string): string | undefined {
  if (!el) return undefined;
  const child = el.querySelector(tag);
  return child ? (child.textContent || undefined) : undefined;
}
function directText(el: Element | null): string | undefined {
  return el ? (el.textContent || undefined) : undefined;
}

// ---------------- main ----------------

export function xmlPoliciesToUnified(raw: RawConfig, universe: AliasUniverse): UnifiedPolicy[] {
  const doc = new DOMParser().parseFromString(raw.xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Invalid XML');

  const concrete = parseConcretePolicies(doc);
  const abs = parseAbsPolicies(doc);

  // Index concrete policies by name for abs overlays
  const byName = new Map(concrete.map(p => [p.name, p]));

  // Start with concrete
  const unified: UnifiedPolicy[] = concrete.map(p => materializeUnified(p, universe, 'XML'));

  // Apply abs overlays
  for (const a of abs) {
    for (const target of a.policyNames) {
      const base = byName.get(target);
      if (!base) continue;
      const merged: PolicyNode = {
        ...base,
        fromNames: a.fromNames.length ? a.fromNames : base.fromNames,
        toNames: a.toNames.length ? a.toNames : base.toNames,
      };
      unified.push(materializeUnified(merged, universe, 'XML'));
    }
  }

  // Deduplicate by content
  const seen = new Set<string>();
  const out: UnifiedPolicy[] = [];
  for (const u of unified) {
    const key = JSON.stringify({
      n: u.name,
      s: u.service ?? '',
      f: [...u.srcCidrs].sort(),
      t: [...u.dstCidrs].sort(),
      fh: [...u.srcHosts].sort(),
      th: [...u.dstHosts].sort(),
    });
    if (!seen.has(key)) { seen.add(key); out.push(u); }
  }
  return out;
}

// ---------------- parsers ----------------

function parseConcretePolicies(doc: Document): PolicyNode[] {
  const out: PolicyNode[] = [];
  els(doc, 'policy-list > policy').forEach(p => {
    const name = textContent(p, 'name') || '';
    const id = textContent(p, 'policy-id') || name;
    const service = textContent(p, 'service');

    // YOUR XML: from-alias-list > alias (text), to-alias-list > alias (text)
    const fromNames = els(p, 'from-alias-list > alias')
      .map(a => (a.textContent || '').trim())
      .filter(Boolean);
    const toNames = els(p, 'to-alias-list > alias')
      .map(a => (a.textContent || '').trim())
      .filter(Boolean);

    const nat = parseNatFlags(p);
    out.push({ name, id, service, fromNames, toNames, nat });
  });
  return out;
}

function parseAbsPolicies(doc: Document): AbsPolicyNode[] {
  const out: AbsPolicyNode[] = [];
  els(doc, 'abs-policy-list > abs-policy').forEach(ap => {
    const fromNames = els(ap, 'from-alias-list > alias')
      .map(a => (a.textContent || '').trim())
      .filter(Boolean);
    const toNames = els(ap, 'to-alias-list > alias')
      .map(a => (a.textContent || '').trim())
      .filter(Boolean);
    const policyNames = els(ap, 'policy-list > policy > name')
      .map(n => (n.textContent || '').trim())
      .filter(Boolean);
    out.push({ name: textContent(ap, 'name') || '', fromNames, toNames, policyNames });
  });
  return out;
}

function parseNatFlags(p: Element): PolicyNode['nat'] {
  const dnat = p.querySelector('dnat') ? true : undefined;
  const oneToOne = p.querySelector('one-to-one-nat') ? true : undefined;
  if (dnat || oneToOne) return { dnat, oneToOne };
  return undefined;
}

// ---------------- materialization ----------------

function resolveAliasList(names: string[], universe: AliasUniverse): { cidrs: Set<string>, hosts: Set<string>, notes: string[] } {
  const cidrs = new Set<string>();
  const hosts = new Set<string>();
  const notes: string[] = [];

  for (const n of names) {
    if (!n) continue;
    const r: ResolvedAlias = universe.resolveAlias(n);
    r.cidrs.forEach(c => cidrs.add(c));
    r.hosts.forEach(h => hosts.add(h));
    if (r.notes.length) notes.push(...r.notes.map(x => `[${n}] ${x}`));
  }

  return { cidrs, hosts, notes };
}

function materializeUnified(node: PolicyNode, universe: AliasUniverse, source: 'XML' | 'XLS'): UnifiedPolicy {
  const from = resolveAliasList(node.fromNames, universe);
  const to = resolveAliasList(node.toNames, universe);

  return {
    id: node.id,
    name: node.name,
    service: node.service,
    fromAliases: node.fromNames,
    toAliases: node.toNames,
    srcCidrs: Array.from(from.cidrs),
    dstCidrs: Array.from(to.cidrs),
    srcHosts: Array.from(from.hosts),
    dstHosts: Array.from(to.hosts),
    source,
    nat: node.nat,
    tags: [],
    debug: [...from.notes, ...to.notes],
  };
}
