# Network Mapper for WatchGuard (Local-Only)

Interactive, local-only network map of WatchGuard Firebox configs. Built with React + Vite + TypeScript and Cytoscape.js. No server, no cloud.

Note: The app is currently XML-only. Prior PDF/XLS import experiments were removed from the UI. If you see related packages in package.json, they are inert and can be cleaned up later.

## Current capabilities

- Import one or more WatchGuard XML exports into a single “map”.
- Auto-draw a hub-and-spoke topology:
  - Hub(s): Firewalls (multiple devices supported per map)
  - Spokes: Network subnets (CIDRs from interface/VLANs; falls back to derived /24s when needed)
  - Inter-firewall links for shared networks (yellow edges)
- Gateways and interface names annotated on edges; network nodes can display VLAN tags when known.
- Editable annotations:
  - Right-click a network node to set a label under the CIDR (persisted per map)
  - Click an edge to add/edit an edge note (persisted per subnet per map)
  - Drag edge labels along the edge; offsets persist per map
- Selection-aware UI:
  - Selecting a network highlights that node in the graph
  - Right-side panels update to show Hosts (explicit /32s in policies within the subnet) and Policies affecting the subnet; clicking a host filters Policies
  - Search by IP selects its subnet and highlights the host
- Map management (local database via sql.js + IndexedDB):
  - New, Open, Save, Save As, Delete Map, Close Map
  - Rename primary firewall
  - Last-opened map auto-restored on refresh
- Modern, dark theme with a classic menu bar: Maps, Devices, View, Help

## Getting started

### Prerequisites

- Node.js 18+ (20+ recommended)
- A WatchGuard XML export

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
  - New Map: start fresh
  - Open: choose from saved maps
  - Save / Save As: persist the current session
  - Delete Map: remove a saved map
  - Close Map: close the current map (restores clean state)
- Devices
  - Load XML: add a firewall from an XML export (first load creates the device for the map)
  - Add Firewall XML: add additional firewall XMLs into this map
  - Rename Firewall: rename the primary device for this map
- View
  - Fit graph to view
- Help
  - About, Shortcuts

### Graph interactions

- Click a subnet node to select it; the node is visibly highlighted.
- Right-click a subnet node to edit its label (stored per map/subnet).
- Click an edge to edit its note; press and drag the edge label to move it along the edge (offset persists).
- Search by IP in the header: selects the containing subnet and narrows the policy list to that host.

### Persistence

- Data is stored locally in the browser using sql.js (WASM) persisted to IndexedDB.
- The last-opened map ID is stored in localStorage for quick restoration across refreshes.

## Roadmap

- LAN Focus (in design): double-click a subnet to enter a focused LAN view with a left-side LAN panel (Switches/Ports/VLANs/Hosts), a dedicated LAN micro-graph, and smooth enter/exit transitions. Manual hosts added in LAN should appear in the right Hosts panel to keep both sides consistent.
- Keyboard shortcuts and additional visual polish.
- Optional cleanup of dormant PDF/XLS dependencies.

## Troubleshooting

- If the graph seems off-screen, use View → Fit graph to view.
- Large configs: the debug log (in-app) reports parse counts and can help diagnose missing alias/address-group references.

## Project structure

```
src/
  App.tsx              # UI shell, graph rendering, menus, panels, persistence wiring
  parse_watchguard.ts  # XML parser + alias/address-group resolver to domain model
  xml_to_upolicy.ts    # XML policies -> unified policy model
  merge_policies.ts    # XML-only merge path (XLS disabled in UI)
  graph_layout.ts      # Layout helpers for the hub-and-spoke map
  store.ts             # App state helpers
  styles.css           # Dark theme styles
```

No network calls are made; everything runs locally in your browser.