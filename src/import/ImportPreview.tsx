import React from 'react';
import { parseExcelToCandidates, dedupeCounts, type ParsedCandidates, normText } from './excel';
import { ensureDbReady, listAllLanHosts, listAllLanVlans, listAllMapSwitches, upsertLanHost, upsertLanSwitch, upsertLanVlan, exportDbBytes, type LanHost, type LanVlan, type LanSwitch } from '../db';

export default function ImportPreview(props: { mapId: string; onClose: ()=>void; allowedCidrs?: string[]; onApplied?: (payload: { bytes: Uint8Array; summary: string })=>void }) {
  const { mapId, onClose, allowedCidrs, onApplied } = props;
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [cand, setCand] = React.useState<ParsedCandidates | null>(null);
  const [dbHosts, setDbHosts] = React.useState<LanHost[]>([]);
  const [dbVlans, setDbVlans] = React.useState<LanVlan[]>([]);
  const [dbSwitches, setDbSwitches] = React.useState<LanSwitch[]>([]);
  const [filterToMap, setFilterToMap] = React.useState<boolean>(!!(allowedCidrs && allowedCidrs.length));
  const [includedSheets, setIncludedSheets] = React.useState<Map<string, boolean> | null>(null);

  const fileRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    (async () => {
      try {
        // Ensure DB is initialized (prevents race if preview opens before App init completes)
        await ensureDbReady();
        console.debug('[ImportPreview] Loading existing LAN data for map', mapId);
        const [h, v, s] = await Promise.all([
          listAllLanHosts(mapId),
          listAllLanVlans(mapId),
          listAllMapSwitches(mapId),
        ]);
        console.debug('[ImportPreview] Loaded from DB', { hosts: h.length, vlans: v.length, switches: s.length });
        setDbHosts(h); setDbVlans(v); setDbSwitches(s);
      } catch (e: any) {
        console.error('ImportPreview: DB load failed', e);
        setErr('Failed to load existing LAN data from DB');
      }
    })();
  }, [mapId]);

  type Counts = { total: number; unique: number; removed: number };
  // Minimal IPv4 helpers for subnet matching
  function ipToInt(ip: string): number { const [a,b,c,d] = ip.split('.').map(x=>parseInt(x,10)); return (((a<<24)>>>0) + (b<<16) + (c<<8) + d)>>>0; }
  function maskBits(bits: number): number { return bits===0 ? 0 : (~0 << (32-bits))>>>0; }
  function intToIp(n: number): string { return [(n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255].join('.'); }
  function prefixLen(cidr: string): number { const p = parseInt(cidr.split('/')[1]||'32',10); return Number.isFinite(p)?p:32; }
  function contains(cidr: string, ip: string): boolean { const [n,ps] = cidr.split('/'); const m = maskBits(parseInt(ps||'32',10)); return (ipToInt(ip)&m) === (ipToInt(n)&m); }
  function to24(ip: string): string { const base = ipToInt(ip) & maskBits(24); return `${intToIp(base)}/24`; }

  const isSheetIncluded = React.useCallback((name: string) => {
    if (!includedSheets) return true;
    const v = includedSheets.get(name);
    return v !== false;
  }, [includedSheets]);
  const ipInAllowed = React.useCallback((ip?: string) => {
    if (!filterToMap) return true;
    if (!ip || !/(^\d{1,3}(?:\.\d{1,3}){3}$)/.test(ip)) return false;
    const arr = allowedCidrs || [];
    for (const c of arr) { if (contains(c, ip)) return true; }
    return false;
  }, [filterToMap, allowedCidrs]);

  // Initialize sheet list when a file is parsed
  React.useEffect(() => {
    if (!cand) { setIncludedSheets(null); return; }
    if (includedSheets) return;
    const names = new Set<string>();
    for (const r of [...cand.hosts, ...cand.vlans, ...cand.switches, ...cand.subnets]) names.add(r.sheet);
    const m = new Map<string, boolean>();
    Array.from(names).forEach(n => m.set(n, true));
    setIncludedSheets(m);
  }, [cand, includedSheets]);

  const filtered = React.useMemo(() => {
    if (!cand) return null;
    const hosts = cand.hosts.filter(h => isSheetIncluded(h.sheet) && (h.ip ? ipInAllowed(h.ip) : true));
    const vlans = cand.vlans.filter(v => isSheetIncluded(v.sheet));
    const switches = cand.switches.filter(s => isSheetIncluded(s.sheet) && (s.mgmt ? ipInAllowed(s.mgmt) : true));
    const subnets = cand.subnets.filter(s => isSheetIncluded(s.sheet));
    return { hosts, vlans, switches, subnets } as ParsedCandidates;
  }, [cand, includedSheets, isSheetIncluded, ipInAllowed]);

  // Unknown networks derived from host IPs not contained in any known subnet (map or sheet)
  const unknownNetworks = React.useMemo(() => {
    if (!filtered) return [] as string[];
    const known = new Set<string>();
    (allowedCidrs || []).forEach(c => known.add(c));
    filtered.subnets.forEach(s => known.add(s.cidr));
    const out = new Set<string>();
    for (const h of filtered.hosts) {
      const ip = (h as any).ip as string | undefined;
      if (!ip || !/(^\d{1,3}(?:\.\d{1,3}){3}$)/.test(ip)) continue;
      let inKnown = false;
      for (const c of known) { if (contains(c, ip)) { inKnown = true; break; } }
      if (!inKnown) out.add(to24(ip));
    }
    return Array.from(out).sort();
  }, [filtered, allowedCidrs]);

  const hostCounts: Counts | null = React.useMemo(() => filtered ? dedupeCounts(filtered.hosts) : null, [filtered]);
  const vlanCounts: Counts | null = React.useMemo(() => filtered ? dedupeCounts(filtered.vlans) : null, [filtered]);
  const switchCounts: Counts | null = React.useMemo(() => filtered ? dedupeCounts(filtered.switches) : null, [filtered]);
  const subnetCounts: Counts | null = React.useMemo(() => filtered ? dedupeCounts(filtered.subnets) : null, [filtered]);

  // Build DB indexes
  const dbHostIdx = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const h of dbHosts) {
      if (h.mac) m.set(`mac:${h.mac.toUpperCase().replace(/[^0-9A-F]/g,'')}`, (m.get(`mac:${h.mac.toUpperCase().replace(/[^0-9A-F]/g,'')}`)||0)+1);
      if (h.ip) m.set(`ip:${h.ip}`, (m.get(`ip:${h.ip}`)||0)+1);
      if (h.name) m.set(`host:${normText(h.name)}`, (m.get(`host:${normText(h.name)}`)||0)+1);
    }
    return m;
  }, [dbHosts]);
  const dbVlanIdx = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const v of dbVlans) {
      if (typeof v.vid === 'number') m.set(`vid:${v.vid}`, (m.get(`vid:${v.vid}`)||0)+1);
      if (v.name) m.set(`vname:${normText(v.name)}`, (m.get(`vname:${normText(v.name)}`)||0)+1);
    }
    return m;
  }, [dbVlans]);
  const dbSwitchIdx = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const s of dbSwitches) {
      if (s.mgmtIp) m.set(`mgmt:${s.mgmtIp}`, (m.get(`mgmt:${s.mgmtIp}`)||0)+1);
      const nm = s.name ? normText(s.name) : '';
      const md = s.model ? normText(s.model) : '';
      if (nm || md) m.set(`name:${nm}|model:${md}`, (m.get(`name:${nm}|model:${md}`)||0)+1);
    }
    return m;
  }, [dbSwitches]);

  function classify(keys: (string|undefined)[], idx: Map<string, number>) {
    const uniq = Array.from(new Set(keys.filter(Boolean) as string[]));
    let add = 0, merge = 0, conflict = 0;
    for (const k of uniq) {
      const n = idx.get(k) || 0;
      if (n === 0) add++; else if (n === 1) merge++; else conflict++;
    }
    return { add, merge, conflict, totalKeys: uniq.length };
  }

  const classHosts = React.useMemo(() => filtered ? classify(filtered.hosts.map(h=>h.key), dbHostIdx) : null, [filtered, dbHostIdx]);
  const classVlans = React.useMemo(() => filtered ? classify(filtered.vlans.map(v=>v.key), dbVlanIdx) : null, [filtered, dbVlanIdx]);
  const classSwitches = React.useMemo(() => filtered ? classify(filtered.switches.map(s=>s.key), dbSwitchIdx) : null, [filtered, dbSwitchIdx]);

  // Group by key with sample rows
  function groupByKey<T extends { key?: string }>(items: T[]): Map<string, T[]> {
    const m = new Map<string, T[]>();
    for (const it of items) {
      if (!it.key) continue;
      const arr = m.get(it.key) || [];
      arr.push(it);
      m.set(it.key, arr);
    }
    return m;
  }
  const hostGroups = React.useMemo(() => filtered ? groupByKey(filtered.hosts) : new Map<string, any[]>(), [filtered]);
  const vlanGroups = React.useMemo(() => filtered ? groupByKey(filtered.vlans) : new Map<string, any[]>(), [filtered]);
  const switchGroups = React.useMemo(() => filtered ? groupByKey(filtered.switches) : new Map<string, any[]>(), [filtered]);

  function badgeForKey(key: string, idx: Map<string, number>): { label: 'New'|'Merge'|'Conflict'; color: string } {
    const n = idx.get(key) || 0;
    if (n === 0) return { label: 'New', color: '#16a34a' };
    if (n === 1) return { label: 'Merge', color: '#60a5fa' };
    return { label: 'Conflict', color: '#f87171' };
  }

  function downloadJson(name: string, obj: any) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    setTimeout(()=> URL.revokeObjectURL(url), 5000);
  }

  function netAddr(cidr: string): number { const [n,ps] = cidr.split('/'); const m = maskBits(parseInt(ps||'32',10)); return (ipToInt(n) & m); }
  function bestSubnetForIp(ip?: string): { cidr: string; source: 'map'|'sheet'; prefix: number } | null {
    if (!ip || !/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) return null;
    const sheetNets = filtered?.subnets?.map(s=>s.cidr) || [];
    const mapNets = allowedCidrs || [];
    let best: { cidr: string; source: 'map'|'sheet'; prefix: number } | null = null;
    // Check sheet-provided subnets
    for (const c of sheetNets) {
      if (contains(c, ip)) {
        const p = prefixLen(c);
        if (!best || p > best.prefix) best = { cidr: c, source: 'sheet', prefix: p };
      }
    }
    // Also check map (firewall interfaces)
    for (const c of mapNets) {
      if (contains(c, ip)) {
        const p = prefixLen(c);
        if (!best || p > best.prefix) best = { cidr: c, source: 'map', prefix: p };
      }
    }
    return best;
  }

  const onPickFile = React.useCallback(async (e?: React.ChangeEvent<HTMLInputElement>) => {
    try {
      setErr(null); setBusy(true);
      const files = e?.target?.files ?? fileRef.current?.files;
      if (!files || files.length === 0) return;
      const f = files[0]; setFileName(f.name);
      const buf = await f.arrayBuffer();
      const parsed = await parseExcelToCandidates(buf);
      setCand(parsed);
      if (fileRef.current) fileRef.current.value = '';
    } catch (ex: any) {
      setErr(`Failed to parse Excel: ${String(ex?.message || ex)}`);
    } finally { setBusy(false); }
  }, []);

  // Apply new-only items safely
  const onApplyNew = React.useCallback(async () => {
    if (!filtered) return;
    try {
      setBusy(true); setErr(null);
      // 1) Snapshot DB for Undo
      const snap = await exportDbBytes();
      // 2) Build per-sheet subnet lookup for VLAN placement heuristic
      const sheetSubnets = new Map<string, string[]>();
      for (const s of filtered.subnets) {
        const arr = sheetSubnets.get(s.sheet) || []; arr.push(s.cidr); sheetSubnets.set(s.sheet, arr);
      }
      function guessSubnetForSheet(sheet: string): string | null {
        const arr = sheetSubnets.get(sheet) || [];
        if (arr.length === 1) return arr[0];
        return null; // ambiguous
      }
      // 3) Decide what to insert (uniques with New classification)
      let addHosts = 0, addSwitches = 0, addVlans = 0, skipHosts = 0, skipSwitches = 0, skipVlans = 0;
      // Hosts
      for (const [key, rows] of hostGroups) {
        const badge = badgeForKey(key, dbHostIdx).label; if (badge !== 'New') continue;
        // Prefer a row with an IP for placement
        const rAny = (rows as any[]);
        const withIp = rAny.find(x=> x.ip) || rAny[0];
        const ip = withIp?.ip as string | undefined;
        const tgt = bestSubnetForIp(ip);
        if (!tgt) { skipHosts++; continue; }
        try {
          await upsertLanHost({ mapId, subnet: tgt.cidr, ip: ip, mac: withIp?.mac, name: withIp?.name, source: 'import' });
          addHosts++;
        } catch (e) { console.error('Apply host failed', key, e); skipHosts++; }
      }
      // Switches
      for (const [key, rows] of switchGroups) {
        const badge = badgeForKey(key, dbSwitchIdx).label; if (badge !== 'New') continue;
        const r0: any = rows[0] as any;
        const ip = r0?.mgmt as string | undefined;
        const tgt = bestSubnetForIp(ip);
        if (!tgt) { skipSwitches++; continue; }
        try {
          await upsertLanSwitch({ mapId, subnet: tgt.cidr, name: r0?.name, model: r0?.model, mgmtIp: r0?.mgmt });
          addSwitches++;
        } catch (e) { console.error('Apply switch failed', key, e); skipSwitches++; }
      }
      // VLANs (heuristic: single subnet detected on the same sheet)
      for (const [key, rows] of vlanGroups) {
        const badge = badgeForKey(key, dbVlanIdx).label; if (badge !== 'New') continue;
        const r0: any = rows[0] as any;
        const subnet = guessSubnetForSheet(r0?.sheet);
        if (!subnet) { skipVlans++; continue; }
        try {
          await upsertLanVlan({ mapId, subnet, vid: r0?.vid, name: r0?.name });
          addVlans++;
        } catch (e) { console.error('Apply vlan failed', key, e); skipVlans++; }
      }
      const summary = `added hosts=${addHosts}, switches=${addSwitches}, vlans=${addVlans}; skipped hosts=${skipHosts}, switches=${skipSwitches}, vlans=${skipVlans}`;
      console.debug('[ImportPreview] Apply summary:', summary);
      onApplied && onApplied({ bytes: snap, summary });
    } catch (e:any) {
      console.error('Apply failed', e); setErr(`Apply failed: ${String(e?.message || e)}`);
    } finally { setBusy(false); }
  }, [filtered, hostGroups, switchGroups, vlanGroups, dbHostIdx, dbSwitchIdx, dbVlanIdx, bestSubnetForIp, mapId, onApplied]);

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.45)', display: 'grid', placeItems: 'center' }} onClick={onClose}>
      <div style={{ background: '#0f1a2b', color: '#e6edf7', border: '1px solid #1f2a44', borderRadius: 10, padding: 12, width: 900, maxHeight: '80vh', overflow: 'auto' }} onClick={e=>e.stopPropagation()}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
          <div style={{ fontWeight: 700, fontSize: 16 }}>Import from Excel — Preview</div>
          <div style={{ marginLeft: 'auto' }}>
            <button type="button" onClick={onClose} style={{ background: 'transparent', color: '#e6edf7', border: '1px solid #2b3b5e', padding: '4px 10px', borderRadius: 6, cursor: 'pointer' }}>Close</button>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
          <input type="file" accept=".xls,.xlsx" ref={fileRef} onChange={onPickFile} style={{ display: 'none' }} />
          <button type="button" onClick={()=>fileRef.current?.click()} style={{ background: '#1d4ed8', color: 'white', border: 'none', padding: '6px 10px', borderRadius: 6, cursor: 'pointer' }}>
            Choose spreadsheet…
          </button>
          <div style={{ opacity: 0.85, fontSize: 12 }}>{fileName || 'No file selected'}</div>
        </div>
        {err && <div style={{ color: '#fca5a5', marginBottom: 10 }}>{err}</div>}
        {/* Scope controls */}
        {cand && (
          <div style={{ background: '#0b1220', border: '1px solid #1f2a44', borderRadius: 8, padding: 10, marginBottom: 10 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Scope</div>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={filterToMap} onChange={(e)=> setFilterToMap(e.target.checked)} />
                Filter to current map networks{allowedCidrs && allowedCidrs.length ? ` (${allowedCidrs.length})` : ''}
              </label>
              {includedSheets && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ opacity: 0.85, fontSize: 12 }}>Sheets:</span>
                  <button type="button" onClick={()=>{
                    const m = new Map(includedSheets); m.forEach((_,k)=> m.set(k, true)); setIncludedSheets(m);
                  }} style={{ background: 'transparent', color: '#93c5fd', border: '1px solid #2b3b5e', padding: '2px 6px', borderRadius: 6, fontSize: 12 }}>Select all</button>
                  <button type="button" onClick={()=>{
                    const m = new Map(includedSheets); m.forEach((_,k)=> m.set(k, false)); setIncludedSheets(m);
                  }} style={{ background: 'transparent', color: '#93c5fd', border: '1px solid #2b3b5e', padding: '2px 6px', borderRadius: 6, fontSize: 12 }}>Clear</button>
                  {Array.from(includedSheets.entries()).map(([name, on]) => (
                    <label key={name} style={{ display: 'flex', alignItems: 'center', gap: 4, background: '#0f1a2b', border: '1px solid #1f2a44', padding: '2px 6px', borderRadius: 6, fontSize: 12 }}>
                      <input type="checkbox" checked={on} onChange={(e)=>{ const m = new Map(includedSheets); m.set(name, e.target.checked); setIncludedSheets(m); }} />
                      {name}
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
        {!cand && (
          <div style={{ opacity: 0.8 }}>Pick an Excel file (.xls or .xlsx). Nothing is written to your map in preview.</div>
        )}
        {cand && (
          <div style={{ display: 'grid', gap: 10 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 8 }}>
              <SummaryCard title="Hosts" counts={hostCounts} cls={classHosts} />
              <SummaryCard title="VLANs" counts={vlanCounts} cls={classVlans} />
              <SummaryCard title="Switches" counts={switchCounts} cls={classSwitches} />
              <SummaryCard title="Subnets" counts={subnetCounts} note="Info only (not stored)" />
            </div>
            {/* Unknown networks callout */}
            <div style={{ background: '#0b1220', border: '1px dashed #334155', borderRadius: 8, padding: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ fontWeight: 600 }}>Unmapped networks from host IPs</div>
                <div style={{ marginLeft: 'auto', opacity: 0.85 }}>count: {unknownNetworks.length}</div>
              </div>
              {unknownNetworks.length > 0 && (
                <div style={{ marginTop: 6, display: 'grid', gap: 4 }}>
                  {unknownNetworks.slice(0, 40).map(c => (
                    <div key={c} style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, opacity: 0.9 }}>{c}</div>
                  ))}
                  {unknownNetworks.length > 40 && <div style={{ opacity: 0.7, fontSize: 12 }}>… and {unknownNetworks.length - 40} more</div>}
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
                    <button type="button" onClick={()=> downloadJson('networks-delta.json', { unknownNetworks })} style={{ background: '#1d4ed8', color: 'white', border: 'none', padding: '4px 8px', borderRadius: 6, fontSize: 12 }}>Export delta</button>
                  </div>
                </div>
              )}
            </div>
            <div style={{ opacity: 0.8, fontSize: 12 }}>Classification:
              <span style={{ marginLeft: 8, color: '#86efac' }}>New = not in DB</span>
              <span style={{ marginLeft: 8, color: '#93c5fd' }}>Merge = single DB match</span>
              <span style={{ marginLeft: 8, color: '#fca5a5' }}>Conflict = multiple DB matches</span>
            </div>
            {/* Details */}
            <Details
              title="Hosts"
              groups={hostGroups}
              classify={(k)=>badgeForKey(k, dbHostIdx)}
              renderItem={(k, rows)=> {
                const any = rows[0] as any;
                const ip = any?.ip as string|undefined;
                const tgt = bestSubnetForIp(ip);
                return `${k}${ip ? `  ip:${ip}`: ''}${any?.mac ? `  mac:${any?.mac}`: ''}${any?.name ? `  name:${any?.name}`: ''}${tgt ? `  → ${tgt.cidr} [${tgt.source}]` : ''}`;
              }}
              onExport={() => {
                const out = Array.from(hostGroups.entries()).map(([k, arr])=>{
                  const cls = badgeForKey(k, dbHostIdx).label;
                  const rows = arr.map((r:any)=> {
                    const tgt = bestSubnetForIp(r.ip);
                    return { ...r, targetSubnet: tgt?.cidr ?? null, targetSubnetSource: tgt?.source ?? null, targetSubnetPrefix: tgt?.prefix ?? null };
                  });
                  return { key:k, classification: cls, rows };
                });
                downloadJson('hosts-preview.json', out);
              }}
            />
            <Details
              title="VLANs"
              groups={vlanGroups}
              classify={(k)=>badgeForKey(k, dbVlanIdx)}
              renderItem={(k, rows)=> `${k}${rows[0]?.vid != null ? `  vid:${rows[0]?.vid}`: ''}${rows[0]?.name ? `  name:${rows[0]?.name}`: ''}`}
              onExport={() => {
                const out = Array.from(vlanGroups.entries()).map(([k, arr])=>({ key:k, classification: badgeForKey(k, dbVlanIdx).label, rows: arr }));
                downloadJson('vlans-preview.json', out);
              }}
            />
            <Details
              title="Switches"
              groups={switchGroups}
              classify={(k)=>badgeForKey(k, dbSwitchIdx)}
              renderItem={(k, rows)=> `${k}${rows[0]?.name ? `  name:${rows[0]?.name}`: ''}${rows[0]?.model ? `  model:${rows[0]?.model}`: ''}${rows[0]?.mgmt ? `  mgmt:${rows[0]?.mgmt}`: ''}`}
              onExport={() => {
                const out = Array.from(switchGroups.entries()).map(([k, arr])=>({ key:k, classification: badgeForKey(k, dbSwitchIdx).label, rows: arr }));
                downloadJson('switches-preview.json', out);
              }}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" disabled={busy || !filtered} onClick={onApplyNew} style={{ background: busy ? '#374151' : '#16a34a', color: 'white', border: 'none', padding: '6px 10px', borderRadius: 6 }}>
                {busy ? 'Applying…' : 'Apply (New only)'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Details<T>(props: {
  title: string;
  groups: Map<string, T[]>;
  classify: (key: string)=> { label: 'New'|'Merge'|'Conflict'; color: string };
  renderItem: (key: string, rows: T[])=> string;
  onExport: ()=>void;
}) {
  const { title, groups, classify, renderItem, onExport } = props;
  const [open, setOpen] = React.useState(false);
  const [dupsOnly, setDupsOnly] = React.useState(false);
  const entriesAll = React.useMemo(()=> Array.from(groups.entries()), [groups]);
  const entries = React.useMemo(() => dupsOnly ? entriesAll.filter(([,rows]) => rows.length > 1) : entriesAll, [entriesAll, dupsOnly]);
  const shown = open ? entries : entries.slice(0, 200);
  return (
    <div style={{ background: '#0b1220', border: '1px solid #1f2a44', borderRadius: 8, padding: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <div style={{ fontWeight: 600 }}>{title} details</div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <input type="checkbox" checked={dupsOnly} onChange={(e)=> setDupsOnly(e.target.checked)} />
            Duplicates only
          </label>
          <button type="button" onClick={onExport} style={{ background: '#1d4ed8', color: 'white', border: 'none', padding: '4px 8px', borderRadius: 6, fontSize: 12 }}>Export JSON</button>
          <button type="button" onClick={()=> setOpen(v=>!v)} style={{ background: 'transparent', color: '#e6edf7', border: '1px solid #2b3b5e', padding: '4px 8px', borderRadius: 6, fontSize: 12 }}>{open ? 'Collapse' : `Expand (${entries.length})`}</button>
        </div>
      </div>
      <div style={{ display: 'grid', gap: 4 }}>
        {shown.map(([k, rows]) => {
          const b = classify(k);
          return (
            <div key={k} style={{ display: 'flex', gap: 8, alignItems: 'center', background: '#0f1a2b', border: '1px solid #1f2a44', borderRadius: 6, padding: '6px 8px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }}>
              <span style={{ background: b.color, color: '#0b1220', padding: '2px 6px', borderRadius: 999, fontWeight: 700 }}>{b.label}</span>
              <span style={{ opacity: 0.9 }}>{renderItem(k, rows)}</span>
              <span style={{ marginLeft: 'auto', opacity: 0.7 }}>rows: {rows.length}</span>
            </div>
          );
        })}
        {entries.length > shown.length && (
          <div style={{ opacity: 0.7, fontSize: 12 }}>Showing first {shown.length} of {entries.length}… Expand to view all.</div>
        )}
      </div>
    </div>
  );
}

function SummaryCard(props: { title: string; counts: { total:number; unique:number; removed:number } | null; cls?: { add:number; merge:number; conflict:number; totalKeys:number } | null; note?: string }) {
  const { title, counts, cls, note } = props;
  return (
    <div style={{ background: '#0b1220', border: '1px solid #1f2a44', borderRadius: 8, padding: 10 }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>{title}</div>
      {counts ? (
        <div style={{ fontSize: 12, display: 'grid', gap: 2 }}>
          <div>Rows: {counts.total}</div>
          <div>Unique keys: {counts.unique} {counts.removed>0 && <span style={{ opacity: 0.7 }}>({counts.removed} dups removed)</span>}</div>
          {cls && (
            <div style={{ display: 'grid', gap: 2 }}>
              <div><span style={{ color: '#86efac' }}>New</span>: {cls.add}</div>
              <div><span style={{ color: '#93c5fd' }}>Merge</span>: {cls.merge}</div>
              <div><span style={{ color: '#fca5a5' }}>Conflict</span>: {cls.conflict}</div>
            </div>
          )}
          {note && <div style={{ opacity: 0.7 }}>{note}</div>}
        </div>
      ) : (
        <div style={{ opacity: 0.6 }}>—</div>
      )}
    </div>
  );
}
