/**
 * Layout arithmetic for the Cashflow Sankey. Pure, so it can be tested
 * without mounting recharts — and kept out of `SankeyChart.tsx` so that file
 * exports only its component (react-refresh).
 */

/** Node label type size, in px. Drives the padding floor. */
export const SANKEY_LABEL_FONT_SIZE = 12

/** Widest gap between two stacked nodes. The two-level chart's old constant. */
const MAX_NODE_PADDING = 28

/**
 * Floor for the gap. Every node carries a label beside it, so two neighbours
 * closer together than a line of text print on top of each other — the tail
 * categories are exactly where that bites, since their bands are a pixel tall
 * and the label is the only thing left to read.
 */
const MIN_NODE_PADDING = SANKEY_LABEL_FONT_SIZE + 1

/**
 * Share of the chart's height the gaps may consume before the floor takes
 * over. Recharts divides `height - (columnSize - 1) * nodePadding` among a
 * column's bands, so a fixed padding starves them: the full-chain chart stacks
 * ~17 terminal nodes in its last column, and 16 × 28px of padding exceeds
 * 520px outright — every band collapses to a hairline.
 */
const PADDING_HEIGHT_BUDGET = 1 / 3

type Edge = { source: number; target: number }

/**
 * How many nodes land in the most crowded column — the figure that decides
 * how much padding the chart can afford.
 *
 * Mirrors recharts' own layering: a node's depth is its longest path from a
 * source, except that sinks (no outgoing links) are justified into the final
 * column. That justification is why the last column is by far the busiest,
 * and why padding has to be computed rather than assumed.
 */
export function busiestColumnSize(nodeCount: number, links: Edge[]): number {
  if (nodeCount === 0) return 0
  const outgoing = new Set(links.map((l) => l.source))
  const depth = new Array<number>(nodeCount).fill(0)
  // Longest-path relaxation. |nodes| passes always settle a DAG; the bound
  // also stops a cycle in malformed data from spinning.
  for (let pass = 0; pass < nodeCount; pass += 1) {
    let changed = false
    for (const l of links) {
      if (depth[l.target] < depth[l.source] + 1) {
        depth[l.target] = depth[l.source] + 1
        changed = true
      }
    }
    if (!changed) break
  }
  const maxDepth = Math.max(...depth)
  const perColumn = new Map<number, number>()
  for (let i = 0; i < nodeCount; i += 1) {
    const column = outgoing.has(i) ? depth[i] : maxDepth
    perColumn.set(column, (perColumn.get(column) ?? 0) + 1)
  }
  return Math.max(...perColumn.values())
}

/**
 * Gap to put between stacked nodes: as generous as the height budget allows,
 * never wider than the original constant, never narrower than a line of label
 * text.
 */
export function sankeyNodePadding(
  height: number,
  nodeCount: number,
  links: Edge[],
): number {
  const busiest = busiestColumnSize(nodeCount, links)
  if (busiest <= 1) return MAX_NODE_PADDING
  const affordable = Math.floor((height * PADDING_HEIGHT_BUDGET) / (busiest - 1))
  return Math.max(MIN_NODE_PADDING, Math.min(MAX_NODE_PADDING, affordable))
}
