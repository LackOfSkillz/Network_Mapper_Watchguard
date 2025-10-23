// Quick Excel parser dry-run: detects common columns and prints a summary.
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
    if (netStr || (isIp(ip) && mask)) { sheetSum.detected.subnets++; marked = true; summary.totals.subnets++; }
    if (vlanId) { sheetSum.detected.vlans++; summary.totals.vlans++; marked = true; }
    if (isIp(ip) || host || mac) { sheetSum.detected.hosts++; summary.totals.hosts++; marked = true; }
    if (swName || model || mgmt) { sheetSum.detected.switches++; summary.totals.switches++; marked = true; }
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
