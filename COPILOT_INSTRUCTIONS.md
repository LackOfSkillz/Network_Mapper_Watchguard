# Project context
Local-only WatchGuard Network Mapper. Tech: React + Vite + TypeScript, Cytoscape. Runs 100% locally in the browser. No cloud calls. 

# Goals
- Parse WatchGuard XML (interfaces incl. secondary IPs & VLANs, aliases, services, policies, routes).
- Optional XLS policy enrichment; merge with XML and show both with badges.
- Graph: single Firebox hub; ring of **network** nodes (not /32s). Edge labels must show **physical interface + VLAN** when known.
- Right panel: Hosts (only /32s explicitly present in policy for the selected subnet) and Policies. Clicking a host filters policies.

# Non-goals / constraints
- No configs / spreadsheets / DB files in Git.
- Keep UI snappy for ~10k aliases + 5k policies.

# Current issues to respect
- Ensure `domain.interfaces[*].cidrs` contain **network CIDRs** (from IP+netmask and secondary IPs).
- Attribute derived subnets to the most-specific interface and label edges "<ifname> | VLAN <id/name>".
- Don’t auto-zoom on click; just highlight.

# Style
- When asked to change a file, print the *entire* file content.
- Prefer adding helper utilities over inlining complex logic.
