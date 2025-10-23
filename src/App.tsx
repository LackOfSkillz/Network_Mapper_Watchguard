// src/App.tsx
import React from 'react';
import cytoscape, { Core } from 'cytoscape';
import LanOverlay from './lan/LanOverlay';

// Data + parsing
import { parseWatchGuardXml, parseWatchGuardXmlText, toDomain, makeAliasUniverse, type InterfaceInfo } from './parse_watchguard';
import { xmlPoliciesToUnified, type UnifiedPolicy } from './xml_to_upolicy';
import { mergePolicies } from './merge_policies';
import {
  initDb, listMaps, createMap, getMapXmlText, touchMap,
  getAnnotationMapFor, setAnnotationFor,
  updateMapName, saveMapXml,
  getAnnotationOffsetsFor, setAnnotationOffsetFor,
  getEdgeNotesFor, setEdgeNoteFor,
  addMapDevice, listMapDevices, getMapAllXmlTexts,
  deleteMap, renameFirstDeviceForMap,
  listManualHostIps,
  type MapRow
} from './db';

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
  policies?: UnifiedPolicy[];
};

// ---------------- Component ----------------
export default function App() {
  // Theme palette (dark, modern, high-contrast)
  const theme = {
    bg: '#0b1220',
    panelBg: '#0f1a2b',
    border: '#1f2a44',
    text: '#e6edf7',
    textDim: '#a1b3d6',
    nodeFill: '#1b2942',
    nodeBorder: '#3b4d75',
    nodeText: '#e6edf7',
    edge: '#6b7daa',
    edgeText: '#e6f0ff',
    edgeTextOutline: '#0b1220',
    accent: '#4f8ef7',
    accent2: '#2a6ad6',
    button: '#1d4ed8',
  } as const;
  // File inputs (hidden)
  const xmlInputRef = React.useRef<HTMLInputElement | null>(null);
  const xmlAddFwRef = React.useRef<HTMLInputElement | null>(null);

  // State
  const [snap, setSnap] = React.useState<Snapshot>({});
  const [activeSubnet, setActiveSubnet] = React.useState<string | null>(null); // wheel node (network)
  const [activeHost, setActiveHost] = React.useState<string | null>(null);     // clicked host in panel
  const [searchIp, setSearchIp] = React.useState('');
  const [log, setLog] = React.useState<string[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [annotations, setAnnotations] = React.useState<Map<string, string>>(new Map());
  const [mapsMenuOpen, setMapsMenuOpen] = React.useState(false);
  const [devicesMenuOpen, setDevicesMenuOpen] = React.useState(false);
  const [viewMenuOpen, setViewMenuOpen] = React.useState(false);
  const [helpMenuOpen, setHelpMenuOpen] = React.useState(false);
  const [maps, setMaps] = React.useState<MapRow[]>([]);
  const [mapId, setMapId] = React.useState<string | null>(null);
  const [mapName, setMapName] = React.useState<string | null>(null);
  const [pendingCreateName, setPendingCreateName] = React.useState<string | null>(null);
  const [lastXmlText, setLastXmlText] = React.useState<string | null>(null);
  const [lastXmlName, setLastXmlName] = React.useState<string | null>(null);
  
  const [labelOffsets, setLabelOffsets] = React.useState<Map<string, number>>(new Map());
  const [edgeNotes, setEdgeNotes] = React.useState<Map<string, string>>(new Map());
  const [editingEdge, setEditingEdge] = React.useState<{ cidr: string; value: string } | null>(null);
  const [editingNode, setEditingNode] = React.useState<{ cidr: string; value: string } | null>(null);
  const [firewalls, setFirewalls] = React.useState<Array<{ id: string; name: string; domain: Domain; xmlText?: string }>>([]);
  const [lanFocusSubnet, setLanFocusSubnet] = React.useState<string | null>(null);
  const mapIdRef = React.useRef<string | null>(null);
  React.useEffect(() => { mapIdRef.current = mapId; }, [mapId]);
  // Reduced motion
  const prefersReducedMotion = React.useMemo(() => {
    try { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
  }, []);

  // Cytoscape
  const cyContainerRef = React.useRef<HTMLDivElement | null>(null);
  const cyRef = React.useRef<Core | null>(null);
  const LAST_MAP_KEY = 'wgmap_last_map_id';

  // Logging
  const logMsg = React.useCallback((m: string) => {
    const line = `${new Date().toISOString()} ${m}`;
    setLog(prev => [line, ...prev].slice(0, 1000));
    try {
      const KEY = 'wgmap_debug_log';
      const arr: string[] = JSON.parse(sessionStorage.getItem(KEY) || '[]');
      arr.unshift(line);
      sessionStorage.setItem(KEY, JSON.stringify(arr.slice(0, 2000)));
    } catch {}
    console.log('[DEBUG]', line);
  }, []);

  React.useEffect(() => {
    try {
      const KEY = 'wgmap_debug_log';
      const arr: string[] = JSON.parse(sessionStorage.getItem(KEY) || '[]');
      arr.unshift(`===== NEW SESSION ${new Date().toISOString()} =====`);
      sessionStorage.setItem(KEY, JSON.stringify(arr.slice(0, 2000)));
    } catch {}
    const onError = (e: ErrorEvent) => logMsg(`window.error: ${e.message}`);
    const onRej = (e: PromiseRejectionEvent) => logMsg(`unhandledrejection: ${String(e.reason)}`);
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRej);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRej);
    };
  }, [logMsg]);

  // Pickers
  const clickXmlPicker = React.useCallback(() => { setError(null); xmlInputRef.current?.click(); }, []);
  
  const clickAddFirewallPicker = React.useCallback(() => { setError(null); xmlAddFwRef.current?.click(); }, []);
  const closeAllMenus = React.useCallback(() => {
    setMapsMenuOpen(false); setDevicesMenuOpen(false); setViewMenuOpen(false); setHelpMenuOpen(false);
  }, []);
  const onFitGraph = React.useCallback(() => {
    const cy = cyRef.current; if (!cy) return;
    try { cy.fit(cy.elements(), 50); } catch {}
  }, []);

  // Init DB and load maps list
  React.useEffect(() => {
    (async () => {
      try {
        await initDb();
        const rows = await listMaps();
        setMaps(rows);
        logMsg(`DB ready. Maps: ${rows.length}`);
        // Try to restore last opened map on load
        try {
          const lastId = localStorage.getItem(LAST_MAP_KEY);
          if (lastId) {
            // Defer a tick to let initial render settle
            setTimeout(() => { void loadMapById(lastId); }, 0);
          }
        } catch {}
      } catch (e: any) {
        console.error(e);
        logMsg('Annotation DB init failed; continuing without persistence.');
      }
    })();
  }, [logMsg]);

  // Helper to load a map by id and set all state accordingly
  const loadMapById = React.useCallback(async (id: string) => {
    try {
      const data = await getMapXmlText(id);
      if (!data) return;
      setLastXmlText(data.xmlText);
      const raw = await parseWatchGuardXmlText(data.xmlText);
      const domain = toDomain(raw);
      const univ = makeAliasUniverse(raw, domain);
      const xmlPolicies = xmlPoliciesToUnified(raw, univ);
      setSnap(prev => { const merged = mergePolicies(xmlPolicies, []); return { ...prev, domain, xmlPolicies, policies: merged }; });
      const all = await getMapAllXmlTexts(id);
      const fwArr: Array<{ id: string; name: string; domain: Domain; xmlText?: string }> = [];
      for (let i = 0; i < all.length; i++) {
        const entry = all[i];
        const r = await parseWatchGuardXmlText(entry.xmlText);
        const d = toDomain(r);
        const nm = entry.name || (i === 0 ? (data.xmlName || data.name) : `Device ${i+1}`);
        fwArr.push({ id: `fw-${i+1}`, name: nm, domain: d, xmlText: entry.xmlText });
      }
      setFirewalls(fwArr);
      const amap = await getAnnotationMapFor(id); setAnnotations(amap);
      const offs = await getAnnotationOffsetsFor(id); setLabelOffsets(offs);
      const enotes = await getEdgeNotesFor(id); setEdgeNotes(enotes);
      setMapId(id); setMapName(data.name);
      try { localStorage.setItem(LAST_MAP_KEY, id); } catch {}
      logMsg(`Loaded map '${data.name}' offsets=${offs.size} edgeNotes=${enotes.size}`);
    } catch (e) { console.error(e); }
  }, [logMsg]);

  // onChange handlers
  const onPickXml = React.useCallback(async (e?: React.ChangeEvent<HTMLInputElement>) => {
    try {
      setError(null);
      const files = e?.target?.files ?? xmlInputRef.current?.files;
      if (!files || files.length === 0) { logMsg('XML picker closed without a file.'); return; }
      const xmlFile = files[0];

      logMsg(`Loading XML: ${xmlFile.name}`);

  const raw = await parseWatchGuardXml(xmlFile);
    setLastXmlText(raw.xmlText);
    setLastXmlName(xmlFile.name);
      const domain = toDomain(raw);
      const univ = makeAliasUniverse(raw, domain);
      const xmlPolicies = xmlPoliciesToUnified(raw, univ);

      setSnap(prev => {
        const merged = mergePolicies(xmlPolicies, []);
        return { ...prev, domain, xmlPolicies, policies: merged };
      });

      if (xmlInputRef.current) xmlInputRef.current.value = '';
      const ifaceCount = domain.interfaces.length;
      const cidrCount = domain.interfaces.reduce((a, i) => a + i.cidrs.length, 0);
      logMsg(`XML loaded. Interfaces: ${ifaceCount}, interface CIDRs: ${cidrCount}, XML policies: ${xmlPolicies.length}`);
      if (pendingCreateName) {
        const name = pendingCreateName.trim() || xmlFile.name.replace(/\.[^.]+$/, '');
        const id = await createMap(name, xmlFile.name, raw.xmlText);
        setMapId(id); setMapName(name);
        setFirewalls([{ id: 'fw-1', name, domain, xmlText: raw.xmlText }]);
        const amap = await getAnnotationMapFor(id); setAnnotations(amap);
        const offs = await getAnnotationOffsetsFor(id); setLabelOffsets(offs);
        const enotes = await getEdgeNotesFor(id); setEdgeNotes(enotes);
        const rows = await listMaps(); setMaps(rows);
        setPendingCreateName(null);
        logMsg(`Created map '${name}'.`);
      } else {
        setMapId(null); setMapName(null);
        setAnnotations(new Map()); setLabelOffsets(new Map()); setEdgeNotes(new Map());
        setFirewalls([{ id: 'fw-1', name: xmlFile.name, domain, xmlText: raw.xmlText }]);
      }
    } catch (err: any) {
      console.error(err);
      const msg = `XML load failed: ${String(err?.message || err)}`;
      setError(msg); logMsg(msg);
    }
  }, [logMsg, pendingCreateName]);

  // XLS support removed

  // PDF support removed

  // PDF add support removed

  // Add additional firewall XML into current session/map
  const onAddFirewallXml = React.useCallback(async (e?: React.ChangeEvent<HTMLInputElement>) => {
    try {
      setError(null);
      const files = e?.target?.files ?? xmlAddFwRef.current?.files;
      if (!files || files.length === 0) { logMsg('Add FW picker closed without a file.'); return; }
      const xmlFile = files[0];
  const raw = await parseWatchGuardXml(xmlFile);
  const domain = toDomain(raw);
  setFirewalls(prev => prev.concat([{ id: `fw-${prev.length+1}`, name: xmlFile.name, domain, xmlText: raw.xmlText }]));
      if (mapIdRef.current) {
        await addMapDevice(mapIdRef.current, xmlFile.name, raw.xmlText);
        await touchMap(mapIdRef.current);
      }
      if (xmlAddFwRef.current) xmlAddFwRef.current.value = '';
      logMsg(`Added firewall from ${xmlFile.name}`);
    } catch (err: any) {
      console.error(err); setError(`Add firewall failed: ${String(err?.message || err)}`);
    }
  }, [logMsg]);

  // ---------- Build wheel nodes as NETWORKS, not /32 hosts ----------
  type WheelSubnet = { id: string; cidr: string; label: string; interfaceName?: string; vlanId?: string; derived?: boolean; gateways?: string[]; firewallId?: string; firewallName?: string; networkName?: string };

  const wheelSubnets = React.useMemo<WheelSubnet[]>(() => {
    const out: WheelSubnet[] = [];
    const domain = snap.domain;

    const allDomains: Domain[] = [];
    if (firewalls.length) allDomains.push(...firewalls.map(f => f.domain));
    else if (domain) allDomains.push(domain);

    // 1) Prefer explicit interface networks (skip /32)
    const seenCidrs = new Set<string>();
    if (allDomains.length) {
      for (let idx = 0; idx < allDomains.length; idx++) {
        const d = allDomains[idx];
        const fw = firewalls[idx];
        for (const intf of d.interfaces) {
          for (const cidr of intf.cidrs) {
            const pfx = prefixLen(cidr);
            if (pfx < 32) {
              out.push({
                id: `${intf.name}::${cidr}`,
                cidr,
                label: `${cidr}`,
                interfaceName: intf.name,
                vlanId: intf.vlanId,
                gateways: intf.primaryIp && cidrContainsIp(cidr, intf.primaryIp) ? [intf.primaryIp] : [],
                firewallId: fw?.id,
                firewallName: fw?.name,
                networkName: (intf as any).networkName,
              });
              seenCidrs.add(cidr);
            }
          }
        }
      }
    }

    // 2) Also derive /24 networks from policies’ CIDRs and hosts (union)
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
      if (!seenCidrs.has(cidr)) out.push({ id: `derived::${cidr}`, cidr, label: `${cidr}`, derived: true, gateways: [] });
    });
    logMsg(`Derived ${out.length} network nodes for visualization.`);
    return out;
  }, [snap.domain, firewalls, snap.policies, logMsg]);

  // ---------- Cytoscape rendering ----------
  React.useEffect(() => {
    if (!cyContainerRef.current) return;

    if (!cyRef.current) {
      cyRef.current = cytoscape({
        container: cyContainerRef.current,
        elements: [],
        style: [
          { selector: 'node', style: { 'background-color': theme.nodeFill, 'border-color': theme.nodeBorder, 'border-width': '2px', 'label': 'data(label)', 'font-size': '11px', 'color': theme.nodeText, 'text-wrap': 'wrap', 'text-max-width': '160px', 'shape': 'round-rectangle', 'padding': '6px' } },
          { selector: 'edge', style: { 'width': 2, 'line-color': theme.edge, 'curve-style': 'straight', 'target-arrow-shape': 'none', 'label': 'data(label)', 'font-size': 10, 'color': theme.edgeText, 'text-outline-color': theme.edgeTextOutline, 'text-outline-width': 2, 'text-rotation': 'autorotate', 'text-margin-x': 0 } },
          { selector: '.active', style: { 'background-color': theme.accent, 'border-color': theme.accent2, 'border-width': '3px', 'color': '#ffffff' } },
        ],
      });
    }
    const cy = cyRef.current!;
    cy.elements().remove();

    // Build unique network nodes by CIDR and aggregate gateways
    const networksByCidr = new Map<string, { cidr: string; gateways: string[] }>();
    for (const s of wheelSubnets) {
      const entry = networksByCidr.get(s.cidr) || { cidr: s.cidr, gateways: [] };
      const gws = s.gateways || [];
      for (const g of gws) if (!entry.gateways.includes(g)) entry.gateways.push(g);
      networksByCidr.set(s.cidr, entry);
    }

    // Add firewall nodes (or single if none)
    let fwIds: string[] = [];
    if (firewalls.length > 0) {
      fwIds = firewalls.map(f => f.id);
      firewalls.forEach((fw, i) => {
        cy.add({ group: 'nodes', data: { id: fw.id, label: fw.name || `Firewall ${i+1}` } });
      });
    } else {
      fwIds = ['firewall'];
      cy.add({ group: 'nodes', data: { id: 'firewall', label: 'Firebox' }, position: { x: 0, y: 0 } });
    }

    // Add network nodes
    for (const [cidr, info] of networksByCidr.entries()) {
      const nodeNote = annotations.get(cidr) || undefined;
      const fallbackName = (()=>{
        // Try to find a networkName from any interface that used this CIDR
        const anyIface = wheelSubnets.find(s=>s.cidr===cidr && s.networkName)?.networkName;
        return anyIface ? `(${anyIface})` : '';
      })();
      const gwText = info.gateways.length ? `\nGW: ${info.gateways.join(', ')}` : '';
      const nodeLabel = nodeNote ? `${cidr}\n(${nodeNote})${gwText}` : `${cidr}${fallbackName ? `\n${fallbackName}` : ''}${gwText}`;
      cy.add({ group: 'nodes', data: { id: cidr, label: nodeLabel, cidr } });
    }

    // Edges from firewalls to networks
    for (const s of wheelSubnets) {
      const src = s.firewallId || fwIds[0];
      const targetNodeId = s.cidr; // network nodes keyed by cidr
      const defaultEdge = s.interfaceName ? (s.vlanId ? `${s.interfaceName} | VLAN ${s.vlanId}` : s.interfaceName) : '(derived)';
      const edgeLabel = edgeNotes.get(s.cidr) ?? defaultEdge;
      const initOffset = labelOffsets.get(s.cidr) ?? 0;
      const edgeId = `fw-net:${src}->${targetNodeId}`;
      if (cy.getElementById(edgeId).nonempty()) continue; // avoid dup edges when multiple intfs list same cidr per fw
      const edge = cy.add({ group: 'edges', data: { id: edgeId, kind: 'fw-net', source: src, target: targetNodeId, label: edgeLabel, cidr: s.cidr, interfaceName: s.interfaceName ?? null, labelOffset: initOffset } });
      edge.style('text-margin-x', initOffset);
    }

    // Inter-firewall links on shared networks
    if (firewalls.length > 1) {
      // Group connections per cidr per firewall
      const byCidr = new Map<string, Map<string, WheelSubnet[]>>();
      for (const s of wheelSubnets) {
        if (!s.firewallId) continue;
        const m = byCidr.get(s.cidr) || new Map<string, WheelSubnet[]>();
        const arr = m.get(s.firewallId) || [];
        arr.push(s);
        m.set(s.firewallId, arr);
        byCidr.set(s.cidr, m);
      }
      for (const [cidr, m] of byCidr) {
        const fwIdsForCidr = Array.from(m.keys());
        for (let i = 0; i < fwIdsForCidr.length; i++) {
          for (let j = i+1; j < fwIdsForCidr.length; j++) {
            const a = fwIdsForCidr[i], b = fwIdsForCidr[j];
            const aIf = (m.get(a) || [])[0]?.interfaceName || 'iface';
            const bIf = (m.get(b) || [])[0]?.interfaceName || 'iface';
            const label = `${aIf} ↔ ${bIf}  ${cidr}`;
            const id = `fwfw:${a}__${b}__${cidr}`;
            if (cy.getElementById(id).nonempty()) continue;
            cy.add({ group: 'edges', data: { id, kind: 'fw-fw', source: a, target: b, label, cidr }, classes: 'fwlink' });
          }
        }
      }
      // style for inter-fw links
      cy.$('edge[kind = "fw-fw"]').style({ 'line-color': '#ffd54a', 'width': 3, 'target-arrow-shape': 'none', 'curve-style': 'bezier' });
    }

  cy.layout({ name: 'circle', radius: 300, animate: false }).run();
  try { cy.fit(cy.elements(), 50); } catch {}

    // Remove previous handlers to avoid duplicates
    cy.off('tap', 'node');
  cy.off('tap', 'edge');
    cy.off('cxttap', 'node');
  cy.off('dbltap', 'node');
    cy.on('tap', 'node', (evt) => {
      const id: string = evt.target.id();
      // firewall nodes are ids in fwIds; network nodes are keyed by cidr strings
      if (fwIds.includes(id)) return;
      const cidr = id; // node ids for networks are cidrs
      setActiveSubnet(prev => (prev === cidr ? null : cidr));
      setActiveHost(null);
    });

    // Double-click to enter LAN Focus overlay
    cy.on('dbltap', 'node', (evt) => {
      const id: string = evt.target.id();
      if (fwIds.includes(id)) return;
      setLanFocusSubnet(id);
    });

    // Edge click -> open inline editor modal
    cy.on('tap', 'edge', async (evt) => {
      try {
        (evt as any).preventDefault?.();
        (evt as any).stopPropagation?.();
        const data = evt.target.data() as any;
        const cidr: string | undefined = data?.cidr;
        if (!cidr) return;
        const current = edgeNotes.get(cidr) || '';
        setEditingEdge({ cidr, value: current });
      } catch (e) { console.error(e); }
    });

    // Right-click node -> prompt for node name under CIDR
    cy.on('cxttap', 'node', async (evt) => {
      try {
        const id: string = evt.target.id();
        if (fwIds.includes(id)) return;
        const cidr = id;
        const current = annotations.get(cidr) || '';
        setEditingNode({ cidr, value: current });
      } catch (e) { console.error(e); }
    });

    // Label drag along edge
    let dragging: null | { edgeId: string; cidr: string; start: { x: number; y: number }; startOffset: number; ux: number; uy: number } = null;
    cy.off('mousedown'); cy.off('mousemove'); cy.off('mouseup');
    cy.on('mousedown', 'edge', (evt) => {
      try {
        if (!mapIdRef.current) return;
        const edge = evt.target; const data = edge.data() as any; const cidr: string | undefined = data?.cidr; if (!cidr) return;
        if (data?.kind !== 'fw-net') return; // only drag firewall->network labels
        const src = edge.source(); const tgt = edge.target();
        const sp = (src as any).renderedPosition ? (src as any).renderedPosition() : src.position();
        const tp = (tgt as any).renderedPosition ? (tgt as any).renderedPosition() : tgt.position();
        const vx = tp.x - sp.x, vy = tp.y - sp.y; const len = Math.hypot(vx, vy) || 1; const ux = vx/len, uy = vy/len;
        const rp = (evt as any).renderedPosition || evt.position; const startOffset = typeof data.labelOffset === 'number' ? data.labelOffset : 0;
        dragging = { edgeId: edge.id(), cidr, start: { x: rp.x, y: rp.y }, startOffset, ux, uy };
      } catch (e) { console.error(e); }
    });
    cy.on('mousemove', (evt) => {
      try { if (!dragging) return; const rp = (evt as any).renderedPosition || evt.position; const dx = rp.x - dragging.start.x; const dy = rp.y - dragging.start.y; const along = dx*dragging.ux + dy*dragging.uy; const edge = cy.getElementById(dragging.edgeId); const newOffset = dragging.startOffset + along; edge.data('labelOffset', newOffset); edge.style('text-margin-x', newOffset); } catch (e) { console.error(e); }
    });
    cy.on('mouseup', async () => {
      try { if (!dragging) return; const { edgeId, cidr } = dragging; const edge = cy.getElementById(edgeId); const offset = edge.data('labelOffset') ?? 0; const mid = mapIdRef.current; dragging = null; if (mid) { await setAnnotationOffsetFor(mid, cidr, Number(offset)||0); await touchMap(mid); setLabelOffsets(prev => { const n = new Map(prev); n.set(cidr, Number(offset)||0); return n; }); } } catch (e) { console.error(e); }
    });
  }, [wheelSubnets, annotations, labelOffsets, edgeNotes, firewalls]);

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

  const [manualHosts, setManualHosts] = React.useState<string[]>([]);
  React.useEffect(() => {
    (async () => {
      if (!mapId || !activeSubnet) { setManualHosts([]); return; }
      try { const ips = await listManualHostIps(mapId, activeSubnet); setManualHosts(ips); }
      catch { setManualHosts([]); }
    })();
  }, [mapId, activeSubnet]);

  const hostList = React.useMemo(() => {
    if (!activeSubnet) return [];
    const parsed = hostsForSubnet(activeSubnet);
    const set = new Set(parsed);
    for (const ip of manualHosts) set.add(ip);
    return Array.from(set).sort();
  }, [activeSubnet, hostsForSubnet, manualHosts]);

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
  // Reflect active subnet selection visually in the graph
  React.useEffect(() => {
    const cy = cyRef.current; if (!cy) return;
    try {
      cy.$('node').removeClass('active');
      if (activeSubnet) {
        const n = cy.getElementById(activeSubnet);
        if (n && n.nonempty()) n.addClass('active');
      }
    } catch {}
  }, [activeSubnet]);
  const onSaveMap = React.useCallback(async () => {
    try {
      if (!lastXmlText) { window.alert('Load an XML first, then Save.'); return; }
      if (mapId) {
        const nm = window.prompt('Map name:', mapName || '');
        if (nm && nm.trim()) { await updateMapName(mapId, nm.trim()); setMapName(nm.trim()); }
        await saveMapXml(mapId, lastXmlText);
        const rows = await listMaps(); setMaps(rows);
        logMsg(`Saved map${mapName ? ` '${mapName}'` : ''}.`);
        try { localStorage.setItem(LAST_MAP_KEY, mapId); } catch {}
      } else {
        const nm = window.prompt('Name for this map:');
        if (!nm || !nm.trim()) return;
        const id = await createMap(nm.trim(), lastXmlName || undefined, lastXmlText);
        setMapId(id); setMapName(nm.trim());
        try { localStorage.setItem(LAST_MAP_KEY, id); } catch {}
        const rows = await listMaps(); setMaps(rows);
        logMsg(`Saved new map '${nm.trim()}'.`);
      }
    } catch (e) { console.error(e); }
  }, [lastXmlText, lastXmlName, mapId, mapName]);
  const onSaveAsMap = React.useCallback(async () => {
    try {
      if (!lastXmlText) { window.alert('Load an XML first, then Save As.'); return; }
      const nm = window.prompt('New map name:');
      if (!nm || !nm.trim()) return;
      const newId = await createMap(nm.trim(), lastXmlName || undefined, lastXmlText);
      // If user renamed the main firewall in-session, persist that name on the new map's primary device
      if (firewalls[0]?.name) {
        try { await renameFirstDeviceForMap(newId, firewalls[0].name); } catch {}
      }
      // Add additional firewalls (skip first which is included by createMap)
      for (let i = 1; i < firewalls.length; i++) {
        const fw = firewalls[i];
        if (fw.xmlText) {
          await addMapDevice(newId, fw.name, fw.xmlText);
        }
      }
      // Copy annotations and edge data
      for (const [cidr, note] of annotations.entries()) {
        await setAnnotationFor(newId, cidr, note);
      }
      for (const [cidr, off] of labelOffsets.entries()) {
        await setAnnotationOffsetFor(newId, cidr, off);
      }
      for (const [cidr, en] of edgeNotes.entries()) {
        await setEdgeNoteFor(newId, cidr, en);
      }
      await touchMap(newId);
      setMapId(newId); setMapName(nm.trim());
      try { localStorage.setItem(LAST_MAP_KEY, newId); } catch {}
      const rows = await listMaps(); setMaps(rows);
      logMsg(`Saved new map '${nm.trim()}' with ${firewalls.length} devices.`);
    } catch (e) { console.error(e); }
  }, [lastXmlText, lastXmlName, firewalls, annotations, labelOffsets, edgeNotes]);
  const onRenameMainFirewall = React.useCallback(async () => {
    try {
      const cur = firewalls[0]?.name || mapName || 'Firewall';
      const nm = window.prompt('Rename main firewall to:', cur);
      if (!nm || !nm.trim()) return;
      const newName = nm.trim();
      // update UI state
      setFirewalls(prev => prev.length ? [{ ...prev[0], name: newName }, ...prev.slice(1)] : prev);
      // update current node label immediately
      const cy = cyRef.current; if (cy) {
        const nodeId = firewalls[0]?.id || 'firewall';
        const node = cy.getElementById(nodeId);
        if (node && node.nonempty()) node.data('label', newName);
      }
      // persist if in a saved map
      if (mapId) {
        await renameFirstDeviceForMap(mapId, newName);
        await touchMap(mapId);
        const rows = await listMaps(); setMaps(rows);
        logMsg(`Renamed main firewall to '${newName}'.`);
      }
    } catch (e) { console.error(e); }
  }, [firewalls, mapId, mapName, logMsg]);
  const onDeleteCurrentMap = React.useCallback(async () => {
    try {
      if (!mapId || !mapName) { window.alert('No saved map selected. Open a map first.'); return; }
      const yes = window.confirm(`Delete map '${mapName}'? This cannot be undone.`);
      if (!yes) return;
      await deleteMap(mapId);
      // Clear UI/session and refresh maps list
      setMapId(null); setMapName(null);
      setAnnotations(new Map()); setLabelOffsets(new Map()); setEdgeNotes(new Map());
      setFirewalls([]);
      setSnap({}); setLastXmlText(null); setLastXmlName(null);
      const rows = await listMaps(); setMaps(rows);
      try { localStorage.removeItem(LAST_MAP_KEY); } catch {}
      logMsg(`Deleted current map '${mapName}'.`);
    } catch (e) { console.error(e); }
  }, [mapId, mapName, logMsg]);

  const onCloseCurrentMap = React.useCallback(async () => {
    try {
      // Non-destructive: just clear the current session and last-map marker
      setMapId(null); setMapName(null);
      setAnnotations(new Map()); setLabelOffsets(new Map()); setEdgeNotes(new Map());
      setFirewalls([]);
      setSnap({}); setLastXmlText(null); setLastXmlName(null);
      try { localStorage.removeItem(LAST_MAP_KEY); } catch {}
      logMsg('Closed current map.');
    } catch (e) { console.error(e); }
  }, [logMsg]);
  const mergedCount = allPolicies.length;
  const headerHeight = 44;

  return (
  <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', height: '100vh', overflow: 'hidden', background: theme.bg, color: theme.text }}>
      {/* LEFT: Graph */}
      <div style={{ position: 'relative' }}>
        <div
          style={{
            height: headerHeight, padding: '8px 10px', borderBottom: `1px solid ${theme.border}`,
            display: 'flex', gap: 8, alignItems: 'center', position: 'sticky', top: 0, zIndex: 5, background: theme.bg,
          }}
        >
          {/* Menu: Maps */}
          <div style={{ position: 'relative' }}>
            <button type="button" onClick={()=>{ const n=!mapsMenuOpen; closeAllMenus(); setMapsMenuOpen(n); }} style={{ background: 'transparent', color: '#93c5fd', border: `1px solid ${theme.border}`, padding: '6px 10px', borderRadius: 6, cursor: 'pointer' }}>
              Maps{mapName ? `: ${mapName}` : ''}
            </button>
            {mapsMenuOpen && (
              <div style={{ position: 'absolute', top: '100%', left: 0, background: theme.panelBg, border: `1px solid ${theme.border}`, borderRadius: 8, padding: 8, zIndex: 10, minWidth: 260 }}>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>Maps</div>
                <button type="button" onClick={() => { const nm = window.prompt('Name for new map:'); if (nm) { setPendingCreateName(nm); xmlInputRef.current?.click(); closeAllMenus(); } }}
                  style={{ width: '100%', background: theme.bg, color: theme.text, border: `1px solid ${theme.border}`, padding: '6px 8px', borderRadius: 6, marginBottom: 8, cursor: 'pointer' }}>
                  New map from XML…
                </button>
                <div style={{ display: 'grid', gap: 6, marginBottom: 8 }}>
                  <button type="button" onClick={() => { const nm = window.prompt('Rename map to:', mapName || ''); if (nm && mapId) { updateMapName(mapId, nm.trim()).then(()=>{ setMapName(nm.trim()); listMaps().then(setMaps); closeAllMenus(); }); } }}
                    style={{ width: '100%', background: theme.bg, color: theme.text, border: `1px solid ${theme.border}`, padding: '6px 8px', borderRadius: 6, cursor: 'pointer' }}>Rename Map…</button>
                  <button type="button" onClick={()=>{ closeAllMenus(); onSaveAsMap(); }}
                    style={{ width: '100%', background: theme.bg, color: theme.text, border: `1px solid ${theme.border}`, padding: '6px 8px', borderRadius: 6, cursor: 'pointer' }}>Save As…</button>
                  {mapId && (
                    <button type="button" onClick={()=>{ closeAllMenus(); onDeleteCurrentMap(); }}
                      style={{ width: '100%', background: '#7f1d1d', color: 'white', border: 'none', padding: '6px 8px', borderRadius: 6, cursor: 'pointer' }}>Delete Map</button>
                  )}
                </div>
                <div style={{ fontSize: 12, opacity: 0.8, margin: '4px 0' }}>Open existing</div>
                <div style={{ maxHeight: 240, overflow: 'auto', display: 'grid', gap: 6 }}>
                  {maps.length === 0 && <div style={{ opacity: 0.7 }}>No saved maps yet.</div>}
                  {maps.map(m => (
                    <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <button type="button" onClick={async () => { await loadMapById(m.id); closeAllMenus(); }}
                      style={{ flex: 1, textAlign: 'left', background: theme.panelBg, color: theme.text, border: `1px solid ${theme.border}`, padding: '6px 8px', borderRadius: 6, cursor: 'pointer' }}>
                        {m.name} <span style={{ opacity: 0.7, fontSize: 12 }}>({m.xmlName || 'XML'})</span>
                      </button>
                      <button
                        type="button"
                        title="Delete map"
                        onClick={async (ev) => {
                          ev.stopPropagation();
                          try {
                            const yes = window.confirm(`Delete map '${m.name}'? This cannot be undone.`);
                            if (!yes) return;
                            await deleteMap(m.id);
                            const rows = await listMaps(); setMaps(rows);
                            if (mapId === m.id) {
                              setMapId(null); setMapName(null);
                              setAnnotations(new Map()); setLabelOffsets(new Map()); setEdgeNotes(new Map());
                              setFirewalls([]);
                              setSnap({}); setLastXmlText(null); setLastXmlName(null);
                              try { localStorage.removeItem(LAST_MAP_KEY); } catch {}
                            }
                            logMsg(`Deleted map '${m.name}'.`);
                          } catch (e) { console.error(e); }
                        }}
                        style={{ background: '#7f1d1d', color: 'white', border: 'none', padding: '6px 10px', borderRadius: 6, cursor: 'pointer' }}
                      >
                        Delete
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          {/* Menu: Devices */}
          <div style={{ position: 'relative' }}>
            <button type="button" onClick={()=>{ const n=!devicesMenuOpen; closeAllMenus(); setDevicesMenuOpen(n); }} style={{ background: 'transparent', color: '#93c5fd', border: `1px solid ${theme.border}`, padding: '6px 10px', borderRadius: 6, cursor: 'pointer' }}>
              Devices
            </button>
            {devicesMenuOpen && (
              <div style={{ position: 'absolute', top: '100%', left: 0, background: theme.panelBg, border: `1px solid ${theme.border}`, borderRadius: 8, padding: 8, zIndex: 10, minWidth: 220 }}>
                <div style={{ display: 'grid', gap: 6 }}>
                  <button type="button" onClick={()=>{ closeAllMenus(); xmlInputRef.current?.click(); }} style={{ background: theme.bg, color: theme.text, border: `1px solid ${theme.border}`, padding: '6px 8px', borderRadius: 6, cursor: 'pointer' }}>Load XML…</button>
                  <button type="button" onClick={()=>{ closeAllMenus(); clickAddFirewallPicker(); }} style={{ background: theme.bg, color: theme.text, border: `1px solid ${theme.border}`, padding: '6px 8px', borderRadius: 6, cursor: 'pointer' }}>Add Firewall XML…</button>
                  <button type="button" onClick={()=>{ closeAllMenus(); onRenameMainFirewall(); }} style={{ background: theme.bg, color: theme.text, border: `1px solid ${theme.border}`, padding: '6px 8px', borderRadius: 6, cursor: 'pointer' }}>Rename Firewall…</button>
                </div>
              </div>
            )}
          </div>
          {/* Menu: View */}
          <div style={{ position: 'relative' }}>
            <button type="button" onClick={()=>{ const n=!viewMenuOpen; closeAllMenus(); setViewMenuOpen(n); }} style={{ background: 'transparent', color: '#93c5fd', border: `1px solid ${theme.border}`, padding: '6px 10px', borderRadius: 6, cursor: 'pointer' }}>
              View
            </button>
            {viewMenuOpen && (
              <div style={{ position: 'absolute', top: '100%', left: 0, background: theme.panelBg, border: `1px solid ${theme.border}`, borderRadius: 8, padding: 8, zIndex: 10, minWidth: 200 }}>
                <div style={{ display: 'grid', gap: 6 }}>
                  <button type="button" onClick={()=>{ closeAllMenus(); onFitGraph(); }} style={{ background: theme.bg, color: theme.text, border: `1px solid ${theme.border}`, padding: '6px 8px', borderRadius: 6, cursor: 'pointer' }}>Fit graph to view</button>
                </div>
              </div>
            )}
          </div>
          {/* Menu: Help */}
          <div style={{ position: 'relative' }}>
            <button type="button" onClick={()=>{ const n=!helpMenuOpen; closeAllMenus(); setHelpMenuOpen(n); }} style={{ background: 'transparent', color: '#93c5fd', border: `1px solid ${theme.border}`, padding: '6px 10px', borderRadius: 6, cursor: 'pointer' }}>
              Help
            </button>
            {helpMenuOpen && (
              <div style={{ position: 'absolute', top: '100%', left: 0, background: theme.panelBg, border: `1px solid ${theme.border}`, borderRadius: 8, padding: 8, zIndex: 10, minWidth: 200 }}>
                <div style={{ display: 'grid', gap: 6 }}>
                  <button type="button" onClick={()=>{ closeAllMenus(); window.alert('WatchGuard Network Mapper\nLocal-only app. Data stored in your browser.'); }} style={{ background: theme.bg, color: theme.text, border: `1px solid ${theme.border}`, padding: '6px 8px', borderRadius: 6, cursor: 'pointer' }}>About</button>
                  <button type="button" onClick={()=>{ closeAllMenus(); window.alert('Shortcuts:\nCtrl+O Open\nCtrl+S Save\nCtrl+Shift+S Save As\nF Fit graph\n/ Focus search'); }} style={{ background: theme.bg, color: theme.text, border: `1px solid ${theme.border}`, padding: '6px 8px', borderRadius: 6, cursor: 'pointer' }}>Shortcuts</button>
                </div>
              </div>
            )}
          </div>
          <button type="button" onClick={onSaveMap} style={{ marginLeft: 8, background: theme.button, color: 'white', border: 'none', padding: '6px 10px', borderRadius: 6, cursor: 'pointer' }}>
            Save
          </button>
          {mapId && (
            <button type="button" onClick={onCloseCurrentMap} style={{ background: theme.bg, color: theme.text, border: `1px solid ${theme.border}`, padding: '6px 10px', borderRadius: 6, cursor: 'pointer' }}>
              Close Map
            </button>
          )}
          {/* Primary action */}
          {/* Removed redundant right-side map label */}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <input
              value={searchIp}
              onChange={(e) => setSearchIp(e.target.value)}
              placeholder="Search IP (e.g., 10.0.0.5)"
              style={{ background: theme.panelBg, border: `1px solid ${theme.border}`, color: theme.text, padding: '6px 8px', borderRadius: 6, width: 220 }}
            />
            <button type="button" onClick={onSearch} style={{ background: theme.button, border: 'none', color: 'white', padding: '6px 10px', borderRadius: 6 }}>Go</button>
          </div>
          {/* hidden inputs */}
          <input type="file" accept=".xml" ref={xmlInputRef} onChange={onPickXml} style={{ display: 'none' }} />
          <input type="file" accept=".xml" ref={xmlAddFwRef} onChange={onAddFirewallXml} style={{ display: 'none' }} />
          {/* XLS deprecated: keeping the input hidden for now */}
          {/* <input type="file" accept=".xls,.xlsx" ref={xlsInputRef} onChange={onPickXls} style={{ display: 'none' }} /> */}
        </div>

        <div
          ref={cyContainerRef}
          style={{
            position: 'absolute', zIndex: 1, top: headerHeight, left: 0, right: 0, bottom: 0,
            transformOrigin: 'top left',
            transition: prefersReducedMotion ? 'none' : 'transform 240ms ease',
            transform: lanFocusSubnet ? 'scale(0.25)' : 'none',
            pointerEvents: lanFocusSubnet ? 'none' : 'auto',
            filter: lanFocusSubnet ? 'grayscale(0.2)' : 'none',
          }}
        />

        {/* LAN Focus overlay */}
        {lanFocusSubnet && mapId && (
          <LanOverlay
            mapId={mapId}
            subnet={lanFocusSubnet}
            onClose={() => setLanFocusSubnet(null)}
          />
        )}

        {/* Edge text editor modal */}
        {!lanFocusSubnet && editingEdge && (
          <div style={{ position: 'absolute', inset: 0, zIndex: 3, display: 'grid', placeItems: 'center', background: 'rgba(0,0,0,0.35)' }} onClick={()=>{ setEditingEdge(null); try { window.scrollTo({ top: 0, behavior: 'auto' }); } catch {} }}>
            <div style={{ background: theme.panelBg, border: `1px solid ${theme.border}`, borderRadius: 8, padding: 12, minWidth: 360 }} onClick={(e)=>e.stopPropagation()}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>Edit link label</div>
              <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 6 }}>for {editingEdge.cidr}</div>
              <input
                autoFocus
                value={editingEdge.value}
                onChange={(e)=>setEditingEdge({...editingEdge, value: e.target.value})}
                onKeyDown={async (e)=>{
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    const v = editingEdge.value.trim();
                    if (!v) { setEditingEdge(null); return; }
                    try {
                      if (mapIdRef.current) { await setEdgeNoteFor(mapIdRef.current, editingEdge.cidr, v); await touchMap(mapIdRef.current); }
                      setEdgeNotes(prev => { const n = new Map(prev); n.set(editingEdge.cidr, v); return n; });
                      // Update current edge label if exists
                      const cy = cyRef.current; if (cy) { const edge = cy.$(`edge[ cidr = "${editingEdge.cidr}" ]`); edge.data('label', v); }
                    } finally { setEditingEdge(null); try { window.scrollTo({ top: 0, behavior: 'auto' }); } catch {} }
                  } else if (e.key === 'Escape') {
                    setEditingEdge(null); try { window.scrollTo({ top: 0, behavior: 'auto' }); } catch {}
                  }
                }}
                placeholder="e.g., IF 0/4 | VLAN 2277"
                style={{ width: '100%', background: theme.bg, color: theme.text, border: `1px solid ${theme.border}`, padding: '6px 8px', borderRadius: 6 }}
              />
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
                <button type="button" onClick={()=>{ setEditingEdge(null); try { window.scrollTo({ top: 0, behavior: 'auto' }); } catch {} }} style={{ background: theme.bg, color: theme.text, border: `1px solid ${theme.border}`, padding: '6px 10px', borderRadius: 6 }}>Cancel</button>
                <button type="button" onClick={async ()=>{
                  const v = (editingEdge.value || '').trim(); if (!v) { setEditingEdge(null); return; }
                  try {
                    if (mapIdRef.current) { await setEdgeNoteFor(mapIdRef.current, editingEdge.cidr, v); await touchMap(mapIdRef.current); }
                    setEdgeNotes(prev => { const n = new Map(prev); n.set(editingEdge.cidr, v); return n; });
                    const cy = cyRef.current; if (cy) { const edge = cy.$(`edge[ cidr = "${editingEdge.cidr}" ]`); edge.data('label', v); }
                  } finally { setEditingEdge(null); try { window.scrollTo({ top: 0, behavior: 'auto' }); } catch {} }
                }} style={{ background: theme.button, color: 'white', border: 'none', padding: '6px 10px', borderRadius: 6 }}>OK</button>
              </div>
            </div>
          </div>
        )}

        {/* Node name editor modal */}
        {!lanFocusSubnet && editingNode && (
          <div style={{ position: 'absolute', inset: 0, zIndex: 3, display: 'grid', placeItems: 'center', background: 'rgba(0,0,0,0.35)' }} onClick={()=>{ setEditingNode(null); try { window.scrollTo({ top: 0, behavior: 'auto' }); } catch {} }}>
            <div style={{ background: theme.panelBg, border: `1px solid ${theme.border}`, borderRadius: 8, padding: 12, minWidth: 360 }} onClick={(e)=>e.stopPropagation()}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>Edit network name</div>
              <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 6 }}>for {editingNode.cidr}</div>
              <input
                autoFocus
                value={editingNode.value}
                onChange={(e)=>setEditingNode({...editingNode, value: e.target.value})}
                onKeyDown={async (e)=>{
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    const v = editingNode.value.trim();
                    if (!v) { setEditingNode(null); return; }
                    try {
                      const mid = mapIdRef.current;
                      if (mid) { await setAnnotationFor(mid, editingNode.cidr, v); await touchMap(mid); }
                      setAnnotations(prev => { const n = new Map(prev); n.set(editingNode.cidr, v); return n; });
                      const cy = cyRef.current; if (cy) { const node = cy.$(`node[ cidr = \"${editingNode.cidr}\" ]`); const gws = Array.from(new Set(wheelSubnets.filter(s=>s.cidr===editingNode.cidr).flatMap(s=>s.gateways||[]))); const gwText = gws.length ? `\nGW: ${gws.join(', ')}` : ''; node.data('label', `${editingNode.cidr}\n(${v})${gwText}`); }
                    } finally { setEditingNode(null); try { window.scrollTo({ top: 0, behavior: 'auto' }); } catch {} }
                  } else if (e.key === 'Escape') { setEditingNode(null); }
                }}
                placeholder="e.g., Payroll VLAN"
                style={{ width: '100%', background: theme.bg, color: theme.text, border: `1px solid ${theme.border}`, padding: '6px 8px', borderRadius: 6 }}
              />
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
                <button type="button" onClick={()=>{ setEditingNode(null); try { window.scrollTo({ top: 0, behavior: 'auto' }); } catch {} }} style={{ background: theme.bg, color: theme.text, border: `1px solid ${theme.border}`, padding: '6px 10px', borderRadius: 6 }}>Cancel</button>
                <button type="button" onClick={async ()=>{
                  const v = (editingNode.value || '').trim(); if (!v) { setEditingNode(null); return; }
                  try {
                    const mid = mapIdRef.current;
                    if (mid) { await setAnnotationFor(mid, editingNode.cidr, v); await touchMap(mid); }
                    setAnnotations(prev => { const n = new Map(prev); n.set(editingNode.cidr, v); return n; });
                    const cy = cyRef.current; if (cy) { const node = cy.$(`node[ cidr = \"${editingNode.cidr}\" ]`); const gws = Array.from(new Set(wheelSubnets.filter(s=>s.cidr===editingNode.cidr).flatMap(s=>s.gateways||[]))); const gwText = gws.length ? `\nGW: ${gws.join(', ')}` : ''; node.data('label', `${editingNode.cidr}\n(${v})${gwText}`); }
                  } finally { setEditingNode(null); try { window.scrollTo({ top: 0, behavior: 'auto' }); } catch {} }
                }} style={{ background: theme.button, color: 'white', border: 'none', padding: '6px 10px', borderRadius: 6 }}>OK</button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* RIGHT: Panels */}
      <div style={{ display: 'grid', gridTemplateRows: 'min-content minmax(80px, 0.8fr) minmax(160px, 1.2fr)', borderLeft: `1px solid ${theme.border}` }}>
        {/* Selection */}
        <div style={{ padding: 10, borderBottom: `1px solid ${theme.border}`, background: theme.panelBg }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Selection</div>
          <div>Subnet: <span style={{ color: theme.accent }}>{activeSubnet ?? '—'}</span></div>
          <div>Host: <span style={{ color: theme.accent }}>{activeHost ?? '—'}</span></div>
          {error && <div style={{ marginTop: 6, color: '#fca5a5' }}>{error}</div>}
        </div>

        {/* Hosts (explicit /32s only) */}
        <div style={{ padding: 10, borderBottom: `1px solid ${theme.border}`, overflow: 'auto', background: theme.panelBg }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Hosts {activeSubnet ? `(in ${activeSubnet})` : ''}</div>
          {activeSubnet ? (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 6 }}>
              {hostList.map(h => (
                <li key={h} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button
                    onClick={() => setActiveHost(prev => prev === h ? null : h)}
                    style={{
                      background: activeHost === h ? theme.button : theme.bg,
                      border: `1px solid ${theme.border}`,
                      color: theme.text,
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
        <div style={{ padding: 10, overflow: 'auto', background: theme.panelBg }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>
            Policies {activeHost ? `(host ${activeHost})` : activeSubnet ? `(subnet ${activeSubnet})` : ''}
          </div>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 6 }}>
            {visiblePolicies.slice(0, 500).map(p => (
              <li key={`${p.source}-${p.id}-${p.name}`} style={{ background: theme.bg, border: `1px solid ${theme.border}`, borderRadius: 8, padding: 8 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ fontWeight: 600 }}>{p.name}</span>
                  <span style={{ fontSize: 12, opacity: 0.8 }}>{p.service ?? ''}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 12, background: theme.nodeFill, padding: '2px 6px', borderRadius: 999 }}>
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <div style={{ fontWeight: 600 }}>Debug</div>
              <button type="button" onClick={() => {
                try {
                  const KEY = 'wgmap_debug_log';
                  const arr: string[] = JSON.parse(sessionStorage.getItem(KEY) || '[]');
                  navigator.clipboard.writeText(arr.join('\n')).catch(()=>{});
                  logMsg('Copied debug log to clipboard');
                } catch {}
              }} style={{ marginLeft: 'auto', background: theme.bg, color: theme.text, border: `1px solid ${theme.border}`, padding: '2px 8px', borderRadius: 6, fontSize: 12 }}>Copy</button>
              <button type="button" onClick={() => {
                try { sessionStorage.removeItem('wgmap_debug_log'); } catch {}
                setLog([]);
                logMsg('Cleared debug log');
              }} style={{ background: '#7f1d1d', color: 'white', border: 'none', padding: '2px 8px', borderRadius: 6, fontSize: 12 }}>Clear</button>
            </div>
            <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 12, color: '#cbd5e1', maxHeight: 220, overflow: 'auto', background: theme.bg, border: `1px solid ${theme.border}`, padding: 8 }}>
{log.join('\n')}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
