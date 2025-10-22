// src/alias_universe.ts
import type { RawFW } from './parse_watchguard'

export type Domain = {
  ifaceNets: Array<{ cidr:string; iface:string; metaName?:string; metaDesc?:string; zone?: 'Trusted'|'Optional'|'External' }>
  networks: Array<{ cidr:string; desc:string; viaInterface:string }>
}

export type ResolvedAlias = {
  any?: boolean
  firebox?: boolean
  zone?: 'Trusted'|'Optional'|'External'
  hosts: Set<string>
  nets: Set<string>
  ifaces: Set<string>
}

export function makeAliasUniverse(raw: RawFW, domain: Domain) {
  const rawMap = new Map<string, Array<{ kind:string; value:string }>>()
  raw.ags.forEach(ag => rawMap.set(ag.name, ag.members as any))

  // treat interface names as aliases → map to their subnets
  for (const i of domain.ifaceNets) {
    rawMap.set(i.iface, [{ kind: 'network', value: i.cidr } as any])
  }

  // built-ins
  rawMap.set('Any', [])
  rawMap.set('Firebox', [])
  rawMap.set('Any-Trusted', [])
  rawMap.set('Any-Optional', [])
  rawMap.set('Any-External', [])

  const ifaceZone = new Map(domain.ifaceNets.map(n => [n.iface, n.zone]))

  const memo = new Map<string, ResolvedAlias>()
  const expanding = new Set<string>()

  const isIPv4  = (s: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s)
  const isCIDR  = (s: string) => /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(s)

  const resolve = (name: string): ResolvedAlias => {
    if (memo.has(name)) return memo.get(name)!
    const out: ResolvedAlias = { hosts: new Set(), nets: new Set(), ifaces: new Set() }
    memo.set(name, out)
    expanding.add(name)

    const n = name.trim()

    // virtuals + literals
    if (/^any$/i.test(n)) { out.any = true; expanding.delete(name); return out }
    if (/^firebox$/i.test(n)) { out.firebox = true; expanding.delete(name); return out }
    if (/^any-?trusted$/i.test(n)) { out.zone = 'Trusted'; expanding.delete(name); return out }
    if (/^any-?optional$/i.test(n)) { out.zone = 'Optional'; expanding.delete(name); return out }
    if (/^any-?external$/i.test(n)) { out.zone = 'External'; expanding.delete(name); return out }

    if (n.startsWith('host:')) { out.hosts.add(n.slice(5)); expanding.delete(name); return out }
    if (n.startsWith('net:'))  { out.nets.add(n.slice(4)); expanding.delete(name); return out }
    if (isIPv4(n)) { out.hosts.add(n); expanding.delete(name); return out }
    if (isCIDR(n)) { out.nets.add(n);  expanding.delete(name); return out }

    // expand alias / group membership
    const members = rawMap.get(n) || []
    for (const m of members) {
      const kind = (m as any).kind
      const value = (m as any).value
      if (kind === 'host') out.hosts.add(value)
      else if (kind === 'network') out.nets.add(value)
      else if (kind === 'iface') out.ifaces.add(value)
      else if (kind === 'alias') {
        if (!expanding.has(value)) {
          const r = resolve(value)
          r.hosts.forEach(v => out.hosts.add(v))
          r.nets.forEach(v => out.nets.add(v))
          r.ifaces.forEach(v => out.ifaces.add(v))
          if (r.any) out.any = true
          if (r.firebox) out.firebox = true
          if (r.zone) out.zone = r.zone
        }
      }
    }

    expanding.delete(name)
    return out
  }

  return { resolve, ifaceZone }
}
