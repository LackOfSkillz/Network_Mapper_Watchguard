import cytoscape from 'cytoscape'

type Pos = { [id: string]: { x: number; y: number } }

export function radialPositions(
  items: { id: string }[],
  cx: number,
  cy: number,
  radius: number,
  opts: { stagger?: boolean; offset?: number } = {}
): Pos {
  const n = items.length
  const pad = opts.offset ?? 0
  const angle0 = -Math.PI / 2 // start at top (12 o'clock)
  const positions: Pos = {}

  items.forEach((item, i) => {
    const t = n <= 1 ? 0 : i / n
    const a = angle0 + t * Math.PI * 2
    positions[item.id] = {
      x: cx + Math.cos(a) * (radius + pad),
      y: cy + Math.sin(a) * (radius + pad)
    }
  })

  return positions
}

export function styleSheet(): any[] {
  return [
    {
      selector: 'node',
      style: {
        'background-color': '#cfe3fa',
        'label': 'data(label)',
        'text-valign': 'center',
        'text-halign': 'center',
        'font-size': 11,
        'color': '#0b1424',
        'text-wrap': 'wrap',
        'text-max-width': 160,
        'shape': 'round-rectangle',
        'width': 'label',
        'height': 'label',
        'padding': '6px',
        'border-width': 2,
        'border-color': '#8fb6ea',
        'shadow-blur': 12,
        'shadow-opacity': 0.25
      }
    },
    {
      selector: 'node.firewall',
      style: {
        'background-color': '#cfe3fa',
        'border-color': '#5fa0ea',
        'font-size': 13,
        'text-max-width': 220,
        'padding': '10px 14px'
      }
    },
    {
      selector: 'node.network',
      style: {
        'background-color': '#ffffff',
        'border-color': '#c9d5e6',
        'color': '#0b1424'
      }
    },
    {
      selector: 'node.network.active-net',
      style: {
        'background-color': '#d8e7ff',
        'border-color': '#2a6ad6',
        'border-width': 3
      }
    },
    {
      selector: 'edge',
      style: {
        'curve-style': 'unbundled-bezier',
        'control-point-weights': 0.2,
        'line-color': '#96a0b5',
        'width': 3,
        'target-arrow-shape': 'none',
        'label': 'data(label)',
        'font-size': 10,
        // High-contrast edge labels so they’re readable on dark background
        'color': '#e6f0ff',
        'text-outline-color': '#0e1726',
        'text-outline-width': 2,
        'text-wrap': 'wrap',
        'text-rotation': 'autorotate',
        'text-margin-y': -6
      }
    }
  ]
}
