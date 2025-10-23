import React from 'react';

type Props = {
  subnet: string;
  onClose: () => void;
};

// Simple scaffold for LAN Focus overlay. Separate Cytoscape instance will be wired later.
export default function LanOverlay({ subnet, onClose }: Props) {
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
          <div style={{ opacity: 0.8, fontSize: 12 }}>Add your switches here (model, mgmt IP, location). Visual wiring coming next.</div>
        </Section>
        <Section title="Ports">
          <div style={{ opacity: 0.8, fontSize: 12 }}>Per-switch ports with status, PoE, speed, VLAN tagging.</div>
        </Section>
        <Section title="VLANs">
          <div style={{ opacity: 0.8, fontSize: 12 }}>Define VLANs and assign to ports (access/trunk/native).</div>
        </Section>
        <Section title="Hosts">
          <div style={{ opacity: 0.8, fontSize: 12 }}>Add/edit hosts not found by parser; binds will appear here.</div>
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
