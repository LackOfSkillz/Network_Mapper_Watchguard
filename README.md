# Network Mapper for WatchGuard (Local-Only)

Interactive, local-only network map of WatchGuard environments. React + Vite + TypeScript + Cytoscape.js on the frontend; sql.js (WASM) persisted to IndexedDB for storage. No server, no cloud.

This app now supports three workflows:
- Import XML and visualize automatically.
- Import from Excel in a safe preview with Undo.
- Build a map completely from scratch (manual modeling) without any imports.

## Current capabilities

Graph and topology
- Load one or more WatchGuard XML exports into a single map (multi-device).
- Auto-draw a hub-and-spoke topology:
  - Hubs: Firewalls (multiple) or manual devices
  - Spokes: Network subnets (from interfaces/VLANs; fills with derived /24s when helpful)
  - Inter-firewall links when a network is shared (yellow edges)
- Edge labels show interface/VLAN names and are draggable along the edge; per-subnet notes are persisted.
- Node labels can include your own annotations under the CIDR.
- Search by IP focuses the containing subnet and filters the Policies panel.

LAN Focus overlay (double-click a subnet)
- Fixed overlay header with Fit button.
- Switch/Ports/VLANs/Hosts management panel with notes and locations.
- Radial micro-graph per subnet:
  - Switches as centers with hosts arranged in a ring; clear “spokes” with arrowheads.
  - Unbound hosts auto-assign to default ports 1–48 (or switch.portCount) so they render radially; port is editable.
  - Edges from switch→host; manual drag persists positions.
- Assign host→port via context menu or inline port dropdown (for single-switch subnets).

Excel import preview + safe apply
- In-app preview (Devices → “Import from Excel (Preview)…”):
  - Loads spreadsheet data, dedupes against the DB, and classifies into New / Merge / Conflict.
  - “Apply (New only)” writes safe inserts and snapshots the DB for Undo.
- Undo Import button persists until you Save/Save As; Save clears the undo buffer by design.
- Scope filters and “Unmapped networks” delta are included for auditing.

Manual modeling (from scratch)
- Maps → “New blank manual map” creates a map without XML.
- Manual Builder panel lets you:
  - Add devices (firewall/router/switch/AP)
  - Add networks (CIDR + optional name)
  - Link device ↔ network with a label (e.g., “IF 0/4 | VLAN 20”)
- The main canvas renders devices and networks; manual links display as edges.
- Double-click a network to enter LAN Focus and continue switch/host modeling there.

Persistence and safety
- Local-only DB with idempotent schema migrations.
- Snapshot/restore utilities power one-click Undo for Excel applies.
- Last-opened map auto-restored; Save/Save As/Close/Delete are available in Maps menu.

## Getting started

### Prerequisites
- Node.js 18+ (20+ recommended)

### Install and run (development)

```powershell
npm install
npm run dev
# then open the printed URL (e.g., http://localhost:5173)
```

### Build and preview (production)

```powershell
npm run build
npm run preview
```

## Using the app

### Menu bar

- Maps
  - New map from XML…
  - New blank manual map
  - Rename Map…, Save / Save As, Delete Map, Close Map
- Devices
  - Load XML, Add Firewall XML, Rename Firewall…
  - Import from Excel (Preview)… → safe preview + Apply(New only) + Undo
- View: Fit graph to view
- Help: About, Shortcuts

### Graph interactions

- Click a subnet node to select it; right panel shows hosts and policies in context.
- Right-click a subnet to edit its name; Click an edge to edit its label; drag an edge label along the edge to reposition it.
- Double-click a subnet to open LAN Focus; assign hosts to ports and manage VLANs/switches there.

### Persistence

- Stored locally via sql.js persisted to IndexedDB. No network calls.
- Undo for Excel imports uses full DB snapshots; Save/Save As clears the undo snapshot.

## Troubleshooting

- If the graph seems off-screen, use View → Fit graph to view.
- Large configs: check the in-app Debug log panel (copy/clear available) for parse counts and runtime notes.

## Project structure (selected)

```
src/
  App.tsx              # UI shell, graph rendering, menus, panels, persistence wiring
  lan/LanOverlay.tsx   # LAN Focus overlay (switches, ports, VLANs, hosts + radial micro-graph)
  db.ts                # sql.js schema, migrations, CRUD, snapshot/restore
  parse_watchguard.ts  # XML parser + alias/address-group resolver to domain model
  xml_to_upolicy.ts    # XML policies -> unified policy model
  merge_policies.ts    # Policy merge helpers
  graph_layout.ts      # Layout helpers for the hub-and-spoke map
  styles.css           # Theme styles
```

## Future roadmap

Short-term polish
- Persist dragged positions for manual devices/networks on the main canvas.
- Inline edit/rename and delete in the Manual Builder lists.
- Validation: CIDR syntax, duplicate networks, VLAN bounds; visual warnings.
- Toasts for “Apply summary” and import outcomes.

Modeling and UX
- Connect mode on canvas to draw links by clicking nodes (device↔network, switch uplinks).
- Interface-level modeling (IP/CIDR per interface, zone, VLAN tagging) for manual devices.
- Services/Objects and Policy builder; NAT and static routes (canonical uPolicy); match testing.
- VPN/tunnel links between devices.

LAN enhancements
- Optional “Unassigned” hub node/legend in LAN Focus.
- Heuristics and templates for VLAN/port placement; batch add ports/VLANs/hosts.

Interop
- Merge engine between manual objects and future imports; conflict resolution UI.
- Optional export adapters (generate vendor-ish configs or documentation).

Housekeeping
- Trim dormant deps; refine bundle size with code-splitting where appropriate.

If you have a specific workflow in mind, open an issue or PR with details and we’ll prioritize that slice.