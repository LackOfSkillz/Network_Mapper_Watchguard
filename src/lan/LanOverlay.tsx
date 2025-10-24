import React from 'react';
import {
  listLanSwitches, upsertLanSwitch, deleteLanSwitch,
  listLanHosts, upsertLanHost, deleteLanHost,
  listAllMapSwitches, listAllLanHosts,
  listLanPorts, upsertLanPort, deleteLanPort,
  listLanVlans, upsertLanVlan, deleteLanVlan,
  getPortVlans, setPortVlanBinding, clearPortVlanBinding,
  getLanNotes, setLanNote,
  listLanLocations, upsertLanLocation, setSwitchLocation,
  bindHostToPort, unbindHostFromPort,
  listBindingsForMap,
  type LanSwitch, type LanHost, type LanPort, type LanVlan
} from '../db';
import cytoscape, { Core } from 'cytoscape';

function subnetColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue} 70% 75%)`;
}

const btnBase: React.CSSProperties = {
  padding: '6px 10px',
  background: '#13203a',
  border: '1px solid #223154',
  color: '#e6edf7',
  borderRadius: 6,
  fontSize: 12,
  cursor: 'pointer'
};
const btnPrimary: React.CSSProperties = { ...btnBase, background: '#1d4ed8', border: '1px solid #1e3a8a' };
const btnSecondary: React.CSSProperties = { ...btnBase, background: '#0b1424', border: '1px solid #1f2a44' };
const menuBtn: React.CSSProperties = { ...btnBase, width: '100%', textAlign: 'left', marginBottom: 4 } as React.CSSProperties;

type Props = { mapId: string; subnet: string; onClose: () => void; knownHostIps?: string[] };

// Simple scaffold for LAN Focus overlay. Separate Cytoscape instance will be wired later.
export default function LanOverlay({ mapId, subnet, onClose, knownHostIps }: Props) {
  const [switches, setSwitches] = React.useState<LanSwitch[]>([]);
  const [hosts, setHosts] = React.useState<LanHost[]>([]);
  const [allSwitches, setAllSwitches] = React.useState<LanSwitch[]>([]);
  const [allHosts, setAllHosts] = React.useState<LanHost[]>([]);
  const [addingSwitch, setAddingSwitch] = React.useState<{ name: string; model?: string; mgmtIp?: string; managed?: boolean; portCount?: number }>({ name: '', managed: true });
  const [addingHost, setAddingHost] = React.useState<{ ip: string; name?: string; kind?: string }>({ ip: '' });
  const [selectedSwitchId, setSelectedSwitchId] = React.useState<string | null>(null);
  const [ports, setPorts] = React.useState<LanPort[]>([]);
  const [vlans, setVlans] = React.useState<LanVlan[]>([]);
  const [addingPort, setAddingPort] = React.useState<{ idx?: number; name?: string; poe?: boolean; speed?: string }>({});
  const [addingVlan, setAddingVlan] = React.useState<{ vid?: number; name?: string }>({});
  const [portVlans, setPortVlans] = React.useState<Record<string, Set<string>>>({});
  const cyRef = React.useRef<Core | null>(null);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const overlayRef = React.useRef<HTMLDivElement | null>(null);
  const [ctx, setCtx] = React.useState<null | { x: number; y: number; kind: 'switch'|'host'; id: string; label: string }>(null);
  const [noteModal, setNoteModal] = React.useState<null | { scope: 'switch'|'host'; id: string; text: string }>(null);
  const [selected, setSelected] = React.useState<null | { kind: 'switch'|'host'; id: string }>(null);
  const [locationModal, setLocationModal] = React.useState<null | { name: string; address?: string; applyToVisible: boolean }>(null);
  const [locations, setLocations] = React.useState<Array<{ name: string; address?: string }>>([]);
  const [viewMode, setViewMode] = React.useState<'focus'|'location'>('focus');
  const [selectedLocation, setSelectedLocation] = React.useState<string | null>(null);
  const [assignModal, setAssignModal] = React.useState<null | { hostId: string; switchId?: string; portId?: string; vlanId?: string }>(null);
  const [assignPorts, setAssignPorts] = React.useState<LanPort[]>([]);
  const leftPanelRef = React.useRef<HTMLDivElement | null>(null);
  const [bindings, setBindings] = React.useState<Map<string, string>>(new Map()); // hostId -> switchId
  const [hostPortMap, setHostPortMap] = React.useState<Map<string, string>>(new Map()); // hostId -> portId
  const didAutoAssignRef = React.useRef(false);

  const load = React.useCallback(async () => {
    try {
      const sw = await listLanSwitches(mapId, subnet);
      const hs = await listLanHosts(mapId, subnet);
      const vls = await listLanVlans(mapId, subnet);
      setSwitches(sw); setHosts(hs); setVlans(vls);
      // Maintain selection if possible
      if (sw.length > 0 && (!selectedSwitchId || !sw.find(s => s.id === selectedSwitchId))) {
        setSelectedSwitchId(sw[0].id);
      }
    } catch (e) { console.error(e); }
  }, [mapId, subnet, selectedSwitchId]);

  React.useEffect(() => { void load(); }, [load]);
  React.useEffect(() => { (async()=>{ try { const rows = await listLanLocations(mapId); setLocations(rows.map(r=>({ name: r.name, address: r.address }))); } catch {} })(); }, [mapId]);
  React.useEffect(() => { (async()=>{ try { const swAll = await listAllMapSwitches(mapId); setAllSwitches(swAll); const hsAll = await listAllLanHosts(mapId); setAllHosts(hsAll); } catch {} })(); }, [mapId]);
  React.useEffect(() => { (async()=>{ try { const rows = await listBindingsForMap(mapId); const swMap = new Map<string, string>(); const hp = new Map<string, string>(); rows.forEach(r=> { swMap.set(r.hostId, r.switchId); hp.set(r.hostId, r.portId); }); setBindings(swMap); setHostPortMap(hp); } catch (e) { console.error(e); } })(); }, [mapId, ports.length, switches.length]);

  // Auto-assign default ports (1-48 or switch.portCount) for unbound hosts so they render radially
  React.useEffect(() => {
    (async () => {
      try {
        if (viewMode !== 'focus') return; // only in subnet focus
        if (hosts.length === 0 || switches.length === 0) return;
        // Find hosts without a port binding
        const unbound = hosts.filter(h => !hostPortMap.has(h.id));
        if (unbound.length === 0) return;
        const targetSwitchId = selectedSwitchId || switches[0]?.id;
        if (!targetSwitchId) return;

        // Ensure default ports exist
        const sw = switches.find(s => s.id === targetSwitchId)!;
        const desiredCount = (sw.portCount && sw.portCount > 0) ? sw.portCount : 48;
        let existing = await listLanPorts(targetSwitchId);
        const haveIdx = new Set(existing.map(p => p.idx).filter((n): n is number => typeof n === 'number'));
        for (let i = 1; i <= desiredCount; i++) {
          if (!haveIdx.has(i)) { await upsertLanPort({ switchId: targetSwitchId, idx: i }); }
        }
        existing = await listLanPorts(targetSwitchId);
        const byIdx = new Map<number, LanPort>();
        existing.forEach(p => { if (typeof p.idx === 'number') byIdx.set(p.idx, p); });

        // Get currently used portIds for this switch
        const allBinds = await listBindingsForMap(mapId);
        const usedPortIds = new Set<string>(allBinds.filter(b => b.switchId === targetSwitchId).map(b => b.portId));

        // Assign each unbound host to next available port idx (wrap if needed)
        let cursor = 1;
        for (const h of unbound) {
          // find next free idx
          let tries = 0; let chosen: LanPort | undefined;
          while (tries < desiredCount) {
            const port = byIdx.get(((cursor - 1) % desiredCount) + 1);
            cursor++;
            tries++;
            if (!port) continue;
            if (!usedPortIds.has(port.id)) { chosen = port; break; }
          }
          // If all are used, just pick by cursor anyway
          if (!chosen) { chosen = byIdx.get(((cursor - 2 + desiredCount) % desiredCount) + 1); }
          if (chosen) {
            await bindHostToPort(h.id, chosen.id);
            usedPortIds.add(chosen.id);
          }
        }
        // Refresh bindings map after assignment
        const rows = await listBindingsForMap(mapId);
        const swMap = new Map<string, string>(); const hp = new Map<string, string>();
        rows.forEach(r => { swMap.set(r.hostId, r.switchId); hp.set(r.hostId, r.portId); });
        setBindings(swMap); setHostPortMap(hp);
      } catch (e) { console.error(e); }
    })();
  }, [viewMode, hosts, switches, selectedSwitchId, mapId, hostPortMap]);
  React.useEffect(() => { (async()=>{ if (!assignModal?.switchId) { setAssignPorts([]); return; } try { const p = await listLanPorts(assignModal.switchId); setAssignPorts(p); } catch {} })(); }, [assignModal?.switchId]);

  // Prepopulate LAN hosts from parsed list (once per overlay entry or when list changes)
  React.useEffect(() => {
    (async () => {
      if (!knownHostIps || knownHostIps.length === 0) return;
      try {
        const existing = await listLanHosts(mapId, subnet);
        const existSet = new Set(existing.map(h => h.ip).filter(Boolean) as string[]);
        const missing = knownHostIps.filter(ip => !existSet.has(ip));
        if (missing.length === 0) return;
        for (const ip of missing) {
          await upsertLanHost({ mapId, subnet, ip, source: 'parsed' });
        }
        await load();
      } catch (e) { console.error(e); }
    })();
  }, [knownHostIps, mapId, subnet, load]);

  // Load ports for selected switch and their VLAN bindings
  React.useEffect(() => {
    (async () => {
      if (!selectedSwitchId) { setPorts([]); setPortVlans({}); return; }
      try {
        const p = await listLanPorts(selectedSwitchId);
        setPorts(p);
        const map: Record<string, Set<string>> = {};
        for (const port of p) {
          const v = await getPortVlans(port.id);
          map[port.id] = new Set(v.map(x => x.vlanId));
        }
        setPortVlans(map);
      } catch (e) { console.error(e); }
    })();
  }, [selectedSwitchId]);

  // Helpers for location mode
  const graphSwitches = React.useMemo<LanSwitch[]>(() => {
    if (viewMode === 'focus') return switches;
    const loc = selectedLocation || (() => {
      const freq = new Map<string, number>();
      switches.forEach(s=>{ if (s.location) freq.set(s.location, (freq.get(s.location)||0)+1); });
      let best: string | null = null; let score = 0; freq.forEach((v,k)=>{ if (v>score) { score=v; best=k; } });
      return best || '';
    })();
    if (!loc) return switches;
    return allSwitches.filter(s => s.location === loc);
  }, [viewMode, switches, allSwitches, selectedLocation]);
  const includedSubnets = React.useMemo<string[]>(() => Array.from(new Set(graphSwitches.map(s=>s.subnet).filter(Boolean) as string[])), [graphSwitches]);
  const graphHosts = React.useMemo<LanHost[]>(() => viewMode==='focus' ? hosts : allHosts.filter(h => includedSubnets.includes(h.subnet)), [viewMode, hosts, allHosts, includedSubnets]);

  // Build/refresh LAN Cytoscape micro-graph
  React.useEffect(() => {
    if (!containerRef.current) return;
    if (!cyRef.current) {
      cyRef.current = cytoscape({
        container: containerRef.current,
        elements: [],
        style: [
          { selector: 'node', style: { 'background-color': '#1b2942', 'border-color': '#3b4d75', 'border-width': 2, 'label': 'data(label)', 'color': '#e6edf7', 'font-size': 11, 'text-wrap': 'wrap', 'text-max-width': '160px', 'text-outline-color': '#0e1726', 'text-outline-width': 2 } },
          { selector: 'node[type = "switch"]', style: { 'shape': 'round-rectangle', 'padding': '8px 10px', 'width': 'label', 'height': 'label' } },
          { selector: 'node[type = "host"]', style: { 'shape': 'ellipse', 'width': 26, 'height': 26, 'text-valign': 'bottom', 'text-margin-y': -6 } },
          { selector: 'edge', style: { 'width': 2, 'line-color': '#93b4ff', 'curve-style': 'straight', 'target-arrow-shape': 'vee', 'target-arrow-color': '#93b4ff', 'arrow-scale': 0.9, 'opacity': 0.9 } },
          { selector: '.active', style: { 'border-color': '#4f8ef7', 'border-width': 3 } },
        ],
      });
      const cy = cyRef.current;
      // Select on tap
      cy.on('tap', 'node', (evt) => {
        try {
          const n = evt.target; const d = n.data();
          setSelected(d.kind === 'switch' ? { kind: 'switch', id: d.sid } : { kind: 'host', id: d.hid });
        } catch {}
      });
      // Context menu (right-click)
      cy.on('cxttap', 'node', (evt) => {
        try {
          const n = evt.target; const d = n.data();
          const rp = (evt as any).renderedPosition || evt.position;
          const label: string = n.data('label') || '';
          setCtx({ x: rp.x, y: rp.y, kind: d.kind, id: d.kind==='switch' ? d.sid : d.hid, label });
        } catch {}
      });
      // Persist position after drag
      cy.on('dragfree', 'node', async (evt) => {
        try {
          const n = evt.target; const data = n.data();
          const p = n.position();
          if (data.kind === 'switch') {
            await upsertLanSwitch({ id: data.sid, mapId, subnet, posX: p.x, posY: p.y });
          } else if (data.kind === 'host') {
            await upsertLanHost({ id: data.hid, mapId, subnet, posX: p.x, posY: p.y });
          }
        } catch (e) { console.error(e); }
      });
    }
    const cy = cyRef.current!;
    // Rebuild elements from current switches/hosts
    cy.elements().remove();
    // Layout helpers
  const sx = graphSwitches.length;
  const spacingX = 260;
    const baseY = 0;
    // 1) Add switches (centers)
    graphSwitches.forEach((sw, idx) => {
      const id = `sw:${sw.id}`;
      const label = sw.name || 'Switch';
      const node = cy.add({ group: 'nodes', data: { id, label, kind: 'switch', sid: sw.id, type: 'switch' } });
      if (typeof sw.posX === 'number' && typeof sw.posY === 'number') {
        node.position({ x: sw.posX, y: sw.posY });
      } else {
        node.position({ x: (idx - (sx-1)/2) * spacingX, y: baseY });
      }
      (node as any).grabbable(true);
    });
    // 2) Group hosts by assigned switch
    const bySwitch = new Map<string, LanHost[]>();
    const unassigned: LanHost[] = [];
    for (const h of graphHosts) {
      const sid = bindings.get(h.id);
      if (sid && graphSwitches.find(s=>s.id===sid)) {
        const arr = bySwitch.get(sid) || []; arr.push(h); bySwitch.set(sid, arr);
      } else {
        unassigned.push(h);
      }
    }
    // Helper for polar placement around a center
    const polar = (cx:number, cy:number, r:number, i:number, n:number) => {
      const angle0 = -Math.PI/2; // start at top
      const angle = angle0 + (2*Math.PI * i) / Math.max(1, n);
      return { x: cx + r*Math.cos(angle), y: cy + r*Math.sin(angle) };
    };
    const ringRadiusFor = (n:number) => {
      const minR = 200;            // minimum radius
      const minArc = 58;           // desired arc length per node to avoid overlap
      const rBySpacing = (n * minArc) / (2*Math.PI);
      return Math.max(minR, rBySpacing);
    };
    // 3) Add hosts assigned to each switch in a ring and connect edges
    for (const sw of graphSwitches) {
      const cid = `sw:${sw.id}`;
      const center = cy.getElementById(cid).position();
      const arr = bySwitch.get(sw.id) || [];
      const n = arr.length;
      const ringR = ringRadiusFor(Math.max(1, n));
      arr.forEach((h, idx) => {
        const id = `host:${h.id}`;
        const label = h.name ? `${h.name}\n${h.ip || ''}` : (h.ip || 'host');
        const node = cy.add({ group: 'nodes', data: { id, label, kind: 'host', hid: h.id, type: 'host' } });
        if (typeof h.posX === 'number' && typeof h.posY === 'number') {
          node.position({ x: h.posX, y: h.posY });
        } else {
          const p = polar(center.x, center.y, ringR, idx, n);
          node.position(p);
        }
        (node as any).grabbable(true);
        // Edge
        cy.add({ group: 'edges', data: { id: `e:${sw.id}:${h.id}`, source: cid, target: id } });
      });
    }
    // 4) Add unassigned hosts in a wider arc at the bottom
    if (unassigned.length) {
      const baseX = 0; const baseYHosts = 240;
      unassigned.forEach((h, idx) => {
        const id = `host:${h.id}`;
        const label = h.name ? `${h.name}\n${h.ip || ''}` : (h.ip || 'host');
        const node = cy.add({ group: 'nodes', data: { id, label, kind: 'host', hid: h.id, type: 'host' } });
        if (typeof h.posX === 'number' && typeof h.posY === 'number') {
          node.position({ x: h.posX, y: h.posY });
        } else {
          node.position({ x: baseX + (idx - (unassigned.length-1)/2) * 140, y: baseYHosts });
        }
        (node as any).grabbable(true);
      });
    }
    try { cy.fit(cy.elements(), 50); } catch {}
  }, [graphSwitches, graphHosts, mapId, subnet, viewMode]);

  // Global key handlers (ESC handled above in parent, here handle Delete)
  React.useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      if (e.key === 'Delete' && selected) {
        e.preventDefault();
        if (selected.kind === 'switch') { await deleteLanSwitch(mapId, selected.id); }
        else { await deleteLanHost(mapId, selected.id); }
        await load(); setSelected(null);
      }
      if (e.key === 'Escape') setCtx(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, mapId, load]);
  // ESC to close
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    // Use fixed overlay so the LAN header/menu stays locked to the viewport even if the page scrolls
    <div style={{ position: 'fixed', inset: 0, zIndex: 30, display: 'grid', gridTemplateColumns: '300px 1fr' }}>
      {/* Left LAN panel scaffold */}
  <div ref={leftPanelRef} style={{ background: '#0f1a2b', borderRight: '1px solid #1f2a44', padding: 10, overflow: 'auto' }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>LAN Panel</div>
        <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 12 }}>Subnet: {subnet}</div>
        <Section title="Switches">
          <div style={{ display: 'grid', gap: 6 }}>
            <div style={{ display: 'grid', gap: 6 }}>
              <input value={addingSwitch.name} onChange={e=>setAddingSwitch(s=>({...s, name: e.target.value}))} placeholder="Switch name" style={inputStyle} onKeyDown={async (e)=>{ if (e.key==='Enter'){ if (!addingSwitch.name.trim()) return; await upsertLanSwitch({ mapId, subnet, name: addingSwitch.name.trim(), model: addingSwitch.model?.trim(), mgmtIp: addingSwitch.mgmtIp?.trim() }); setAddingSwitch({ name: '' }); await load(); } }} />
              <input value={addingSwitch.model||''} onChange={e=>setAddingSwitch(s=>({...s, model: e.target.value}))} placeholder="Model" style={inputStyle} />
              <input value={addingSwitch.mgmtIp||''} onChange={e=>setAddingSwitch(s=>({...s, mgmtIp: e.target.value}))} placeholder="Mgmt IP" style={inputStyle} />
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                  <input type="checkbox" checked={addingSwitch.managed ?? true} onChange={e=>setAddingSwitch(s=>({...s, managed: e.target.checked}))} /> Managed
                </label>
                <select value={addingSwitch.portCount ?? ''} onChange={e=>setAddingSwitch(s=>({...s, portCount: e.target.value===''? undefined : Number(e.target.value)}))} style={inputStyle as any}>
                  <option value="">Ports (optional)</option>
                  <option value="8">8 ports</option>
                  <option value="12">12 ports</option>
                  <option value="16">16 ports</option>
                  <option value="24">24 ports</option>
                  <option value="48">48 ports</option>
                </select>
              </div>
              <button type="button" onClick={async ()=>{ if (!addingSwitch.name.trim()) return; const swId = await upsertLanSwitch({ mapId, subnet, name: addingSwitch.name.trim(), model: addingSwitch.model?.trim(), mgmtIp: addingSwitch.mgmtIp?.trim(), managed: addingSwitch.managed ?? true, portCount: addingSwitch.portCount }); if (addingSwitch.portCount && addingSwitch.portCount > 0) { for (let i=1;i<=addingSwitch.portCount;i++){ await upsertLanPort({ switchId: swId, idx: i }); } } setAddingSwitch({ name: '', managed: true }); await load(); setSelectedSwitchId(swId); }} style={btnPrimary}>Add Switch</button>
            </div>
            <div style={{ display: 'grid', gap: 4 }}>
              {switches.length === 0 && <div style={{ opacity: 0.7, fontSize: 12 }}>No switches yet.</div>}
              {switches.map(sw => (
                <div id={`switch-item-${sw.id}`} key={sw.id} style={{ display: 'flex', alignItems: 'center', gap: 8, background: selectedSwitchId===sw.id ? '#112240' : '#0b1424', border: '1px solid #1f2a44', padding: 6, borderRadius: 6, cursor: 'pointer' }} onClick={()=>setSelectedSwitchId(sw.id)}>
                  <div style={{ fontWeight: 600 }}>{sw.name || 'Switch'}</div>
                  <div style={{ fontSize: 12, opacity: 0.8 }}>{sw.model || ''}</div>
                  {typeof sw.portCount === 'number' && sw.portCount>0 && (
                    <div style={{ fontSize: 12, opacity: 0.8 }}>{sw.portCount}p</div>
                  )}
                  <div style={{ fontSize: 12, opacity: 0.8 }}>{sw.managed===false ? 'Unmanaged' : 'Managed'}</div>
                  <div style={{ marginLeft: 'auto', fontSize: 12, opacity: 0.8 }}>{sw.mgmtIp || ''}</div>
                  <button type="button" title="Delete switch" onClick={async ()=>{ await deleteLanSwitch(mapId, sw.id); await load(); }} style={btnDanger}>Delete</button>
                </div>
              ))}
            </div>
          </div>
        </Section>
        <Section title="Ports">
          {!selectedSwitchId && (
            <div style={{ opacity: 0.8, fontSize: 12 }}>Select a switch to manage its ports.</div>
          )}
          {selectedSwitchId && (
            <div style={{ display: 'grid', gap: 8 }}>
              <div style={{ display: 'grid', gap: 6 }}>
                <input type="number" value={addingPort.idx ?? ''} onChange={e=>setAddingPort(p=>({...p, idx: e.target.value===''? undefined : Number(e.target.value)}))} placeholder="# (index)" style={inputStyle} onKeyDown={async (e)=>{ if(e.key==='Enter'){ await upsertLanPort({ switchId: selectedSwitchId, idx: addingPort.idx, name: (addingPort.name||'').trim() || undefined, poe: !!addingPort.poe, speed: addingPort.speed }); setAddingPort({}); const p = await listLanPorts(selectedSwitchId); setPorts(p); } }} />
                <input value={addingPort.name ?? ''} onChange={e=>setAddingPort(p=>({...p, name: e.target.value}))} placeholder="Port name" style={inputStyle} />
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                    <input type="checkbox" checked={!!addingPort.poe} onChange={e=>setAddingPort(p=>({...p, poe: e.target.checked}))} /> PoE
                  </label>
                  <select value={addingPort.speed ?? ''} onChange={e=>setAddingPort(p=>({...p, speed: e.target.value||undefined}))} style={inputStyle as any}>
                    <option value="">Auto</option>
                    <option value="1G">1G</option>
                    <option value="2.5G">2.5G</option>
                    <option value="10G">10G</option>
                  </select>
                </div>
                <button type="button" style={btnPrimary} onClick={async ()=>{
                  await upsertLanPort({ switchId: selectedSwitchId, idx: addingPort.idx, name: (addingPort.name||'').trim() || undefined, poe: !!addingPort.poe, speed: addingPort.speed });
                  setAddingPort({});
                  const p = await listLanPorts(selectedSwitchId);
                  setPorts(p);
                }}>Add Port</button>
              </div>
              <div style={{ display: 'grid', gap: 6 }}>
                {ports.length === 0 && <div style={{ opacity: 0.7, fontSize: 12 }}>No ports yet.</div>}
                {ports.map(pt => (
                  <div key={pt.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(80px,auto) minmax(80px,auto) 1fr auto', gap: 8, alignItems: 'center', background: '#0b1424', border: '1px solid #1f2a44', padding: 6, borderRadius: 6 }}>
                    <div style={{ fontSize: 12, opacity: 0.8 }}>#{pt.idx ?? '-'} {pt.name || ''}</div>
                    <div style={{ fontSize: 12, opacity: 0.8 }}>{pt.poe ? 'PoE' : ''} {pt.speed || ''}</div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {vlans.map(v => {
                        const checked = !!portVlans[pt.id]?.has(v.id);
                        return (
                          <label key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 4, background: checked ? '#112240' : '#0f1a2b', border: '1px solid #1f2a44', padding: '2px 6px', borderRadius: 6, fontSize: 12, opacity: (switches.find(s=>s.id===selectedSwitchId)?.managed===false) ? 0.5 : 1 }}>
                            <input type="checkbox" disabled={(switches.find(s=>s.id===selectedSwitchId)?.managed===false)} checked={checked} onChange={async (e)=>{
                              const next = new Set(portVlans[pt.id] || new Set<string>());
                              if (e.target.checked) {
                                await setPortVlanBinding(pt.id, v.id, 'access', true);
                                next.add(v.id);
                              } else {
                                await clearPortVlanBinding(pt.id, v.id);
                                next.delete(v.id);
                              }
                              setPortVlans(prev => ({ ...prev, [pt.id]: next }));
                            }} />
                            VLAN {v.vid ?? ''} {v.name || ''}
                          </label>
                        );
                      })}
                    </div>
                    <button type="button" style={btnDanger} onClick={async ()=>{ await deleteLanPort(pt.id); setPorts(ports.filter(x=>x.id!==pt.id)); }}>Delete</button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Section>
        <Section title="VLANs">
          <div style={{ display: 'grid', gap: 8 }}>
            <div style={{ display: 'grid', gap: 6 }}>
              <input type="number" value={addingVlan.vid ?? ''} onChange={e=>setAddingVlan(v=>({...v, vid: e.target.value===''? undefined : Number(e.target.value)}))} placeholder="VID" style={inputStyle} onKeyDown={async (e)=>{ if(e.key==='Enter'){ await upsertLanVlan({ mapId, subnet, vid: addingVlan.vid, name: (addingVlan.name||'').trim() || undefined }); setAddingVlan({}); const vls = await listLanVlans(mapId, subnet); setVlans(vls); } }} />
              <input value={addingVlan.name ?? ''} onChange={e=>setAddingVlan(v=>({...v, name: e.target.value}))} placeholder="Name" style={inputStyle} />
              <button type="button" style={btnPrimary} onClick={async ()=>{
                await upsertLanVlan({ mapId, subnet, vid: addingVlan.vid, name: (addingVlan.name||'').trim() || undefined });
                setAddingVlan({});
                const vls = await listLanVlans(mapId, subnet);
                setVlans(vls);
              }}>Add VLAN</button>
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              {vlans.length === 0 && <div style={{ opacity: 0.7, fontSize: 12 }}>No VLANs yet.</div>}
              {vlans.map(v => (
                <div key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#0b1424', border: '1px solid #1f2a44', padding: 6, borderRadius: 6 }}>
                  <div style={{ fontWeight: 600 }}>VLAN {v.vid ?? '-'} {v.name || ''}</div>
                  <button type="button" style={{ marginLeft: 'auto', ...btnDanger }} onClick={async ()=>{ await deleteLanVlan(mapId, v.id); setVlans(vlans.filter(x=>x.id!==v.id)); }}>Delete</button>
                </div>
              ))}
            </div>
          </div>
        </Section>
        <Section title="Hosts">
          <div style={{ display: 'grid', gap: 6 }}>
            <div style={{ display: 'grid', gap: 6 }}>
              <input value={addingHost.ip} onChange={e=>setAddingHost(h=>({...h, ip: e.target.value}))} placeholder="IP (e.g., 10.0.0.5)" style={inputStyle} onKeyDown={async (e)=>{ if(e.key==='Enter'){ if (!addingHost.ip.trim()) return; await upsertLanHost({ mapId, subnet, ip: addingHost.ip.trim(), name: addingHost.name?.trim(), kind: addingHost.kind }); setAddingHost({ ip: '' }); await load(); } }} />
              <input value={addingHost.name||''} onChange={e=>setAddingHost(h=>({...h, name: e.target.value}))} placeholder="Name (optional)" style={inputStyle} />
              <select value={addingHost.kind || ''} onChange={e=>setAddingHost(h=>({ ...h, kind: e.target.value || undefined }))} style={inputStyle as any}>
                <option value="">Type (optional)</option>
                <option value="workstation">Workstation</option>
                <option value="server">Server</option>
                <option value="switch">Switch</option>
                <option value="router">Router</option>
                <option value="rtu">RTU</option>
                <option value="rtac">RTAC</option>
                <option value="other">Other</option>
              </select>
              <button type="button" onClick={async ()=>{ if (!addingHost.ip.trim()) return; await upsertLanHost({ mapId, subnet, ip: addingHost.ip.trim(), name: addingHost.name?.trim(), kind: addingHost.kind }); setAddingHost({ ip: '' }); await load(); }} style={btnPrimary}>Add Host</button>
            </div>
            <div style={{ display: 'grid', gap: 4 }}>
              {hosts.length === 0 && <div style={{ opacity: 0.7, fontSize: 12 }}>No manual hosts yet.</div>}
              {hosts.map(h => (
                <div id={`host-item-${h.id}`} key={h.id} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 8, alignItems: 'center', background: '#0b1424', border: '1px solid #1f2a44', padding: 6, borderRadius: 6 }}>
                  <div style={{ fontWeight: 600 }}>{h.ip}</div>
                  <div style={{ fontSize: 12, opacity: 0.85 }}>{h.name || ''}</div>
                  <div style={{ gridColumn: '1 / span 2', display: 'flex', gap: 6, alignItems: 'center' }}>
                    <select value={h.kind || ''} onChange={async (e)=>{ await upsertLanHost({ id: h.id, mapId, subnet, kind: e.target.value || undefined }); await load(); }} style={inputStyle as any}>
                      <option value="">Type</option>
                      <option value="workstation">Workstation</option>
                      <option value="server">Server</option>
                      <option value="switch">Switch</option>
                      <option value="router">Router</option>
                      <option value="rtu">RTU</option>
                      <option value="rtac">RTAC</option>
                      <option value="other">Other</option>
                    </select>
                    {switches.length === 1 && (
                      <select value={hostPortMap.get(h.id) || ''} onChange={async (e)=>{
                        try {
                          const currentPortId = hostPortMap.get(h.id);
                          const newPortId = e.target.value || undefined;
                          if (currentPortId && currentPortId !== newPortId) { await unbindHostFromPort(h.id, currentPortId); }
                          if (newPortId) { await bindHostToPort(h.id, newPortId); }
                          // refresh
                          const rows = await listBindingsForMap(mapId);
                          const swMap = new Map<string, string>(); const hp = new Map<string, string>();
                          rows.forEach(r=>{ swMap.set(r.hostId, r.switchId); hp.set(r.hostId, r.portId); });
                          setBindings(swMap); setHostPortMap(hp);
                        } catch (err) { console.error(err); }
                      }} style={inputStyle as any}>
                        <option value="">Unassigned</option>
                        {ports.map(p => (
                          <option key={p.id} value={p.id}>Port #{p.idx ?? ''} {p.name || ''}</option>
                        ))}
                      </select>
                    )}
                  </div>
                  <button type="button" title="Delete host" onClick={async ()=>{ await deleteLanHost(mapId, h.id); await load(); }} style={btnDanger}>Delete</button>
                </div>
              ))}
            </div>
          </div>
        </Section>
      </div>

  {/* Center LAN graph placeholder and breadcrumb */}
  <div ref={overlayRef} style={{ position: 'relative', background: '#0e1726' }}>
        {/* Breadcrumb header */}
    {/* Keep header pinned within the fixed overlay; absolute is fine because overlay is fixed */}
    <div style={{ position: 'absolute', left: 12, top: 8, zIndex: 2, display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ background: '#13203a', border: '1px solid #223154', color: '#e6edf7', padding: '6px 10px', borderRadius: 6 }}>
            {viewMode==='focus' ? `LAN Focus: ${subnet}` : `Location: ${selectedLocation || (graphSwitches[0]?.location || 'Unset')}`}
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            <button type="button" onClick={()=>setViewMode('focus')} style={{ ...(viewMode==='focus'? btnPrimary : btnSecondary), padding: '4px 8px' }}>Focus</button>
            <button type="button" onClick={()=>{ setViewMode('location'); if (!selectedLocation) { const freq = new Map<string, number>(); switches.forEach(s=>{ if (s.location) freq.set(s.location, (freq.get(s.location)||0)+1); }); let best: string | null = null; let score = 0; freq.forEach((v,k)=>{ if (v>score){ score=v; best=k; } }); setSelectedLocation(best || null); } }} style={{ ...(viewMode==='location'? btnPrimary : btnSecondary), padding: '4px 8px' }}>Location</button>
          </div>
          <button type="button" onClick={()=>{
            // Prefill location modal from most common location among visible switches
            const lc = (()=>{
              const map = new Map<string, number>();
              switches.forEach(s=>{ if (s.location) map.set(s.location, (map.get(s.location)||0)+1); });
              let best: string | null = null; let score = 0; map.forEach((v,k)=>{ if (v>score){ score=v; best=k; } });
              return best || '';
            })();
            setLocationModal({ name: lc, address: locations.find(x=>x.name===lc)?.address, applyToVisible: true });
          }} style={btnSecondary}>Location…</button>
          <button type="button" onClick={onClose} style={{ background: '#1d4ed8', color: '#fff', border: 'none', padding: '6px 10px', borderRadius: 6, cursor: 'pointer' }}>Close</button>
          <button type="button" onClick={()=>{ const cy = cyRef.current; if (!cy) return; try { cy.fit(cy.elements(), 50); } catch {} }} style={{ background: '#0b1424', color: '#e6edf7', border: '1px solid #1f2a44', padding: '6px 10px', borderRadius: 6, cursor: 'pointer' }}>Fit</button>
        </div>
        {viewMode==='location' && includedSubnets.length>1 && (
          <div style={{ position: 'absolute', right: 12, top: 8, zIndex: 2, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {includedSubnets.map(s => (
              <span key={s} style={{ background: subnetColor(s), color: '#0b1220', padding: '2px 6px', borderRadius: 999, fontSize: 12, border: '1px solid #223154' }}>{s}</span>
            ))}
          </div>
        )}
        {/* Cytoscape instance container for LAN graph */}
        <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />

        {/* Context menu */}
        {ctx && (
          <div style={{ position: 'absolute', left: Math.max(8, ctx.x - 10), top: Math.max(40, ctx.y - 10), zIndex: 5, background: '#13203a', border: '1px solid #223154', borderRadius: 8, padding: 6, minWidth: 160 }}
               onClick={e=>e.stopPropagation()} onContextMenu={e=>{ e.preventDefault(); e.stopPropagation(); }}>
            <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 6 }}>{ctx.label}</div>
            <button type="button" style={menuBtn} onClick={() => {
              try {
                if (ctx.kind === 'switch') {
                  setSelectedSwitchId(ctx.id);
                  setTimeout(()=>{
                    const el = document.getElementById(`switch-item-${ctx.id}`);
                    el?.scrollIntoView({ block: 'nearest' });
                  }, 0);
                } else {
                  setTimeout(()=>{
                    const el = document.getElementById(`host-item-${ctx.id}`);
                    el?.scrollIntoView({ block: 'nearest' });
                  }, 0);
                }
              } finally { setCtx(null); }
            }}>Jump to in list</button>
            {ctx.kind === 'host' && (
              <button type="button" style={menuBtn} onClick={() => {
                setAssignModal({ hostId: ctx.id, switchId: selectedSwitchId || switches[0]?.id });
                setCtx(null);
              }}>Assign to port…</button>
            )}
            <button type="button" style={menuBtn} onClick={async ()=>{
              try {
                const key = `${ctx.kind}:${ctx.id}`;
                const m = await getLanNotes(mapId, subnet);
                const existing = m.get(key) || '';
                setNoteModal({ scope: ctx.kind, id: ctx.id, text: existing });
              } finally { setCtx(null); }
            }}>Notes…</button>
            <button type="button" style={{ ...menuBtn, color: '#fff', background: '#7f1d1d', border: 'none' }} onClick={async ()=>{
              if (ctx.kind === 'switch') await deleteLanSwitch(mapId, ctx.id); else await deleteLanHost(mapId, ctx.id);
              await load(); setCtx(null);
            }}>Delete</button>
          </div>
        )}

        {/* Notes modal */}
        {noteModal && (
          <div style={{ position: 'absolute', inset: 0, zIndex: 6, display: 'grid', placeItems: 'center', background: 'rgba(0,0,0,0.35)' }} onClick={()=>setNoteModal(null)}>
            <div style={{ background: '#0f1a2b', border: '1px solid #1f2a44', borderRadius: 8, padding: 12, minWidth: 360 }} onClick={e=>e.stopPropagation()}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Edit notes</div>
              <textarea value={noteModal.text} onChange={e=>setNoteModal({ ...noteModal, text: e.target.value })}
                        style={{ width: '100%', height: 120, background: '#0b1424', color: '#e6edf7', border: '1px solid #1f2a44', borderRadius: 6, padding: 8 }} />
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
                <button type="button" onClick={()=>setNoteModal(null)} style={btnSecondary}>Cancel</button>
                <button type="button" onClick={async ()=>{ try { await setLanNote(mapId, subnet, noteModal.scope, noteModal.id, noteModal.text.trim()); } finally { setNoteModal(null); } }} style={btnPrimary}>Save</button>
              </div>
            </div>
          </div>
        )}

        {/* Location modal */}
        {locationModal && (
          <div style={{ position: 'absolute', inset: 0, zIndex: 7, display: 'grid', placeItems: 'center', background: 'rgba(0,0,0,0.35)' }} onClick={()=>setLocationModal(null)}>
            <div style={{ background: '#0f1a2b', border: '1px solid #1f2a44', borderRadius: 8, padding: 12, minWidth: 420 }} onClick={e=>e.stopPropagation()}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Edit Location</div>
              <div style={{ display: 'grid', gap: 8 }}>
                <input value={locationModal.name} onChange={e=>setLocationModal(m=>m && { ...m, name: e.target.value })} placeholder="Location name (e.g., System Control)" style={inputStyle} />
                <textarea value={locationModal.address||''} onChange={e=>setLocationModal(m=>m && { ...m, address: e.target.value })} placeholder="Address (optional)" style={{ ...inputStyle, height: 90 }} />
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                  <input type="checkbox" checked={locationModal.applyToVisible} onChange={e=>setLocationModal(m=>m && { ...m, applyToVisible: e.target.checked })} />
                  Apply this location to switches in this overlay
                </label>
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
                <button type="button" onClick={()=>setLocationModal(null)} style={btnSecondary}>Cancel</button>
                <button type="button" onClick={async ()=>{
                  try {
                    const nm = (locationModal.name||'').trim(); if (!nm) { setLocationModal(null); return; }
                    await upsertLanLocation(mapId, nm, (locationModal.address||'').trim() || undefined);
                    if (locationModal.applyToVisible) {
                      for (const sw of switches) { await setSwitchLocation(mapId, sw.id, nm); }
                      await load();
                    }
                  } finally { setLocationModal(null); }
                }} style={btnPrimary}>Save</button>
              </div>
            </div>
          </div>
        )}

        {assignModal && (
          <div style={{ position: 'absolute', inset: 0, zIndex: 8, display: 'grid', placeItems: 'center', background: 'rgba(0,0,0,0.35)' }} onClick={()=>setAssignModal(null)}>
            <div style={{ background: '#0f1a2b', border: '1px solid #1f2a44', borderRadius: 8, padding: 12, minWidth: 360 }} onClick={e=>e.stopPropagation()}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Assign host to port</div>
              <div style={{ display: 'grid', gap: 8 }}>
                <select value={assignModal.switchId || ''} onChange={e=>setAssignModal(m => m && ({ ...m, switchId: e.target.value || undefined, portId: undefined }))} style={inputStyle as any}>
                  {switches.length===0 && <option value="">No switches</option>}
                  {switches.map(sw => (
                    <option key={sw.id} value={sw.id}>{sw.name || 'Switch'}</option>
                  ))}
                </select>
                <select value={assignModal.portId || ''} onChange={e=>setAssignModal(m => m && ({ ...m, portId: e.target.value || undefined }))} style={inputStyle as any}>
                  <option value="">Select port…</option>
                  {assignPorts.map(p => (
                    <option key={p.id} value={p.id}>#{p.idx ?? ''} {p.name || ''}</option>
                  ))}
                </select>
                <select value={assignModal.vlanId || ''} onChange={e=>setAssignModal(m => m && ({ ...m, vlanId: e.target.value || undefined }))} style={inputStyle as any}>
                  <option value="">(Optional) Set VLAN untagged…</option>
                  {vlans.map(v => (
                    <option key={v.id} value={v.id}>VLAN {v.vid ?? ''} {v.name || ''}</option>
                  ))}
                </select>
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
                <button type="button" onClick={()=>setAssignModal(null)} style={btnSecondary}>Cancel</button>
                <button type="button" onClick={async ()=>{
                  try {
                    if (!assignModal.switchId || !assignModal.portId) return;
                    await bindHostToPort(assignModal.hostId, assignModal.portId);
                    if (assignModal.vlanId) { await setPortVlanBinding(assignModal.portId, assignModal.vlanId, 'access', true); }
                    await load();
                  } finally { setAssignModal(null); }
                }} style={btnPrimary}>Assign</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children?: React.ReactNode }) {
  const [open, setOpen] = React.useState(true);
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button type="button" onClick={() => setOpen(o => !o)} style={{ background: 'transparent', color: '#93c5fd', border: '1px solid #1f2a44', padding: '4px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>
          {open ? '▾' : '▸'} {title}
        </button>
      </div>
      {open && (
        <div style={{ marginTop: 6 }}>
          {children}
        </div>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = { background: '#0b1424', color: '#e6edf7', border: '1px solid #1f2a44', borderRadius: 6, padding: '6px 8px', minWidth: 0 };
const btnDanger: React.CSSProperties = { background: '#7f1d1d', color: '#fff', border: 'none', padding: '6px 10px', borderRadius: 6, cursor: 'pointer' };
