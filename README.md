# Network Mapper for WatchGuard (Local-Only)

> Interactive, local-only network map of WatchGuard Firebox configs.  
> Built with **React + Vite + TypeScript** and **Cytoscape.js**.  
> Optional policy enrichment via **Excel** (SheetJS). No server, no cloud.

## What it does

- Parses a WatchGuard XML export (robust to alias/address-group shapes).
- Auto-draws a **hub-and-spoke map**:
  - Hub = Firebox
  - Spokes = **networks** (interface/VLAN CIDRs when present; otherwise derived /24s from policy traffic)
  - Edge labels show interface names; nodes include VLAN tag when known.
- Right panel:
  - **Hosts:** /32 IPs explicitly referenced by policies **within the selected network**.
  - **Policies:** All policies touching the selected network; click a host to filter.
  - Source badges (XML / XLS) remain visible when both exist.
- Search: type an IP → selects its network node, highlights host, and shows applicable policies.
- Debug log: parse counts and UI events (useful when testing large configs).

## Why local-only?

- Security: no config leaves your machine.
- Speed: runs in your browser (or can be packaged later as a desktop app if you want).

## Tech

- **UI:** React + Vite + TypeScript
- **Graph:** Cytoscape.js
- **XML parse & normalization:** custom, hardened to WatchGuard shapes
- **Excel parse:** SheetJS (XLS/XLSX) → unified policy model
- **License:** Apache-2.0 (permissive, includes patent grant)

## Getting started

### Requirements
- Node.js 18+ (or 20+ recommended)
- A WatchGuard XML export (and optional XLS/XLSX policy list)

### Install & run (dev)

```bash
npm install
npm run dev
# open the printed localhost URL (e.g., http://localhost:5173)


How to run:
npm run build
npm run preview



How to use

Start the app (npm run dev) and open the localhost URL.

Load XML: click Load XML and pick your WatchGuard config.

Debug panel will show counts: interfaces, interface CIDRs, policy total.

(Optional) Load XLS/XLSX: click Load XLS/XLSX to import your curated policy inventory.

XML + XLS entries are merged and shown with XML/XLS badges.

Explore the map:

The wheel shows networks (not /32 hosts).

If your XML includes interface/VLAN addresses, those CIDRs are used.

Otherwise, the app derives reasonable networks from policies (bucketed to /24).

Click a network node → right panel updates:

Hosts: only /32 IPs explicitly present in policies that fall within that network.

Policies: all policies that touch that network; clicking a host filters to that host’s policies.

Use the search box to jump to a host IP; the app selects its network and filters accordingly.

No zoom on click; nodes highlight subtly to preserve context.

Example workflow

Load SCC-M470 (3).xml → you’ll see policy count and either interface networks or derived ones.

Load policy.xlsx (optional) → merged policies appear with both sources shown.

Click the 10.102.93.0/24 node → Hosts lists /32s within that /24 that were found in policies; Policies list narrows to rules that touch that /24.

Click a host (e.g., 10.102.93.107) → Policies panel filters to just that host.

Known gaps / roadmap

Policy coverage: Parser now handles from-alias-list/to-alias-list and address-group/host/network shapes; if you find a policy “side” that doesn’t resolve, capture a snippet and open an issue.

Layout polish: Ring spacing at very high node counts could still collide; we’ll tune label placement and dynamic radii.

Interface detection: Some exports omit interface IPs; we fall back to derived networks—in future we may infer from routes when present.

Project structure
src/
  App.tsx                 # UI + graph + panels (networks wheel, hosts, policies, search, debug)
  parse_watchguard.ts     # XML parser + alias/address-group resolver; builds "domain"
  xml_to_upolicy.ts       # XML policies -> unified policy model
  parse_xls.ts            # XLS/XLSX policies -> unified model (SheetJS)
  merge_policies.ts       # Merge XML + XLS policies, dedupe, track source
  styles.css              # Dark theme and readable labels