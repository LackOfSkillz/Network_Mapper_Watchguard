import * as XLSX from 'xlsx'

export type UPolicy = {
  name: string
  enabled: boolean
  from: string[]
  to: string[]
  services: string[]
  tags?: string[]
  source: 'xml' | 'xls' | 'xml+xls'
}

const splitList = (s?: string) =>
  (s || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean)

const truthy = (v?: string) => /^true|1|yes$/i.test((v || '').trim())

export async function parsePoliciesXls(file: File): Promise<UPolicy[]> {
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array' })
  const sh = wb.Sheets[wb.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json<Record<string, any>>(sh, { defval: '' })

  const get = (r: Record<string, any>, ...names: string[]) => {
    const key = Object.keys(r).find(k => names.map(n => n.toLowerCase()).includes(k.trim().toLowerCase()))
    return key ? String(r[key]).trim() : ''
  }

  const out: UPolicy[] = []
  for (const r of rows) {
    const name = get(r, 'Policy Name', 'Name')
    if (!name) continue
    const from = splitList(get(r, 'From', 'Source', 'Src'))
    const to = splitList(get(r, 'To', 'Destination', 'Dst'))
    const services = splitList(get(r, 'Services', 'Service', 'Dst Port', 'Port'))
    const tags = splitList(get(r, 'Tags'))
    const enabled = get(r, 'Enabled') === '' ? true : truthy(get(r, 'Enabled'))

    out.push({ name, enabled, from, to, services: services.length ? services : ['Any'], tags, source: 'xls' })
  }
  return out
}
