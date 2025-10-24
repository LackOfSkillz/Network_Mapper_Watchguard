import * as XLSX from 'xlsx';

export type CandidateHost = { key?: string; ip?: string; mac?: string; name?: string; sheet: string; row: number };
export type CandidateVlan = { key: string; vid?: number; name?: string; sheet: string; row: number };
export type CandidateSwitch = { key: string; name?: string; model?: string; mgmt?: string; sheet: string; row: number };
export type CandidateSubnet = { key: string; cidr: string; sheet: string; row: number };

export type ParsedCandidates = {
  hosts: CandidateHost[];
  vlans: CandidateVlan[];
  switches: CandidateSwitch[];
  subnets: CandidateSubnet[];
};

export function isIp(v: any): v is string {
  if (typeof v !== 'string') return false;
  const m = v.trim().match(/^\d{1,3}(?:\.\d{1,3}){3}$/);
  if (!m) return false;
  return v.split('.').every(o => Number(o) >= 0 && Number(o) <= 255);
}
export function normText(s?: string | number | null): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
export function normMac(s?: string | number | null): string | undefined {
  const v = String(s ?? '').replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  return v || undefined;
}
function countOnes(byte: number){ let b = byte & 0xff, n = 0; while (b){ n += b & 1; b >>= 1; } return n; }
function parseMaskToPrefix(mask: any): number | undefined {
  if (!mask) return undefined;
  const m = String(mask).trim();
  if (/^\d{1,2}$/.test(m)) { const n = Number(m); if (n>=0 && n<=32) return n; }
  if (/^\/(\d{1,2})$/.test(m)) { const n = Number(m.slice(1)); if (n>=0 && n<=32) return n; }
  const parts = m.split('.').map(x => Number(x));
  if (parts.length === 4 && parts.every(x => Number.isInteger(x) && x >= 0 && x <= 255)) {
    let bits = 0; for (const p of parts) bits += countOnes(p); return bits;
  }
  return undefined;
}
function ipToOctets(ip: string){ return ip.split('.').map(x=>Number(x)); }
function octetsToIp(oc: number[]){ return oc.join('.'); }
function bitsToByte(bits: number[]){ return bits.reduce((acc,b)=> (acc<<1)|b, 0) & 0xff; }
function computeNetworkCidr(ip: string, mask: any): string | undefined {
  if (!isIp(ip)) return undefined;
  const prefix = parseMaskToPrefix(mask);
  if (prefix == null) return undefined;
  const ipOc = ipToOctets(ip);
  const maskBits = new Array(32).fill(0).map((_,i)=> i < prefix ? 1 : 0);
  const maskOct = [0,1,2,3].map(k => bitsToByte(maskBits.slice(8*k, 8*k+8)));
  const netOc = [0,1,2,3].map(i => (ipOc[i] & maskOct[i]) >>> 0);
  return `${octetsToIp(netOc)}/${prefix}`;
}

const headerSynonyms = {
  ip: /\b(ip|ip address|address|ipv4)\b/i,
  mac: /\b(mac|mac address)\b/i,
  hostname: /\b(host|hostname|name|device name)\b/i,
  vlanId: /\b(vlan|vid|vlan id)\b/i,
  vlanName: /\b(vlan name|vlan description|name)\b/i,
  subnet: /\b(cidr|subnet|network|net)\b/i,
  netmask: /\b(mask|netmask|subnet mask)\b/i,
  switchName: /\b(switch|switch name|device|chassis|host)\b/i,
  mgmtIp: /\b(mgmt ip|management ip|switch ip|ip address)\b/i,
  port: /\b(port|interface|gi\d+\/|ge\d+\/|fa\d+\/)\b/i,
  model: /\b(model|device model|part number)\b/i,
};

export async function parseExcelToCandidates(buf: ArrayBuffer): Promise<ParsedCandidates> {
  const wb = XLSX.read(buf, { type: 'array' });
  const hosts: CandidateHost[] = [];
  const vlans: CandidateVlan[] = [];
  const switches: CandidateSwitch[] = [];
  const subnets: CandidateSubnet[] = [];

  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    if (!rows.length) continue;
    const rawHeaders = rows[0].map((h:any)=> String(h||''));
    const headers = rawHeaders.map(h => normText(h));

    // Map out column indexes
    const idx = {
      ip: headers.findIndex(h => headerSynonyms.ip.test(h)),
      mac: headers.findIndex(h => headerSynonyms.mac.test(h)),
      host: headers.findIndex(h => headerSynonyms.hostname.test(h)),
      vid: headers.findIndex(h => headerSynonyms.vlanId.test(h)),
      vname: headers.findIndex(h => headerSynonyms.vlanName.test(h)),
      cidr: headers.findIndex(h => headerSynonyms.subnet.test(h)),
      mask: headers.findIndex(h => headerSynonyms.netmask.test(h)),
      sw: headers.findIndex(h => headerSynonyms.switchName.test(h)),
      mgmt: headers.findIndex(h => headerSynonyms.mgmtIp.test(h)),
      model: headers.findIndex(h => headerSynonyms.model.test(h)),
    } as const;

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const ip = idx.ip >= 0 ? row[idx.ip] : '';
      const mac = idx.mac >= 0 ? row[idx.mac] : '';
      const host = idx.host >= 0 ? row[idx.host] : '';
      const vid = idx.vid >= 0 ? row[idx.vid] : '';
      const vname = idx.vname >= 0 ? row[idx.vname] : '';
      const cidr = idx.cidr >= 0 ? row[idx.cidr] : '';
      const mask = idx.mask >= 0 ? row[idx.mask] : '';
      const sw = idx.sw >= 0 ? row[idx.sw] : '';
      const mgmt = idx.mgmt >= 0 ? row[idx.mgmt] : '';
      const model = idx.model >= 0 ? row[idx.model] : '';

      // Subnet
      let net = String(cidr || '').trim();
      if (!net && isIp(ip) && mask) net = computeNetworkCidr(String(ip), mask) || '';
      if (net && /\d+\.\d+\.\d+\.\d+\/\d+/.test(net)) {
        subnets.push({ key: net, cidr: net, sheet: name, row: r+1 });
      }

      // VLAN
      const vidNum = String(vid || '').trim();
      const vnameStr = String(vname || '').trim();
      if (vidNum || vnameStr) {
        const key = vidNum ? `vid:${vidNum}` : `vname:${normText(vnameStr)}`;
        vlans.push({ key, vid: vidNum ? Number(vidNum) : undefined, name: vnameStr || undefined, sheet: name, row: r+1 });
      }

      // Host
      const ipStr = String(ip || '').trim();
      const macN = normMac(mac);
      const hostStr = String(host || '').trim();
      if (isIp(ipStr) || macN || hostStr) {
        const key = macN ? `mac:${macN}` : (isIp(ipStr) ? `ip:${ipStr}` : `host:${normText(hostStr)}`);
        hosts.push({ key, ip: isIp(ipStr) ? ipStr : undefined, mac: macN, name: hostStr || undefined, sheet: name, row: r+1 });
      }

      // Switch
      const nameStr = String(sw || '').trim();
      const mgmtIp = isIp(String(mgmt)) ? String(mgmt) : undefined;
      const modelStr = String(model || '').trim();
      if (nameStr || mgmtIp || modelStr) {
        const sKey = mgmtIp ? `mgmt:${mgmtIp}` : `name:${normText(nameStr)}|model:${normText(modelStr)}`;
        switches.push({ key: sKey, name: nameStr || undefined, model: modelStr || undefined, mgmt: mgmtIp, sheet: name, row: r+1 });
      }
    }
  }

  return { hosts, vlans, switches, subnets };
}

export type Classification = {
  new: number; merge: number; conflict: number; total: number;
};

export function dedupeCounts<T extends { key?: string }>(items: T[]): { total: number; unique: number; removed: number } {
  const byKey = new Map<string, number>();
  let total = 0;
  for (const it of items) { if (!it.key) continue; total++; byKey.set(it.key, (byKey.get(it.key)||0)+1); }
  return { total, unique: byKey.size, removed: total - byKey.size };
}
