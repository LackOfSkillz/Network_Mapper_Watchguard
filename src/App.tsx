// src/App.tsx
import React from 'react';
import cytoscape, { Core } from 'cytoscape';

// Data + parsing
import { parseWatchGuardXml, toDomain, makeAliasUniverse, type InterfaceInfo } from './parse_watchguard';
import { xmlPoliciesToUnified, type UnifiedPolicy } from './xml_to_upolicy';
import { parsePoliciesXls } from './parse_xls';
import { mergePolicies } from './merge_policies';

// ---------------- IPv4 helpers ----------------
function ipToInt(ip: string): number {
  const [a,b,c,d] = ip.split('.').map((x)=>parseInt(x,10));
  return (((a<<24)>>>0) + (b<<16) + (c<<8) + d)>>>0;
}
function intToIp(n: number): string {
  return [(n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255].join('.');
}
function maskBits(bits: number): number {
  return bits===0 ? 0 : (~0 << (32-bits))>>>0;
}
function cidrContainsIp(cidr: string, ip: string): boolean {
  const [n,bitsStr] = cidr.split('/');
  const bits = parseInt(bitsStr,10);
  const mask = maskBits(bits);
  return (ipToInt(ip)&mask) === (ipToInt(n)&mask);
}
function overlaps(a: string, b: string): boolean {
  const [na,ba]=a.split('/'); const [nb,bb]=b.split('/');
  const ma = maskBits(parseInt(ba,10)); const mb = maskBits(parseInt(bb,10));
  const ia = ipToInt(na); const ib = ipToInt(nb);
  return (ia & ma) === (ib & ma) || (ia & mb) === (ib & mb) || (
    ((ia & ma) <= (ib & mb)) && ((ib & mb) <= ((ia & ma) + (~ma>>>0)))
  );
}
function to24(ipOrCidr: string): string {
  const ip = ipOrCidr.includes('/') ? ipOrCidr.split('/')[0] : ipOrCidr;
  const n = ipToInt(ip);
  const base = n & maskBits(24);
  return `${intToIp(base)}/24`;
}
function prefixLen(cidr: string): number {
  const p = parseInt(cidr.split('/')[1]||'32',10);
  return Number.isFinite(p)?p:32;
}

// ---------------- Types ----------------
type Domain = ReturnType<typeof toDomain>;
type Snapshot = {
  domain?: Domain;
  xmlPolicies?: UnifiedPolicy[];
  xlsPolicies?: UnifiedPolicy[];
  policies?: UnifiedPolicy[];
};

// ---------------- Component ----------------
export default function App() {
  // File inputs (hidden)
  const xmlInputRef = React.useRef<HTMLInputElement | null>(null);
  const xlsInputRef = React.useRef<HTMLInputElement | null>(null);

  // State
  const [snap, setSnap] = React.useState<Snapshot>({});
  const [activeSubnet, setActiveSubnet] = React.useState<string | null>(null); // wheel node (network)
  const [activeHost, setActiveHost] = React.useState<string | null>(null);     // clicked host in panel
  const [searchIp, setSearchIp] = React.useState('');
  const [log, setLog] = React.useState<string[]>([]);
  const [error, setError] = React.useState<string | null>(null);

  // Cytoscape
  const cyContainerRef = React.useRef<HTMLDivElement | null>(null);
  const cyRef = React.useRef<Core | null>(null);

  // Logging
  const logMsg = React.useCallback((m: string) => {
    setLog(prev => [m, ...prev].slice(0, 400));
    console.log('[DEBUG]', m);
  }, []);

  // Pickers
  const clickXmlPicker = React.useCallback(() => { setError(null); xmlInputRef.current?.click(); }, []);
  const clickXlsPicker = React.useCallback(() => { setError(null); xlsInputRef.current?.click(); }, []);

  // onChange handlers
  const onPickXml = React.useCallback(async (e?: React.ChangeEvent<HTMLInputElement>) => {
    try {
      setError(null);
      const files = e?.target?.files ?? xmlInputRef.current?.files;
      if (!files || files.length === 0) { logMsg('XML picker closed without a file.'); return; }
      const xmlFile = files[0];

      logMsg(`Loading XML: ${xmlFile.name}`);

      const raw = await parseWatchGuardXml(xmlFile);
      const domain = toDomain(raw);
      const univ = makeAliasUniverse(raw, domain);
      const xmlPolicies = xmlPoliciesToUnified(raw, univ);

      setSnap(prev => {
        const merged = mergePolicies(xmlPolicies, prev.xlsPolicies ?? []);
        return { ...prev, domain, xmlPolicies, policies: merged };
      });

      if (xmlInputRef.current) xmlInputRef.current.value = '';
      const ifaceCount = domain.interfaces.length;
      const cidrCount = domain.interfaces.reduce((a, i) => a + i.cidrs.length, 0);
      logMsg(`XML loaded. Interfaces: ${ifaceCount}, interface CIDRs: ${cidrCount}, XML policies: ${xmlPolicies.length}`);
    } catch (err: any) {
      console.error(err);
      const msg = `XML load failed: ${String(err?.message || err)}`;
      setError(msg); logMsg(msg);
    }
  }, [logMsg]);

  const onPickXls = React.useCallback(async (e?: React.ChangeEvent<HTMLInputElement>) => {
    try {
      setError(null);
      const files = e?.target?.files ?? xlsInputRef.current?.files;
      if (!files || files.length === 0) { logMsg('XLS picker closed without a file.'); return; }
      const xlsFile = files[0];

      logMsg(`Loading XLS: ${xlsFile.name}`);

      const xlsPolicies = await parsePoliciesXls(xlsFile);
      setSnap(prev => {
        const merged = mergePolicies(prev.xmlPolicies ?? [], xlsPolicies);
        return { ...prev, xlsPolicies, policies: merged };
      });

      if (xlsInputRef.current) xlsInputRef.current.value = '';
      logMsg(`XLS loaded. XLS policies: ${xlsPolicies.length}`);
    } catch (err: any) {
      console.error(err);
      const msg = `XLS load failed: ${String(err?.message || err)}`;
      setError(msg); logMsg(msg);
    }
  }, [logMsg]);

  // ---------- Build wheel nodes as NETWORKS, not /32 hosts ----------
  type WheelSubnet = { id: string; cidr: string; label: string; interfaceName?: string; vlanId?: string; derived?: boolean };

  const wheelSubnets = React.useMemo<WheelSubnet[]>(() => {
    const out: WheelSubnet[] = [];
    const domain = snap.domain;

    // 1) Prefer explicit interface networks (skip /32)
    if (domain && domain.interfaces.length) {
      for (const intf of domain.interfaces) {
        for (const cidr of intf.cidrs) {
          const pfx = prefixLen(cidr);
          if (pfx < 32) {
            out.push({
              id: `${intf.name}::${cidr}`,
              cidr,
              label: `${cidr}\n(${intf.name}${intf.vlanId ? ` | VLAN ${intf.vlanId}` : ''})`,
              interfaceName: intf.name,
              vlanId: intf.vlanId,
            });
          }
        }
      }
      if (out.length) return out;
    }

    // 2) Fallback: derive /24 networks from policies’ CIDRs and hosts
    const uniq = new Set<string>();
    for (const p of (snap.policies ?? [])) {
      for (const c of p.srcCidrs) {
        if (!c) continue;
        const pfx = prefixLen(c);
        if (pfx === 32) uniq.add(to24(c));
        else uniq.add(pfx >= 24 ? to24(c) : c); // keep broader nets, bucket >=/24 at /24
      }
      for (const c of p.dstCidrs) {
        if (!c) continue;
        const pfx = prefixLen(c);
        if (pfx === 32) uniq.add(to24(c));
        else uniq.add(pfx >= 24 ? to24(c) : c);
      }
    }
    // Build wheel nodes
    Array.from(uniq).forEach(cidr => {
      out.push({ id: `derived::${cidr}`, cidr, label: `${cidr}\n(derived)`, derived: true });
    });
    logMsg(`Derived ${out.length} network nodes for visualization.`);
    return out;
  }, [snap.domain, snap.policies, logMsg]);

  // ---------- Cytoscape rendering ----------
  React.useEffect(() => {
    if (!cyContainerRef.current) return;

    if (!cyRef.current) {
      cyRef.current = cytoscape({
        container: cyContainerRef.current,
        elements: [],
        style: [
          { selector: 'node', style: { 'background-color': '#4b5563', 'label': 'data(label)', 'font-size': 10, 'color': '#e5e7eb', 'text-wrap': 'wrap' } },
          { selector: 'edge', style: { 'width': 1, 'line-color': '#9ca3af', 'curve-style': 'straight', 'target-arrow-shape': 'triangle', 'target-arrow-color': '#9ca3af', 'label': 'data(label)', 'font-size': 9, 'color': '#cbd5e1' } },
          { selector: '.active', style: { 'background-color': '#60a5fa', 'line-color': '#60a5fa', 'target-arrow-color': '#60a5fa' } },
        ],
      });
    }
    const cy = cyRef.current!;
    cy.elements().remove();

    cy.add({ group: 'nodes', data: { id: 'firewall', label: 'Firebox' }, position: { x: 0, y: 0 } });

    wheelSubnets.forEach((s) => {
      cy.add({ group: 'nodes', data: { id: s.id, label: s.label } });
      const edgeLabel = s.interfaceName ? s.interfaceName : (s.derived ? '(derived)' : '');
      cy.add({ group: 'edges', data: { id: `e-${s.id}`, source: 'firewall', target: s.id, label: edgeLabel } });
    });

    cy.layout({ name: 'circle', radius: 300, animate: false }).run();

    cy.off('tap');
    cy.on('tap', 'node', (evt) => {
      const id: string = evt.target.id();
      if (id === 'firewall') return;
      const n = wheelSubnets.find(x => x.id === id);
      if (!n) return;
      setActiveSubnet(prev => (prev === n.cidr ? null : n.cidr));
      setActiveHost(null);
    });
  }, [wheelSubnets]);

  // ---------- Compute Hosts + Policies for selected network ----------
  const allPolicies = snap.policies ?? [];

  // Policies that affect a given subnet (any src/dst overlap)
  const policiesForSubnet = React.useCallback((subnet: string): UnifiedPolicy[] => {
    return allPolicies.filter(p =>
      p.srcCidrs.some(c => c && overlaps(c, subnet)) ||
      p.dstCidrs.some(c => c && overlaps(c, subnet)) ||
      p.srcHosts.some(h => cidrContainsIp(subnet, h)) ||
      p.dstHosts.some(h => cidrContainsIp(subnet, h))
    );
  }, [allPolicies]);

  // Hosts explicitly mentioned in policies for the subnet (/32 only)
  const hostsForSubnet = React.useCallback((subnet: string): string[] => {
    const h = new Set<string>();
    for (const p of policiesForSubnet(subnet)) {
      for (const ip of p.srcHosts) if (cidrContainsIp(subnet, ip)) h.add(ip);
      for (const ip of p.dstHosts) if (cidrContainsIp(subnet, ip)) h.add(ip);
      // if policy uses /32 in cidrs but not in hosts arrays, include them too
      for (const c of p.srcCidrs) if (c && prefixLen(c)===32) { const ip = c.split('/')[0]; if (cidrContainsIp(subnet, ip)) h.add(ip); }
      for (const c of p.dstCidrs) if (c && prefixLen(c)===32) { const ip = c.split('/')[0]; if (cidrContainsIp(subnet, ip)) h.add(ip); }
    }
    return Array.from(h).sort();
  }, [policiesForSubnet]);

  const visiblePolicies = React.useMemo(() => {
    if (!activeSubnet) return allPolicies;
    const sub = policiesForSubnet(activeSubnet);
    if (!activeHost) return sub;
    return sub.filter(p =>
      p.srcHosts.includes(activeHost) || p.dstHosts.includes(activeHost) ||
      p.srcCidrs.some(c => c && prefixLen(c)===32 && c.startsWith(activeHost + '/')) ||
      p.dstCidrs.some(c => c && prefixLen(c)===32 && c.startsWith(activeHost + '/'))
    );
  }, [allPolicies, activeSubnet, activeHost, policiesForSubnet]);

  const hostList = React.useMemo(() => {
    if (!activeSubnet) return [];
    return hostsForSubnet(activeSubnet);
  }, [activeSubnet, hostsForSubnet]);

  // ---------- Search (select /24 node for an IP) ----------
  const onSearch = React.useCallback(() => {
    const ip = searchIp.trim();
    if (!ip) return;
    // try exact matching among wheel subnets
    let found: string | null = null;
    for (const s of wheelSubnets) {
      if (cidrContainsIp(s.cidr, ip)) { found = s.cidr; break; }
    }
    // fallback: /24
    if (!found) found = to24(ip);
    setActiveSubnet(found);
    setActiveHost(ip);
    logMsg(found ? `Selected subnet ${found} for host ${ip}` : `No subnet contains ${ip}`);
  }, [searchIp, wheelSubnets, logMsg]);

  // ---- Counts & layout ----
  const xmlCount = snap.xmlPolicies?.length ?? 0;
  const xlsCount = snap.xlsPolicies?.length ?? 0;
  const mergedCount = allPolicies.length;
  const headerHeight = 44;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', height: '100vh', background: '#0f172a', color: '#e2e8f0' }}>
      {/* LEFT: Graph */}
      <div style={{ position: 'relative' }}>
        <div
          style={{
            height: headerHeight, padding: '8px 10px', borderBottom: '1px solid #1f2937',
            display: 'flex', gap: 8, alignItems: 'center', position: 'relative', zIndex: 2, background: '#0f172a',
          }}
        >
          <button onClick={()=>xmlInputRef.current?.click()} style={{ background: 'transparent', color: '#93c5fd', border: 'none', padding: '6px 10px', borderRadius: 6, cursor: 'pointer' }}>
            Load XML
          </button>
          <button onClick={()=>xlsInputRef.current?.click()} style={{ background: 'transparent', color: '#93c5fd', border: 'none', padding: '6px 10px', borderRadius: 6, cursor: 'pointer' }}>
            Load XLS/XLSX
          </button>
          <div style={{ marginLeft: 12, opacity: 0.9 }}>
            XML: {xmlCount} &nbsp;|&nbsp; XLS: {xlsCount} &nbsp;|&nbsp; Total: {mergedCount}
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <input
              value={searchIp}
              onChange={(e) => setSearchIp(e.target.value)}
              placeholder="Search IP (e.g., 10.0.0.5)"
              style={{ background: '#0b1220', border: '1px solid #1f2937', color: '#e2e8f0', padding: '6px 8px', borderRadius: 6, width: 220 }}
            />
            <button onClick={onSearch} style={{ background: '#1d4ed8', border: 'none', color: 'white', padding: '6px 10px', borderRadius: 6 }}>Go</button>
          </div>
          {/* hidden inputs */}
          <input type="file" accept=".xml" ref={xmlInputRef} onChange={onPickXml} style={{ display: 'none' }} />
          <input type="file" accept=".xls,.xlsx" ref={xlsInputRef} onChange={onPickXls} style={{ display: 'none' }} />
        </div>

        <div ref={cyContainerRef} style={{ position: 'absolute', zIndex: 1, top: headerHeight, left: 0, right: 0, bottom: 0 }} />
      </div>

      {/* RIGHT: Panels */}
      <div style={{ display: 'grid', gridTemplateRows: 'min-content minmax(80px, 0.8fr) minmax(160px, 1.2fr)', borderLeft: '1px solid #1f2937' }}>
        {/* Selection */}
        <div style={{ padding: 10, borderBottom: '1px solid #1f2937' }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Selection</div>
          <div>Subnet: <span style={{ color: '#93c5fd' }}>{activeSubnet ?? '—'}</span></div>
          <div>Host: <span style={{ color: '#93c5fd' }}>{activeHost ?? '—'}</span></div>
          {error && <div style={{ marginTop: 6, color: '#fca5a5' }}>{error}</div>}
        </div>

        {/* Hosts (explicit /32s only) */}
        <div style={{ padding: 10, borderBottom: '1px solid #1f2937', overflow: 'auto' }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Hosts {activeSubnet ? `(in ${activeSubnet})` : ''}</div>
          {activeSubnet ? (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 6 }}>
              {hostList.map(h => (
                <li key={h} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button
                    onClick={() => setActiveHost(prev => prev === h ? null : h)}
                    style={{
                      background: activeHost === h ? '#1d4ed8' : '#0b1220',
                      border: '1px solid #1f2937',
                      color: '#e2e8f0',
                      padding: '6px 8px',
                      borderRadius: 6,
                      width: '100%',
                      textAlign: 'left',
                      cursor: 'pointer'
                    }}
                  >
                    {h}
                  </button>
                </li>
              ))}
              {hostList.length === 0 && <li style={{ opacity: 0.7 }}>No hosts explicitly referenced by policies.</li>}
            </ul>
          ) : (
            <div style={{ opacity: 0.7 }}>Select a subnet to see hosts.</div>
          )}
        </div>

        {/* Policies */}
        <div style={{ padding: 10, overflow: 'auto' }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>
            Policies {activeHost ? `(host ${activeHost})` : activeSubnet ? `(subnet ${activeSubnet})` : ''}
          </div>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 6 }}>
            {visiblePolicies.slice(0, 500).map(p => (
              <li key={`${p.source}-${p.id}-${p.name}`} style={{ background: '#0b1220', border: '1px solid #1f2937', borderRadius: 8, padding: 8 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ fontWeight: 600 }}>{p.name}</span>
                  <span style={{ fontSize: 12, opacity: 0.8 }}>{p.service ?? ''}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 12, background: p.source === 'XML' ? '#334155' : '#52525b', padding: '2px 6px', borderRadius: 999 }}>
                    {p.source}
                  </span>
                </div>
                <div style={{ marginTop: 4, fontSize: 12, opacity: 0.9 }}>
                  src: {p.srcCidrs.join(', ') || '—'} &nbsp;→&nbsp; dst: {p.dstCidrs.join(', ') || '—'}
                </div>
              </li>
            ))}
            {visiblePolicies.length === 0 && <li style={{ opacity: 0.7 }}>No policies to display.</li>}
          </ul>

          {/* Debug */}
          <div style={{ marginTop: 10 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Debug</div>
            <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 12, color: '#cbd5e1' }}>
{log.join('\n')}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
