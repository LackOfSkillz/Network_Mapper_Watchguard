import React from 'react';
import {
  listLanSwitches, upsertLanSwitch, deleteLanSwitch,
  listLanHosts, upsertLanHost, deleteLanHost,
  type LanSwitch, type LanHost
} from '../db';
import cytoscape, { Core } from 'cytoscape';

type Props = { mapId: string; subnet: string; onClose: () => void };

// Simple scaffold for LAN Focus overlay. Separate Cytoscape instance will be wired later.
export default function LanOverlay({ mapId, subnet, onClose }: Props) {
  const [switches, setSwitches] = React.useState<LanSwitch[]>([]);
  const [hosts, setHosts] = React.useState<LanHost[]>([]);
  const [addingSwitch, setAddingSwitch] = React.useState<{ name: string; model?: string; mgmtIp?: string }>({ name: '' });
  const [addingHost, setAddingHost] = React.useState<{ ip: string; name?: string }>({ ip: '' });
  const cyRef = React.useRef<Core | null>(null);
  const containerRef = React.useRef<HTMLDivElement | null>(null);

  const load = React.useCallback(async () => {
    try {
      const sw = await listLanSwitches(mapId, subnet);
      const hs = await listLanHosts(mapId, subnet);
      setSwitches(sw); setHosts(hs);
    } catch (e) { console.error(e); }
  }, [mapId, subnet]);

  React.useEffect(() => { void load(); }, [load]);

  // Build/refresh LAN Cytoscape micro-graph
  React.useEffect(() => {
    if (!containerRef.current) return;
    if (!cyRef.current) {
      cyRef.current = cytoscape({
        container: containerRef.current,
        elements: [],
        style: [
          { selector: 'node', style: { 'background-color': '#1b2942', 'border-color': '#3b4d75', 'border-width': 2, 'label': 'data(label)', 'color': '#e6edf7', 'font-size': 11, 'text-wrap': 'wrap', 'text-max-width': '160px' } },
          { selector: 'node[type = "switch"]', style: { 'shape': 'round-rectangle', 'padding': '8px 10px', 'width': 'label', 'height': 'label' } },
          { selector: 'node[type = "host"]', style: { 'shape': 'ellipse', 'width': 26, 'height': 26, 'text-valign': 'bottom', 'text-margin-y': -6 } },
          { selector: 'edge', style: { 'width': 2, 'line-color': '#6b7daa', 'curve-style': 'bezier' } },
          { selector: '.active', style: { 'border-color': '#4f8ef7', 'border-width': 3 } },
        ],
      });
      const cy = cyRef.current;
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
    const sx = switches.length;
    const spacingX = 200;
    const baseY = 160;
    switches.forEach((sw, idx) => {
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
    const hx = hosts.length;
    const hostRowY = baseY + 160;
    hosts.forEach((h, idx) => {
      const id = `host:${h.id}`;
      const label = h.name ? `${h.name}\n${h.ip || ''}` : (h.ip || 'host');
      const node = cy.add({ group: 'nodes', data: { id, label, kind: 'host', hid: h.id, type: 'host' } });
      if (typeof h.posX === 'number' && typeof h.posY === 'number') {
        node.position({ x: h.posX, y: h.posY });
      } else {
        node.position({ x: (idx - (hx-1)/2) * 160, y: hostRowY });
      }
      (node as any).grabbable(true);
    });
    try { cy.fit(cy.elements(), 50); } catch {}
  }, [switches, hosts, mapId, subnet]);
  // ESC to close
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 30, display: 'grid', gridTemplateColumns: '300px 1fr' }}>
      {/* Left LAN panel scaffold */}
      <div style={{ background: '#0f1a2b', borderRight: '1px solid #1f2a44', padding: 10, overflow: 'auto' }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>LAN Panel</div>
        <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 12 }}>Subnet: {subnet}</div>
        <Section title="Switches">
          <div style={{ display: 'grid', gap: 6 }}>
            <div style={{ display: 'flex', gap: 6 }}>
              <input value={addingSwitch.name} onChange={e=>setAddingSwitch(s=>({...s, name: e.target.value}))} placeholder="Switch name" style={inputStyle} />
              <input value={addingSwitch.model||''} onChange={e=>setAddingSwitch(s=>({...s, model: e.target.value}))} placeholder="Model" style={inputStyle} />
              <input value={addingSwitch.mgmtIp||''} onChange={e=>setAddingSwitch(s=>({...s, mgmtIp: e.target.value}))} placeholder="Mgmt IP" style={inputStyle} />
              <button type="button" onClick={async ()=>{ if (!addingSwitch.name.trim()) return; await upsertLanSwitch({ mapId, subnet, name: addingSwitch.name.trim(), model: addingSwitch.model?.trim(), mgmtIp: addingSwitch.mgmtIp?.trim() }); setAddingSwitch({ name: '' }); await load(); }} style={btnPrimary}>Add</button>
            </div>
            <div style={{ display: 'grid', gap: 4 }}>
              {switches.length === 0 && <div style={{ opacity: 0.7, fontSize: 12 }}>No switches yet.</div>}
              {switches.map(sw => (
                <div key={sw.id} style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#0b1424', border: '1px solid #1f2a44', padding: 6, borderRadius: 6 }}>
                  <div style={{ fontWeight: 600 }}>{sw.name || 'Switch'}</div>
                  <div style={{ fontSize: 12, opacity: 0.8 }}>{sw.model || ''}</div>
                  <div style={{ marginLeft: 'auto', fontSize: 12, opacity: 0.8 }}>{sw.mgmtIp || ''}</div>
                  <button type="button" title="Delete switch" onClick={async ()=>{ await deleteLanSwitch(mapId, sw.id); await load(); }} style={btnDanger}>Delete</button>
                </div>
              ))}
            </div>
          </div>
        </Section>
        <Section title="Ports">
          <div style={{ opacity: 0.8, fontSize: 12 }}>Per-switch ports with status, PoE, speed, VLAN tagging.</div>
        </Section>
        <Section title="VLANs">
          <div style={{ opacity: 0.8, fontSize: 12 }}>Define VLANs and assign to ports (access/trunk/native).</div>
        </Section>
        <Section title="Hosts">
          <div style={{ display: 'grid', gap: 6 }}>
            <div style={{ display: 'flex', gap: 6 }}>
              <input value={addingHost.ip} onChange={e=>setAddingHost(h=>({...h, ip: e.target.value}))} placeholder="IP (e.g., 10.0.0.5)" style={inputStyle} />
              <input value={addingHost.name||''} onChange={e=>setAddingHost(h=>({...h, name: e.target.value}))} placeholder="Name (optional)" style={inputStyle} />
              <button type="button" onClick={async ()=>{ if (!addingHost.ip.trim()) return; await upsertLanHost({ mapId, subnet, ip: addingHost.ip.trim(), name: addingHost.name?.trim() }); setAddingHost({ ip: '' }); await load(); }} style={btnPrimary}>Add</button>
            </div>
            <div style={{ display: 'grid', gap: 4 }}>
              {hosts.length === 0 && <div style={{ opacity: 0.7, fontSize: 12 }}>No manual hosts yet.</div>}
              {hosts.map(h => (
                <div key={h.id} style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#0b1424', border: '1px solid #1f2a44', padding: 6, borderRadius: 6 }}>
                  <div style={{ fontWeight: 600 }}>{h.ip}</div>
                  <div style={{ fontSize: 12, opacity: 0.8 }}>{h.name || ''}</div>
                  <button type="button" title="Delete host" onClick={async ()=>{ await deleteLanHost(mapId, h.id); await load(); }} style={btnDanger}>Delete</button>
                </div>
              ))}
            </div>
          </div>
        </Section>
      </div>

      {/* Center LAN graph placeholder and breadcrumb */}
      <div style={{ position: 'relative', background: '#0e1726' }}>
        {/* Breadcrumb header */}
        <div style={{ position: 'absolute', left: 12, top: 8, zIndex: 2, display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ background: '#13203a', border: '1px solid #223154', color: '#e6edf7', padding: '6px 10px', borderRadius: 6 }}>
            LAN Focus: {subnet}
          </div>
          <button type="button" onClick={onClose} style={{ background: '#1d4ed8', color: '#fff', border: 'none', padding: '6px 10px', borderRadius: 6, cursor: 'pointer' }}>Close</button>
          <button type="button" onClick={()=>{ const cy = cyRef.current; if (!cy) return; try { cy.fit(cy.elements(), 50); } catch {} }} style={{ background: '#0b1424', color: '#e6edf7', border: '1px solid #1f2a44', padding: '6px 10px', borderRadius: 6, cursor: 'pointer' }}>Fit</button>
        </div>
        {/* Cytoscape instance container for LAN graph */}
        <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
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
const btnPrimary: React.CSSProperties = { background: '#1d4ed8', color: '#fff', border: 'none', padding: '6px 10px', borderRadius: 6, cursor: 'pointer' };
const btnDanger: React.CSSProperties = { background: '#7f1d1d', color: '#fff', border: 'none', padding: '6px 10px', borderRadius: 6, cursor: 'pointer' };
