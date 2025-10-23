import React from 'react';
import {
  listLanSwitches, upsertLanSwitch, deleteLanSwitch,
  listLanHosts, upsertLanHost, deleteLanHost,
  type LanSwitch, type LanHost
} from '../db';

type Props = { mapId: string; subnet: string; onClose: () => void };

// Simple scaffold for LAN Focus overlay. Separate Cytoscape instance will be wired later.
export default function LanOverlay({ mapId, subnet, onClose }: Props) {
  const [switches, setSwitches] = React.useState<LanSwitch[]>([]);
  const [hosts, setHosts] = React.useState<LanHost[]>([]);
  const [addingSwitch, setAddingSwitch] = React.useState<{ name: string; model?: string; mgmtIp?: string }>({ name: '' });
  const [addingHost, setAddingHost] = React.useState<{ ip: string; name?: string }>({ ip: '' });

  const load = React.useCallback(async () => {
    try {
      const sw = await listLanSwitches(mapId, subnet);
      const hs = await listLanHosts(mapId, subnet);
      setSwitches(sw); setHosts(hs);
    } catch (e) { console.error(e); }
  }, [mapId, subnet]);

  React.useEffect(() => { void load(); }, [load]);
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
        </div>
        {/* Future: Cytoscape instance container for LAN graph */}
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#a1b3d6' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 18, marginBottom: 8 }}>LAN graph coming next</div>
            <div style={{ fontSize: 12, opacity: 0.8 }}>We’ll render switches/ports/hosts with persisted layout here.</div>
          </div>
        </div>
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
