// src/db.ts
// Lightweight browser-local SQLite (WASM) persistence for annotations and maps.
// Tech: sql.js (WASM) + idb-keyval (IndexedDB) for durable storage.

import initSqlJs, { Database, SqlJsStatic } from 'sql.js';
import { get as idbGet, set as idbSet } from 'idb-keyval';
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url';

const DB_KEY = 'wgmap.sqlite';

let SQL: SqlJsStatic | null = null;
let db: Database | null = null;

async function loadSql(): Promise<SqlJsStatic> {
  if (SQL) return SQL;
  SQL = await initSqlJs({ locateFile: () => sqlWasmUrl });
  return SQL;
}

async function loadDbBytes(): Promise<Uint8Array | null> {
  try {
    const data = await idbGet(DB_KEY);
    if (!data) return null;
    if (data instanceof Uint8Array) return data;
    if (Array.isArray(data)) return new Uint8Array(data);
    return null;
  } catch {
    return null;
  }
}

async function persist(): Promise<void> {
  if (!db) return;
  const data = db.export();
  await idbSet(DB_KEY, data);
}

export type MapRow = {
  id: string;
  name: string;
  xmlName?: string;
  createdAt: number;
  updatedAt: number;
};

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 0xf) >>> 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export async function initDb(): Promise<void> {
  const SQL = await loadSql();
  const bytes = await loadDbBytes();
  db = bytes ? new SQL.Database(bytes) : new SQL.Database();
  db.exec(`
    CREATE TABLE IF NOT EXISTS maps (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      xmlName TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS map_xml (
      id TEXT PRIMARY KEY,
      xml TEXT NOT NULL
    );
    -- Additional devices per map (multi-firewall support)
    CREATE TABLE IF NOT EXISTS map_devices (
      mapId TEXT NOT NULL,
      devId TEXT NOT NULL,
      name TEXT,
      xml TEXT NOT NULL,
      PRIMARY KEY (mapId, devId)
    );
    CREATE TABLE IF NOT EXISTS annotations2 (
      mapId TEXT NOT NULL,
      cidr TEXT NOT NULL,
      note TEXT NOT NULL,
      updatedAt INTEGER NOT NULL,
      offset REAL,
      edgeNote TEXT,
      PRIMARY KEY (mapId, cidr)
    );
    -- LAN data (normalized)
    CREATE TABLE IF NOT EXISTS lan_switches (
      id TEXT PRIMARY KEY,
      mapId TEXT NOT NULL,
      subnet TEXT NOT NULL,
      name TEXT,
      model TEXT,
      mgmtIp TEXT,
      location TEXT,
      meta TEXT,
      posX REAL,
      posY REAL
    );
    CREATE TABLE IF NOT EXISTS lan_ports (
      id TEXT PRIMARY KEY,
      switchId TEXT NOT NULL,
      name TEXT,
      idx INTEGER,
      poe INTEGER,
      speed TEXT,
      meta TEXT
    );
    CREATE TABLE IF NOT EXISTS lan_vlans (
      id TEXT PRIMARY KEY,
      mapId TEXT NOT NULL,
      subnet TEXT NOT NULL,
      vid INTEGER,
      name TEXT,
      meta TEXT
    );
    CREATE TABLE IF NOT EXISTS lan_port_vlans (
      portId TEXT NOT NULL,
      vlanId TEXT NOT NULL,
      mode TEXT,
      untagged INTEGER,
      PRIMARY KEY (portId, vlanId)
    );
    CREATE TABLE IF NOT EXISTS lan_hosts (
      id TEXT PRIMARY KEY,
      mapId TEXT NOT NULL,
      subnet TEXT NOT NULL,
      ip TEXT,
      mac TEXT,
      name TEXT,
      note TEXT,
      source TEXT DEFAULT 'manual',
      kind TEXT,
      posX REAL,
      posY REAL
    );
    CREATE TABLE IF NOT EXISTS lan_bindings (
      hostId TEXT NOT NULL,
      portId TEXT NOT NULL,
      PRIMARY KEY (hostId, portId)
    );
    CREATE TABLE IF NOT EXISTS lan_notes (
      mapId TEXT NOT NULL,
      subnet TEXT NOT NULL,
      scope TEXT NOT NULL,
      scopeId TEXT,
      text TEXT,
      PRIMARY KEY (mapId, subnet, scope, scopeId)
    );
    -- Locations metadata (per map)
    CREATE TABLE IF NOT EXISTS lan_locations (
      id TEXT PRIMARY KEY,
      mapId TEXT NOT NULL,
      name TEXT NOT NULL,
      address TEXT,
      notes TEXT,
      UNIQUE (mapId, name)
    );
  `);
  try { db.exec('ALTER TABLE annotations2 ADD COLUMN offset REAL'); } catch {}
  try { db.exec('ALTER TABLE annotations2 ADD COLUMN edgeNote TEXT'); } catch {}
  await persist();
}

export function getDb(): Database {
  if (!db) throw new Error('DB not initialized. Call initDb() first.');
  return db;
}

export async function listMaps(): Promise<MapRow[]> {
  const db = getDb();
  const res = db.exec('SELECT id, name, xmlName, createdAt, updatedAt FROM maps ORDER BY updatedAt DESC');
  const out: MapRow[] = [];
  if (res && res[0]) {
    for (const row of res[0].values) {
      const [id, name, xmlName, createdAt, updatedAt] = row as any[];
      out.push({ id, name, xmlName, createdAt, updatedAt });
    }
  }
  return out;
}

export async function createMap(name: string, xmlName: string | undefined, xmlText: string): Promise<string> {
  const db = getDb();
  const id = uuid();
  const now = Date.now();
  let stmt = db.prepare('INSERT INTO maps (id, name, xmlName, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)');
  stmt.run([id, name, xmlName || null, now, now]);
  stmt.free();
  stmt = db.prepare('INSERT INTO map_xml (id, xml) VALUES (?, ?)');
  stmt.run([id, xmlText]);
  stmt.free();
  // also store as first device record for consistency
  const devId = uuid();
  stmt = db.prepare('INSERT INTO map_devices (mapId, devId, name, xml) VALUES (?, ?, ?, ?)');
  stmt.run([id, devId, xmlName || name, xmlText]);
  stmt.free();
  await persist();
  return id;
}

export async function getMapXmlText(id: string): Promise<{ xmlText: string, name: string, xmlName?: string } | null> {
  const db = getDb();
  let stmt = db.prepare('SELECT name, xmlName FROM maps WHERE id = ?');
  stmt.bind([id]);
  if (!stmt.step()) { stmt.free(); return null; }
  const row1 = stmt.get();
  stmt.free();
  const name = row1[0] as string;
  const xmlName = row1[1] as string | undefined;
  stmt = db.prepare('SELECT xml FROM map_xml WHERE id = ?');
  stmt.bind([id]);
  if (!stmt.step()) { stmt.free(); return null; }
  const row2 = stmt.get();
  stmt.free();
  const xmlText = row2[0] as string;
  return { xmlText, name, xmlName };
}

export async function touchMap(id: string): Promise<void> {
  const db = getDb();
  const stmt = db.prepare('UPDATE maps SET updatedAt = ? WHERE id = ?');
  stmt.run([Date.now(), id]);
  stmt.free();
  await persist();
}

export async function updateMapName(id: string, name: string): Promise<void> {
  const db = getDb();
  const stmt = db.prepare('UPDATE maps SET name = ?, updatedAt = ? WHERE id = ?');
  stmt.run([name, Date.now(), id]);
  stmt.free();
  await persist();
}

export async function saveMapXml(id: string, xmlText: string): Promise<void> {
  const db = getDb();
  const stmt = db.prepare('INSERT INTO map_xml (id, xml) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET xml = excluded.xml');
  stmt.run([id, xmlText]);
  stmt.free();
  await touchMap(id);
}

export async function addMapDevice(mapId: string, name: string | undefined, xmlText: string): Promise<string> {
  const db = getDb();
  const devId = uuid();
  const stmt = db.prepare('INSERT INTO map_devices (mapId, devId, name, xml) VALUES (?, ?, ?, ?)');
  stmt.run([mapId, devId, name || null, xmlText]);
  stmt.free();
  await touchMap(mapId);
  return devId;
}

export async function listMapDevices(mapId: string): Promise<Array<{ devId: string; name?: string; xml: string }>> {
  const db = getDb();
  const out: Array<{ devId: string; name?: string; xml: string }> = [];
  const stmt = db.prepare('SELECT devId, name, xml FROM map_devices WHERE mapId = ?');
  stmt.bind([mapId]);
  while (stmt.step()) {
    const row = stmt.get();
    out.push({ devId: row[0] as string, name: row[1] as string | undefined, xml: row[2] as string });
  }
  stmt.free();
  return out;
}

export async function getMapAllXmlTexts(mapId: string): Promise<Array<{ name?: string; xmlText: string }>> {
  const db = getDb();
  const out: Array<{ name?: string; xmlText: string }> = [];
  // primary
  try {
    const stmt1 = db.prepare('SELECT xml FROM map_xml WHERE id = ?');
    stmt1.bind([mapId]);
    if (stmt1.step()) {
      out.push({ xmlText: stmt1.get()[0] as string });
    }
    stmt1.free();
  } catch {}
  // devices
  const devs = await listMapDevices(mapId);
  devs.forEach(d => out.push({ name: d.name, xmlText: d.xml }));
  return out;
}

export async function getAnnotationMapFor(mapId: string): Promise<Map<string, string>> {
  const db = getDb();
  const map = new Map<string, string>();
  const stmt = db.prepare('SELECT cidr, note FROM annotations2 WHERE mapId = ?');
  stmt.bind([mapId]);
  while (stmt.step()) {
    const row = stmt.get();
    const [cidr, note] = row as any[];
    if (typeof cidr === 'string' && typeof note === 'string') map.set(cidr, note);
  }
  stmt.free();
  return map;
}

export async function setAnnotationFor(mapId: string, cidr: string, note: string, offset?: number): Promise<void> {
  const db = getDb();
  const stmt = db.prepare('INSERT INTO annotations2 (mapId, cidr, note, updatedAt, offset) VALUES (?, ?, ?, ?, ?) ON CONFLICT(mapId, cidr) DO UPDATE SET note=excluded.note, updatedAt=excluded.updatedAt, offset=COALESCE(excluded.offset, annotations2.offset)');
  stmt.run([mapId, cidr, note, Date.now(), typeof offset === 'number' ? offset : null]);
  stmt.free();
  await persist();
}

export async function getAnnotationOffsetsFor(mapId: string): Promise<Map<string, number>> {
  const db = getDb();
  const map = new Map<string, number>();
  const stmt = db.prepare('SELECT cidr, offset FROM annotations2 WHERE mapId = ? AND offset IS NOT NULL');
  stmt.bind([mapId]);
  while (stmt.step()) {
    const row = stmt.get();
    const [cidr, offset] = row as any[];
    if (typeof cidr === 'string' && typeof offset === 'number') map.set(cidr, offset);
  }
  stmt.free();
  return map;
}

export async function setAnnotationOffsetFor(mapId: string, cidr: string, offset: number): Promise<void> {
  const db = getDb();
  const stmt = db.prepare('INSERT INTO annotations2 (mapId, cidr, note, updatedAt, offset) VALUES (?, ?, COALESCE((SELECT note FROM annotations2 WHERE mapId = ? AND cidr = ?), ""), ?, ?) ON CONFLICT(mapId, cidr) DO UPDATE SET offset = excluded.offset, updatedAt = excluded.updatedAt');
  const now = Date.now();
  stmt.run([mapId, cidr, mapId, cidr, now, offset]);
  stmt.free();
  await persist();
}

export async function getEdgeNotesFor(mapId: string): Promise<Map<string, string>> {
  const db = getDb();
  const map = new Map<string, string>();
  const stmt = db.prepare('SELECT cidr, edgeNote FROM annotations2 WHERE mapId = ? AND edgeNote IS NOT NULL');
  stmt.bind([mapId]);
  while (stmt.step()) {
    const row = stmt.get();
    const [cidr, edgeNote] = row as any[];
    if (typeof cidr === 'string' && typeof edgeNote === 'string') map.set(cidr, edgeNote);
  }
  stmt.free();
  return map;
}

export async function setEdgeNoteFor(mapId: string, cidr: string, edgeNote: string): Promise<void> {
  const db = getDb();
  const stmt = db.prepare('INSERT INTO annotations2 (mapId, cidr, note, updatedAt, edgeNote) VALUES (?, ?, COALESCE((SELECT note FROM annotations2 WHERE mapId = ? AND cidr = ?), ""), ?, ?) ON CONFLICT(mapId, cidr) DO UPDATE SET edgeNote = excluded.edgeNote, updatedAt = excluded.updatedAt');
  const now = Date.now();
  stmt.run([mapId, cidr, mapId, cidr, now, edgeNote]);
  stmt.free();
  await persist();
}

// Rename the first (primary) device row for a map
export async function renameFirstDeviceForMap(mapId: string, name: string): Promise<void> {
  const db = getDb();
  // Use the earliest inserted row (rowid) for this map as primary device
  const stmt = db.prepare('UPDATE map_devices SET name = ? WHERE rowid = (SELECT rowid FROM map_devices WHERE mapId = ? ORDER BY rowid ASC LIMIT 1)');
  stmt.run([name, mapId]);
  stmt.free();
  await touchMap(mapId);
}

// Delete a saved map and all associated data
export async function deleteMap(id: string): Promise<void> {
  const db = getDb();
  try {
    // Purge LAN data first
    let stmt = db.prepare('DELETE FROM lan_notes WHERE mapId = ?');
    stmt.run([id]);
    stmt.free();
    stmt = db.prepare('DELETE FROM lan_bindings WHERE hostId IN (SELECT id FROM lan_hosts WHERE mapId = ?)');
    stmt.run([id]);
    stmt.free();
    stmt = db.prepare('DELETE FROM lan_port_vlans WHERE portId IN (SELECT id FROM lan_ports WHERE switchId IN (SELECT id FROM lan_switches WHERE mapId = ?))');
    stmt.run([id]);
    stmt.free();
    stmt = db.prepare('DELETE FROM lan_ports WHERE switchId IN (SELECT id FROM lan_switches WHERE mapId = ?)');
    stmt.run([id]);
    stmt.free();
    stmt = db.prepare('DELETE FROM lan_switches WHERE mapId = ?');
    stmt.run([id]);
    stmt.free();
    stmt = db.prepare('DELETE FROM lan_vlans WHERE mapId = ?');
    stmt.run([id]);
    stmt.free();
    stmt = db.prepare('DELETE FROM lan_hosts WHERE mapId = ?');
    stmt.run([id]);
    stmt.free();

    // Then annotations and map records
    stmt = db.prepare('DELETE FROM annotations2 WHERE mapId = ?');
    stmt.run([id]);
    stmt.free();

    stmt = db.prepare('DELETE FROM map_devices WHERE mapId = ?');
    stmt.run([id]);
    stmt.free();

    stmt = db.prepare('DELETE FROM map_xml WHERE id = ?');
    stmt.run([id]);
    stmt.free();

    stmt = db.prepare('DELETE FROM maps WHERE id = ?');
    stmt.run([id]);
    stmt.free();
  } finally {
    await persist();
  }
}

// ---------------- LAN: switches ----------------
export type LanSwitch = { id: string; mapId: string; subnet: string; name?: string; model?: string; mgmtIp?: string; location?: string; meta?: string; posX?: number; posY?: number };
export async function listLanSwitches(mapId: string, subnet: string): Promise<LanSwitch[]> {
  const db = getDb();
  const out: LanSwitch[] = [];
  const stmt = db.prepare('SELECT id, mapId, subnet, name, model, mgmtIp, location, meta, posX, posY FROM lan_switches WHERE mapId = ? AND subnet = ? ORDER BY name');
  stmt.bind([mapId, subnet]);
  while (stmt.step()) {
    const r = stmt.get();
    out.push({ id: r[0] as string, mapId: r[1] as string, subnet: r[2] as string, name: r[3] as string | undefined, model: r[4] as string | undefined, mgmtIp: r[5] as string | undefined, location: r[6] as string | undefined, meta: r[7] as string | undefined, posX: r[8] as number | undefined, posY: r[9] as number | undefined });
  }
  stmt.free();
  return out;
}
export async function upsertLanSwitch(partial: Partial<LanSwitch> & { mapId: string; subnet: string }): Promise<string> {
  const db = getDb();
  const id = partial.id || (uuid());
  const stmt = db.prepare('INSERT INTO lan_switches (id, mapId, subnet, name, model, mgmtIp, location, meta, posX, posY) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, model=excluded.model, mgmtIp=excluded.mgmtIp, location=excluded.location, meta=excluded.meta, posX=excluded.posX, posY=excluded.posY');
  stmt.run([id, partial.mapId, partial.subnet, partial.name || null, partial.model || null, partial.mgmtIp || null, partial.location || null, partial.meta || null, partial.posX ?? null, partial.posY ?? null]);
  stmt.free();
  await touchMap(partial.mapId);
  return id;
}
export async function deleteLanSwitch(mapId: string, switchId: string): Promise<void> {
  const db = getDb();
  let stmt = db.prepare('DELETE FROM lan_port_vlans WHERE portId IN (SELECT id FROM lan_ports WHERE switchId = ?)');
  stmt.run([switchId]); stmt.free();
  stmt = db.prepare('DELETE FROM lan_bindings WHERE portId IN (SELECT id FROM lan_ports WHERE switchId = ?)');
  stmt.run([switchId]); stmt.free();
  stmt = db.prepare('DELETE FROM lan_ports WHERE switchId = ?');
  stmt.run([switchId]); stmt.free();
  stmt = db.prepare('DELETE FROM lan_switches WHERE id = ?');
  stmt.run([switchId]); stmt.free();
  await touchMap(mapId);
}

// ---------------- LAN: ports ----------------
export type LanPort = { id: string; switchId: string; name?: string; idx?: number; poe?: boolean; speed?: string; meta?: string };
export async function listLanPorts(switchId: string): Promise<LanPort[]> {
  const db = getDb();
  const out: LanPort[] = [];
  const stmt = db.prepare('SELECT id, switchId, name, idx, poe, speed, meta FROM lan_ports WHERE switchId = ? ORDER BY COALESCE(idx, 0), name');
  stmt.bind([switchId]);
  while (stmt.step()) { const r = stmt.get(); out.push({ id: r[0] as string, switchId: r[1] as string, name: r[2] as string | undefined, idx: r[3] as number | undefined, poe: !!r[4], speed: r[5] as string | undefined, meta: r[6] as string | undefined }); }
  stmt.free();
  return out;
}
export async function upsertLanPort(partial: Partial<LanPort> & { switchId: string }): Promise<string> {
  const db = getDb();
  const id = partial.id || (uuid());
  const stmt = db.prepare('INSERT INTO lan_ports (id, switchId, name, idx, poe, speed, meta) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, idx=excluded.idx, poe=excluded.poe, speed=excluded.speed, meta=excluded.meta');
  stmt.run([id, partial.switchId, partial.name || null, partial.idx ?? null, partial.poe ? 1 : 0, partial.speed || null, partial.meta || null]);
  stmt.free();
  return id;
}
export async function deleteLanPort(portId: string): Promise<void> {
  const db = getDb();
  let stmt = db.prepare('DELETE FROM lan_port_vlans WHERE portId = ?');
  stmt.run([portId]); stmt.free();
  stmt = db.prepare('DELETE FROM lan_bindings WHERE portId = ?');
  stmt.run([portId]); stmt.free();
  stmt = db.prepare('DELETE FROM lan_ports WHERE id = ?');
  stmt.run([portId]); stmt.free();
}

// ---------------- LAN: VLANs ----------------
export type LanVlan = { id: string; mapId: string; subnet: string; vid?: number; name?: string; meta?: string };
export async function listLanVlans(mapId: string, subnet: string): Promise<LanVlan[]> {
  const db = getDb();
  const out: LanVlan[] = [];
  const stmt = db.prepare('SELECT id, mapId, subnet, vid, name, meta FROM lan_vlans WHERE mapId = ? AND subnet = ? ORDER BY vid');
  stmt.bind([mapId, subnet]);
  while (stmt.step()) { const r = stmt.get(); out.push({ id: r[0] as string, mapId: r[1] as string, subnet: r[2] as string, vid: r[3] as number | undefined, name: r[4] as string | undefined, meta: r[5] as string | undefined }); }
  stmt.free();
  return out;
}
export async function upsertLanVlan(partial: Partial<LanVlan> & { mapId: string; subnet: string }): Promise<string> {
  const db = getDb();
  const id = partial.id || (uuid());
  const stmt = db.prepare('INSERT INTO lan_vlans (id, mapId, subnet, vid, name, meta) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET vid=excluded.vid, name=excluded.name, meta=excluded.meta');
  stmt.run([id, partial.mapId, partial.subnet, partial.vid ?? null, partial.name || null, partial.meta || null]);
  stmt.free();
  await touchMap(partial.mapId);
  return id;
}
export async function deleteLanVlan(mapId: string, vlanId: string): Promise<void> {
  const db = getDb();
  let stmt = db.prepare('DELETE FROM lan_port_vlans WHERE vlanId = ?');
  stmt.run([vlanId]); stmt.free();
  stmt = db.prepare('DELETE FROM lan_vlans WHERE id = ?');
  stmt.run([vlanId]); stmt.free();
  await touchMap(mapId);
}
export type LanPortVlan = { portId: string; vlanId: string; mode?: string; untagged?: boolean };
export async function setPortVlanBinding(portId: string, vlanId: string, mode?: 'access'|'trunk'|'native', untagged?: boolean): Promise<void> {
  const db = getDb();
  const stmt = db.prepare('INSERT INTO lan_port_vlans (portId, vlanId, mode, untagged) VALUES (?, ?, ?, ?) ON CONFLICT(portId, vlanId) DO UPDATE SET mode=excluded.mode, untagged=excluded.untagged');
  stmt.run([portId, vlanId, mode || null, untagged ? 1 : 0]);
  stmt.free();
}
export async function clearPortVlanBinding(portId: string, vlanId: string): Promise<void> {
  const db = getDb();
  const stmt = db.prepare('DELETE FROM lan_port_vlans WHERE portId = ? AND vlanId = ?');
  stmt.run([portId, vlanId]); stmt.free();
}
export async function getPortVlans(portId: string): Promise<LanPortVlan[]> {
  const db = getDb();
  const out: LanPortVlan[] = [];
  const stmt = db.prepare('SELECT portId, vlanId, mode, untagged FROM lan_port_vlans WHERE portId = ?');
  stmt.bind([portId]);
  while (stmt.step()) { const r = stmt.get(); out.push({ portId: r[0] as string, vlanId: r[1] as string, mode: r[2] as string | undefined, untagged: !!r[3] }); }
  stmt.free();
  return out;
}

// ---------------- LAN: hosts ----------------
export type LanHost = { id: string; mapId: string; subnet: string; ip?: string; mac?: string; name?: string; note?: string; source?: string; kind?: string; posX?: number; posY?: number };
export async function listLanHosts(mapId: string, subnet: string): Promise<LanHost[]> {
  const db = getDb();
  const out: LanHost[] = [];
  const stmt = db.prepare('SELECT id, mapId, subnet, ip, mac, name, note, source, kind, posX, posY FROM lan_hosts WHERE mapId = ? AND subnet = ? ORDER BY ip');
  stmt.bind([mapId, subnet]);
  while (stmt.step()) { const r = stmt.get(); out.push({ id: r[0] as string, mapId: r[1] as string, subnet: r[2] as string, ip: r[3] as string | undefined, mac: r[4] as string | undefined, name: r[5] as string | undefined, note: r[6] as string | undefined, source: r[7] as string | undefined, kind: r[8] as string | undefined, posX: r[9] as number | undefined, posY: r[10] as number | undefined }); }
  stmt.free();
  return out;
}
export async function upsertLanHost(partial: Partial<LanHost> & { mapId: string; subnet: string }): Promise<string> {
  const db = getDb();
  const id = partial.id || (uuid());
  const stmt = db.prepare('INSERT INTO lan_hosts (id, mapId, subnet, ip, mac, name, note, source, kind, posX, posY) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET ip=excluded.ip, mac=excluded.mac, name=excluded.name, note=excluded.note, source=excluded.source, kind=excluded.kind, posX=excluded.posX, posY=excluded.posY');
  stmt.run([id, partial.mapId, partial.subnet, partial.ip || null, partial.mac || null, partial.name || null, partial.note || null, partial.source || 'manual', partial.kind || null, partial.posX ?? null, partial.posY ?? null]);
  stmt.free();
  await touchMap(partial.mapId);
  return id;
}
export async function deleteLanHost(mapId: string, hostId: string): Promise<void> {
  const db = getDb();
  let stmt = db.prepare('DELETE FROM lan_bindings WHERE hostId = ?');
  stmt.run([hostId]); stmt.free();
  stmt = db.prepare('DELETE FROM lan_notes WHERE scope = "host" AND scopeId = ?');
  stmt.run([hostId]); stmt.free();
  stmt = db.prepare('DELETE FROM lan_hosts WHERE id = ?');
  stmt.run([hostId]); stmt.free();
  await touchMap(mapId);
}
export type LanBinding = { hostId: string; portId: string };
export async function bindHostToPort(hostId: string, portId: string): Promise<void> {
  const db = getDb();
  const stmt = db.prepare('INSERT OR IGNORE INTO lan_bindings (hostId, portId) VALUES (?, ?)');
  stmt.run([hostId, portId]); stmt.free();
}
export async function unbindHostFromPort(hostId: string, portId: string): Promise<void> {
  const db = getDb();
  const stmt = db.prepare('DELETE FROM lan_bindings WHERE hostId = ? AND portId = ?');
  stmt.run([hostId, portId]); stmt.free();
}

// ---------------- LAN: notes ----------------
export async function setLanNote(mapId: string, subnet: string, scope: 'lan'|'switch'|'port'|'host', scopeId: string | null, text: string): Promise<void> {
  const db = getDb();
  const stmt = db.prepare('INSERT INTO lan_notes (mapId, subnet, scope, scopeId, text) VALUES (?, ?, ?, ?, ?) ON CONFLICT(mapId, subnet, scope, scopeId) DO UPDATE SET text=excluded.text');
  stmt.run([mapId, subnet, scope, scopeId, text]);
  stmt.free();
  await touchMap(mapId);
}
export async function getLanNotes(mapId: string, subnet: string): Promise<Map<string, string>> {
  const db = getDb();
  const out = new Map<string, string>();
  const stmt = db.prepare('SELECT scope || ":" || COALESCE(scopeId, "") AS k, text FROM lan_notes WHERE mapId = ? AND subnet = ?');
  stmt.bind([mapId, subnet]);
  while (stmt.step()) { const r = stmt.get(); out.set(r[0] as string, r[1] as string); }
  stmt.free();
  return out;
}

// Helper: list manual host IPs for union with parsed hosts
export async function listManualHostIps(mapId: string, subnet: string): Promise<string[]> {
  const db = getDb();
  const ips: string[] = [];
  const stmt = db.prepare('SELECT ip FROM lan_hosts WHERE mapId = ? AND subnet = ? AND ip IS NOT NULL AND ip <> ""');
  stmt.bind([mapId, subnet]);
  while (stmt.step()) { const r = stmt.get(); ips.push(r[0] as string); }
  stmt.free();
  return ips;
}

// Schema migrations (safe, idempotent)
try { getDb(); } catch {}
try { db && db.exec('ALTER TABLE lan_hosts ADD COLUMN kind TEXT'); } catch {}

// ---------------- Locations ----------------
export type LanLocation = { id: string; mapId: string; name: string; address?: string; notes?: string };
export async function upsertLanLocation(mapId: string, name: string, address?: string, notes?: string, id?: string): Promise<string> {
  const db = getDb();
  const locId = id || uuid();
  const stmt = db.prepare('INSERT INTO lan_locations (id, mapId, name, address, notes) VALUES (?, ?, ?, ?, ?) ON CONFLICT(mapId, name) DO UPDATE SET address=excluded.address, notes=excluded.notes');
  stmt.run([locId, mapId, name, address || null, notes || null]);
  stmt.free();
  await touchMap(mapId);
  return locId;
}
export async function listLanLocations(mapId: string): Promise<LanLocation[]> {
  const db = getDb();
  const out: LanLocation[] = [];
  const stmt = db.prepare('SELECT id, mapId, name, address, notes FROM lan_locations WHERE mapId = ? ORDER BY name');
  stmt.bind([mapId]);
  while (stmt.step()) { const r = stmt.get(); out.push({ id: r[0] as string, mapId: r[1] as string, name: r[2] as string, address: r[3] as string | undefined, notes: r[4] as string | undefined }); }
  stmt.free();
  return out;
}
export async function getLanLocationByName(mapId: string, name: string): Promise<LanLocation | null> {
  const db = getDb();
  const stmt = db.prepare('SELECT id, mapId, name, address, notes FROM lan_locations WHERE mapId = ? AND name = ?');
  stmt.bind([mapId, name]);
  if (!stmt.step()) { stmt.free(); return null; }
  const r = stmt.get(); stmt.free();
  return { id: r[0] as string, mapId: r[1] as string, name: r[2] as string, address: r[3] as string | undefined, notes: r[4] as string | undefined };
}
export async function setSwitchLocation(mapId: string, switchId: string, locationName: string | null): Promise<void> {
  const db = getDb();
  const stmt = db.prepare('UPDATE lan_switches SET location = ? WHERE id = ?');
  stmt.run([locationName || null, switchId]);
  stmt.free();
  await touchMap(mapId);
}
