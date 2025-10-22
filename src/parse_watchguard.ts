// src/parse_watchguard.ts
// WatchGuard XML parser + alias/address-group resolver tailored to City of Ocala exports.
//
// Exports:
//   parseWatchGuardXml(file: File): Promise<RawConfig>
//   toDomain(raw: RawConfig): Domain
//   makeAliasUniverse(raw: RawConfig, domain: Domain): AliasUniverse

export type Cidr = string;

export type InterfaceInfo = {
  name: string;
  zone?: 'Trusted' | 'Optional' | 'External' | 'Custom';
  cidrs: Cidr[];
  vlanId?: string; // <-- NEW: for vlan-interface nodes
};

export type AddressGroupMember =
  | { kind: 'host'; ip: string }
  | { kind: 'network'; ip: string; mask: string };

export type AddressGroup = {
  name: string;
  members: AddressGroupMember[];
};

export type AliasMember =
  | { kind: 'alias-ref'; aliasName: string }      // <alias-name>
  | { kind: 'address-ref'; addressName: string }  // <address> points to address-group name
  | { kind: 'interface-any'; interface?: string; zone?: string } // Any tied to interface
  | { kind: 'builtin'; name: string };            // Any, Any-Trusted, Firebox, etc.

export type AliasNode = {
  name: string;
  members: AliasMember[];
};

export type RawConfig = {
  xmlText: string;
  aliasesByName: Map<string, AliasNode>;
  addrGroupsByName: Map<string, AddressGroup>;
  interfacesByName: Map<string, InterfaceInfo>;
};

export type Domain = {
  interfaces: InterfaceInfo[];
  cidrsByInterface: Map<string, Cidr[]>;
  zoneByInterface: Map<string, InterfaceInfo['zone']>;
  zoneCidrs: Map<string, Cidr[]>;
};

export type ResolvedAlias = {
  cidrs: Set<Cidr>;
  hosts: Set<string>;
  notes: string[];
};

export type AliasUniverse = {
  resolveAlias: (name: string) => ResolvedAlias;
  isBuiltin: (name: string) => boolean;
};

// ----------------------------- helpers -----------------------------

function textContent(el: Element | null, tag: string): string | undefined {
  if (!el) return undefined;
  const child = el.querySelector(tag);
  return child ? (child.textContent || undefined) : undefined;
}
function els(el: Element | Document, selector: string): Element[] {
  return Array.from(el.querySelectorAll(selector));
}
function maskToPrefix(mask: string): number {
  const octets = mask.split('.').map(n => parseInt(n, 10));
  let bits = 0;
  for (const o of octets) bits += ((o >>> 0).toString(2).match(/1/g) || []).length;
  return bits;
}
function toCidr(ip: string, mask: string): string {
  const pfx = maskToPrefix(mask);
  return `${ip}/${pfx}`;
}

// ----------------------------- parsing -----------------------------

export async function parseWatchGuardXml(file: File): Promise<RawConfig> {
  const xmlText = await file.text();
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Invalid XML');

  const aliasesByName = parseAliases(doc);
  const addrGroupsByName = parseAddressGroups(doc);
  const interfacesByName = parseInterfaces(doc);

  return { xmlText, aliasesByName, addrGroupsByName, interfacesByName };
}

const BUILTINS = new Set(['Any-Trusted', 'Any-Optional', 'Any-External', 'Firebox', 'Any']);

function parseAliases(doc: Document): Map<string, AliasNode> {
  // Your XML: alias-member-list > alias-member
  const map = new Map<string, AliasNode>();
  els(doc, 'alias-list > alias').forEach(a => {
    const name = textContent(a, 'name') || '';
    const members: AliasMember[] = [];

    els(a, 'alias-member-list > alias-member').forEach(m => {
      const t = textContent(m, 'type');
      if (t === '2') {
        const aliasName = textContent(m, 'alias-name');
        if (aliasName) members.push({ kind: 'alias-ref', aliasName });
      } else if (t === '1') {
        const addressName = textContent(m, 'address');
        const iface = textContent(m, 'interface');
        if (addressName) {
          if (addressName.toLowerCase() === 'any') {
            if (iface && iface.length) members.push({ kind: 'interface-any', interface: iface });
            else members.push({ kind: 'builtin', name: 'Any' });
          } else {
            members.push({ kind: 'address-ref', addressName });
          }
        }
      } else if (t === '3') {
        const n = textContent(m, 'alias-name') || textContent(m, 'name');
        if (n) members.push({ kind: 'builtin', name: n });
      }
    });

    if (BUILTINS.has(name)) members.push({ kind: 'builtin', name });
    map.set(name, { name, members });
  });
  return map;
}

function parseAddressGroups(doc: Document): Map<string, AddressGroup> {
  // Your XML: <addr-group-member><member>...</member>
  const map = new Map<string, AddressGroup>();
  els(doc, 'address-group-list > address-group').forEach(ag => {
    const name = textContent(ag, 'name') || '';
    const members: AddressGroupMember[] = [];
    els(ag, 'addr-group-member > member').forEach(m => {
      const type = textContent(m, 'type');
      if (type === '1') {
        const ip = textContent(m, 'host-ip-addr');
        if (ip) members.push({ kind: 'host', ip });
      } else if (type === '2') {
        const ip = textContent(m, 'ip-network-addr');
        const mask = textContent(m, 'ip-mask');
        if (ip && mask) members.push({ kind: 'network', ip, mask });
      }
    });
    map.set(name, { name, members });
  });
  return map;
}

function parseInterfaces(doc: Document): Map<string, InterfaceInfo> {
  const map = new Map<string, InterfaceInfo>();

  // Physical interfaces
  els(doc, 'interface-list > interface').forEach(intf => {
    const name = textContent(intf, 'name') || '';
    const zone = (textContent(intf, 'zone') as InterfaceInfo['zone']) || 'Custom';
    const cidrs: string[] = [];
    const ip = textContent(intf, 'ip-addr');
    const mask = textContent(intf, 'ip-mask');
    if (ip && mask) cidrs.push(toCidr(ip, mask));
    els(intf, 'secondary-ip-list > secondary-ip').forEach(s => {
      const sip = textContent(s, 'ip-addr');
      const smask = textContent(s, 'ip-mask');
      if (sip && smask) cidrs.push(toCidr(sip, smask));
    });
    if (name) map.set(name, { name, zone, cidrs });
  });

  // VLAN interfaces
  els(doc, 'vlan-interface-list > vlan-interface').forEach(v => {
    const name = textContent(v, 'name') || '';
    const zone = (textContent(v, 'zone') as InterfaceInfo['zone']) || 'Custom';
    const vlanId = textContent(v, 'vid') || textContent(v, 'vlan-id') || undefined; // common tags
    const cidrs: string[] = [];
    const ip = textContent(v, 'ip-addr');
    const mask = textContent(v, 'ip-mask');
    if (ip && mask) cidrs.push(toCidr(ip, mask));
    els(v, 'secondary-ip-list > secondary-ip').forEach(s => {
      const sip = textContent(s, 'ip-addr');
      const smask = textContent(s, 'ip-mask');
      if (sip && smask) cidrs.push(toCidr(sip, smask));
    });
    if (name) map.set(name, { name, zone, cidrs, vlanId });
  });

  return map;
}

// ------------------------------- Domain --------------------------------

export function toDomain(raw: RawConfig): Domain {
  const cidrsByInterface = new Map<string, Cidr[]>();
  const zoneByInterface = new Map<string, InterfaceInfo['zone']>();
  const zoneCidrs = new Map<string, Cidr[]>();

  for (const [name, info] of raw.interfacesByName.entries()) {
    cidrsByInterface.set(name, info.cidrs);
    zoneByInterface.set(name, info.zone);
    if (info.zone) {
      const arr = zoneCidrs.get(info.zone) || [];
      zoneCidrs.set(info.zone, arr.concat(info.cidrs));
    }
  }

  return {
    interfaces: Array.from(raw.interfacesByName.values()),
    cidrsByInterface,
    zoneByInterface,
    zoneCidrs,
  };
}

// --------------------------- Alias resolution ---------------------------

const BUILTIN_TO_ZONE: Record<string, InterfaceInfo['zone'] | undefined> = {
  'Any-Trusted': 'Trusted',
  'Any-Optional': 'Optional',
  'Any-External': 'External',
};

export function makeAliasUniverse(raw: RawConfig, domain: Domain) {
  const { aliasesByName, addrGroupsByName } = raw;

  function isBuiltin(name: string): boolean {
    return BUILTINS.has(name) || BUILTIN_TO_ZONE[name] !== undefined || name === 'Firebox';
  }
  function builtinToCidrs(name: string): Cidr[] {
    if (name === 'Any') return domain.interfaces.flatMap(i => i.cidrs);
    if (name === 'Firebox') return [];
    const zone = BUILTIN_TO_ZONE[name];
    if (!zone) return [];
    return domain.zoneCidrs.get(zone) || [];
  }
  function interfaceAnyToCidrs(iface?: string, zone?: string): Cidr[] {
    if (iface && domain.cidrsByInterface.has(iface)) return domain.cidrsByInterface.get(iface)!;
    if (zone) return domain.zoneCidrs.get(zone) || [];
    return domain.interfaces.flatMap(i => i.cidrs);
  }
  function expandAddressGroup(name: string): ResolvedAlias {
    const ag = addrGroupsByName.get(name);
    if (!ag) return { cidrs: new Set(), hosts: new Set(), notes: [`Address-group not found: ${name}`] };
    const cidrs = new Set<Cidr>();
    const hosts = new Set<string>();
    for (const mem of ag.members) {
      if (mem.kind === 'host') { hosts.add(mem.ip); cidrs.add(`${mem.ip}/32`); }
      else if (mem.kind === 'network') { cidrs.add(toCidr(mem.ip, mem.mask)); }
    }
    return { cidrs, hosts, notes: [] };
  }
  function resolveAliasInternal(name: string, seen: Set<string>): ResolvedAlias {
    if (seen.has(name)) return { cidrs: new Set(), hosts: new Set(), notes: [`Cycle detected at ${name}`] };
    seen.add(name);

    if (isBuiltin(name)) {
      const cidrs = builtinToCidrs(name);
      const notes = name === 'Firebox' ? ['Firebox (device) has no address space'] : [];
      return { cidrs: new Set(cidrs), hosts: new Set(), notes };
    }

    const node = aliasesByName.get(name);
    if (!node) {
      const agResolved = expandAddressGroup(name);
      if (agResolved.cidrs.size || agResolved.hosts.size) return agResolved;
      return { cidrs: new Set(), hosts: new Set(), notes: [`Alias not found: ${name}`] };
    }

    const cidrs = new Set<Cidr>();
    const hosts = new Set<string>();
    const notes: string[] = [];

    for (const m of node.members) {
      if (m.kind === 'alias-ref') {
        const r = resolveAliasInternal(m.aliasName, seen);
        r.cidrs.forEach(c => cidrs.add(c)); r.hosts.forEach(h => hosts.add(h)); notes.push(...r.notes);
      } else if (m.kind === 'address-ref') {
        const r = expandAddressGroup(m.addressName);
        r.cidrs.forEach(c => cidrs.add(c)); r.hosts.forEach(h => hosts.add(h)); notes.push(...r.notes);
      } else if (m.kind === 'interface-any') {
        interfaceAnyToCidrs(m.interface, m.zone).forEach(c => cidrs.add(c));
      } else if (m.kind === 'builtin') {
        builtinToCidrs(m.name).forEach(c => cidrs.add(c));
        if (m.name === 'Firebox') notes.push('Firebox (device) has no address space');
      }
    }

    return { cidrs, hosts, notes };
  }
  function resolveAlias(name: string): ResolvedAlias {
    return resolveAliasInternal(name, new Set());
  }

  return { resolveAlias, isBuiltin };
}
