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
    let stmt = db.prepare('DELETE FROM annotations2 WHERE mapId = ?');
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
