// Excel import dry-run: detects common columns, prints raw counts, and a deduped summary.
// Usage: node scripts/import_excel.mjs <path-to-xlsx>
import fs from 'node:fs';
import path from 'node:path';
import xlsx from 'xlsx';

function isIp(v) {
  if (typeof v !== 'string') return false;
  const m = v.trim().match(/^\d{1,3}(?:\.\d{1,3}){3}$/);
  if (!m) return false;
  return v.split('.').every(o => Number(o) >= 0 && Number(o) <= 255);
}
function toKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function normMac(s) {
  const v = String(s || '').replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  return v || undefined;
}
function parseMaskToPrefix(mask) {
  if (!mask) return undefined;
  const m = String(mask).trim();
  if (/^\d{1,2}$/.test(m)) {
    const n = Number(m);
    if (n >= 0 && n <= 32) return n;
  }
  if (/^\/(\d{1,2})$/.test(m)) {
    const n = Number(m.slice(1));
    if (n >= 0 && n <= 32) return n;
  }
  const parts = m.split('.').map(x => Number(x));
  if (parts.length === 4 && parts.every(x => Number.isInteger(x) && x >= 0 && x <= 255)) {
    let bits = 0;
    for (const p of parts) bits += countOnes(p);
    return bits;
  }
  return undefined;
}
function countOnes(byte) {
  let b = byte & 0xff, n = 0;
  while (b) { n += b & 1; b >>= 1; }
  return n;
}
function ipToOctets(ip) { return ip.split('.').map(x => Number(x)); }
function octetsToIp(oc) { return oc.join('.'); }
function computeNetworkCidr(ip, mask) {
  // ip: a.b.c.d, mask: dotted or prefix
  if (!isIp(ip)) return undefined;
  const prefix = parseMaskToPrefix(mask);
  if (prefix == null) return undefined;
  const ipOc = ipToOctets(ip);
  // Build mask from prefix
  const maskBits = new Array(32).fill(0).map((_,i)=> i < prefix ? 1 : 0);
  const maskOct = [0,1,2,3].map(k => bitsToByte(maskBits.slice(8*k, 8*k+8)));
  const netOc = [0,1,2,3].map(i => (ipOc[i] & maskOct[i]) >>> 0);
  return `${octetsToIp(netOc)}/${prefix}`;
}
function bitsToByte(bits) { return bits.reduce((acc,b)=> (acc<<1)|b, 0) & 0xff; }
function guessKindFromHostname(name) {
  const n = (name || '').toLowerCase();
  if (!n) return undefined;
  if (/\b(ap|wlan|wifi)\b/.test(n)) return 'ap';
  if (/\b(sw|switch)\b/.test(n)) return 'switch';
  if (/\b(cam|nvr|dvr)\b/.test(n)) return 'camera';
  if (/\b(srv|server|dc\d*)\b/.test(n)) return 'server';
  return undefined;
}

const file = process.argv[2] || 'IP Subnet Master 10.xls.xlsx';
const abs = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
if (!fs.existsSync(abs)) {
  console.error('File not found:', abs);
  process.exit(1);
}

const wb = xlsx.readFile(abs);
const summary = {
  file: abs,
  sheets: [],
  totals: { hosts: 0, subnets: 0, vlans: 0, switches: 0 }
};

// Collect candidates across sheets for dedupe
const dedupeBuckets = {
  hosts: [],    // {key, ip, mac, host, sheet, row}
  subnets: [],  // {key, cidr, ip, mask, sheet, row}
  vlans: [],    // {key, vid, name, sheet, row}
  switches: []  // {key, name, model, mgmt, sheet, row}
};

for (const name of wb.SheetNames) {
  const ws = wb.Sheets[name];
  const rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '' });
  if (!rows.length) { summary.sheets.push({ name, rows: 0 }); continue; }
  const rawHeaders = rows[0];
  const headers = rawHeaders.map(toKey);
  const idx = Object.fromEntries(headers.map((h, i) => [h, i]));

  // Detect useful columns by fuzzy matching
  const colGroups = {
    ip: headers.map((h,i)=>({h,i})).filter(x=>/\b(ip|ip address|addr)\b/.test(x.h)),
    mac: headers.map((h,i)=>({h,i})).filter(x=>/\b(mac|mac address)\b/.test(x.h)),
    hostname: headers.map((h,i)=>({h,i})).filter(x=>/\b(host|hostname|name|device name)\b/.test(x.h)),
    vlanId: headers.map((h,i)=>({h,i})).filter(x=>/\b(vlan|vid|vlan id)\b/.test(x.h)),
    vlanName: headers.map((h,i)=>({h,i})).filter(x=>/\b(vlan name)\b/.test(x.h)),
    subnet: headers.map((h,i)=>({h,i})).filter(x=>/\b(cidr|subnet|network)\b/.test(x.h)),
    netmask: headers.map((h,i)=>({h,i})).filter(x=>/\b(mask|netmask)\b/.test(x.h)),
    switchName: headers.map((h,i)=>({h,i})).filter(x=>/\b(switch|switch name|device)\b/.test(x.h)),
    mgmtIp: headers.map((h,i)=>({h,i})).filter(x=>/\b(mgmt ip|management ip|switch ip)\b/.test(x.h)),
    port: headers.map((h,i)=>({h,i})).filter(x=>/\b(port|interface|gi|ge|fa)\b/.test(x.h)),
    model: headers.map((h,i)=>({h,i})).filter(x=>/\b(model|device model)\b/.test(x.h)),
  };

  const sheetSum = { name, rows: rows.length-1, cols: Object.fromEntries(Object.entries(colGroups).map(([k,v])=>[k,v.map(x=>rawHeaders[x.i])])), detected: { hosts: 0, subnets: 0, vlans: 0, switches: 0 } };
  // Heuristic: scan rows and pick out objects
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const obj = Object.fromEntries(headers.map((h, i) => [h, row[i]]));
    const keys = headers.join(' ');
    // Detect subnet
    const netStr = obj['cidr'] || obj['subnet'] || obj['network'] || '';
    const mask = obj['mask'] || obj['netmask'] || '';
    const vlanId = obj['vlan'] || obj['vlan id'] || obj['vid'] || '';
    const vlanName = obj['vlan name'] || '';
    const ip = obj['ip'] || obj['ip address'] || obj['address'] || '';
    const mac = obj['mac'] || obj['mac address'] || '';
    const host = obj['hostname'] || obj['name'] || obj['device name'] || '';
    const swName = obj['switch'] || obj['switch name'] || obj['device'] || '';
    const model = obj['model'] || obj['device model'] || '';
    const mgmt = obj['mgmt ip'] || obj['management ip'] || obj['switch ip'] || '';
    const port = obj['port'] || obj['interface'] || '';

    let marked = false;
    // Subnet detection + collection
    let cidr = undefined;
    if (String(netStr).includes('/')) {
      cidr = String(netStr).trim();
    } else if (isIp(ip) && mask) {
      cidr = computeNetworkCidr(ip, mask);
    }
    if (cidr) {
      sheetSum.detected.subnets++; marked = true; summary.totals.subnets++;
      dedupeBuckets.subnets.push({ key: cidr, cidr, ip, mask, sheet: name, row: r+1 });
    }
    // VLANs
    if (vlanId || vlanName) {
      const vid = String(vlanId || '').trim();
      const vname = String(vlanName || '').trim();
      const vkey = vid ? `vid:${vid}` : `vname:${toKey(vname)}`;
      sheetSum.detected.vlans++; summary.totals.vlans++; marked = true;
      dedupeBuckets.vlans.push({ key: vkey, vid: vid || undefined, name: vname || undefined, sheet: name, row: r+1 });
    }
    // Hosts
    if (isIp(ip) || host || mac) {
      sheetSum.detected.hosts++; summary.totals.hosts++; marked = true;
      const macN = normMac(mac);
      const key = macN ? `mac:${macN}` : (isIp(ip) ? `ip:${ip}` : (host ? `host:${toKey(host)}` : undefined));
      if (key) dedupeBuckets.hosts.push({ key, ip: isIp(ip) ? ip : undefined, mac: macN, host: host || undefined, sheet: name, row: r+1 });
    }
    // Switches
    if (swName || model || mgmt) {
      sheetSum.detected.switches++; summary.totals.switches++; marked = true;
      const mgmtIp = isIp(mgmt) ? mgmt : undefined;
      const sKey = mgmtIp ? `mgmt:${mgmtIp}` : `name:${toKey(swName)}|model:${toKey(model)}`;
      dedupeBuckets.switches.push({ key: sKey, name: swName || undefined, model: model || undefined, mgmt: mgmtIp, sheet: name, row: r+1 });
    }
    // Not marking else; we only count detected kinds
  }
  summary.sheets.push(sheetSum);
}

console.log('Excel import dry-run summary');
console.log('File:', summary.file);
for (const s of summary.sheets) {
  console.log(`- Sheet: ${s.name} (rows: ${s.rows}) => hosts:${s.detected.hosts} subnets:${s.detected.subnets} vlans:${s.detected.vlans} switches:${s.detected.switches}`);
}
console.log('Totals => hosts:%d subnets:%d vlans:%d switches:%d', summary.totals.hosts, summary.totals.subnets, summary.totals.vlans, summary.totals.switches);

// Dedupe pass
function summarizeDedupe(items) {
  const byKey = new Map();
  for (const it of items) {
    if (!it.key) continue;
    const arr = byKey.get(it.key) || [];
    arr.push(it);
    byKey.set(it.key, arr);
  }
  const unique = byKey.size;
  const total = items.length;
  const removed = total - unique;
  // List top duplicate keys
  const dups = [...byKey.entries()].filter(([,arr]) => arr.length > 1)
    .sort((a,b) => b[1].length - a[1].length)
    .slice(0, 10)
    .map(([k, arr]) => ({ key: k, count: arr.length, samples: arr.slice(0,3).map(s=> ({ sheet: s.sheet, row: s.row })) }));
  return { total, unique, removed, duplicates: dups };
}

const hostSum = summarizeDedupe(dedupeBuckets.hosts);
const subnetSum = summarizeDedupe(dedupeBuckets.subnets);
const vlanSum = summarizeDedupe(dedupeBuckets.vlans);
const switchSum = summarizeDedupe(dedupeBuckets.switches);

console.log('\nDeduped summary (within spreadsheet)');
console.log('- Hosts   => unique:%d (from %d, removed %d duplicates)', hostSum.unique, hostSum.total, hostSum.removed);
if (hostSum.duplicates.length) {
  console.log('  Top duplicate host keys:');
  for (const d of hostSum.duplicates) console.log(`   • ${d.key} -> ${d.count} rows (e.g., ${d.samples.map(s=>s.sheet+':'+s.row).join(', ')})`);
}
console.log('- Subnets => unique:%d (from %d, removed %d duplicates)', subnetSum.unique, subnetSum.total, subnetSum.removed);
if (subnetSum.duplicates.length) {
  console.log('  Top duplicate subnet keys:');
  for (const d of subnetSum.duplicates) console.log(`   • ${d.key} -> ${d.count} rows (e.g., ${d.samples.map(s=>s.sheet+':'+s.row).join(', ')})`);
}
console.log('- VLANs   => unique:%d (from %d, removed %d duplicates)', vlanSum.unique, vlanSum.total, vlanSum.removed);
if (vlanSum.duplicates.length) {
  console.log('  Top duplicate VLAN keys:');
  for (const d of vlanSum.duplicates) console.log(`   • ${d.key} -> ${d.count} rows (e.g., ${d.samples.map(s=>s.sheet+':'+s.row).join(', ')})`);
}
console.log('- Switches=> unique:%d (from %d, removed %d duplicates)', switchSum.unique, switchSum.total, switchSum.removed);
if (switchSum.duplicates.length) {
  console.log('  Top duplicate switch keys:');
  for (const d of switchSum.duplicates) console.log(`   • ${d.key} -> ${d.count} rows (e.g., ${d.samples.map(s=>s.sheet+':'+s.row).join(', ')})`);
}
