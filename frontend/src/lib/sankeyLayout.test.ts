/**
 * The Sankey's padding policy. Split out of the chart because it is pure
 * arithmetic and because getting it wrong is invisible in a unit test but
 * fatal on screen: the full-chain chart shipped with a fixed 28px gap, which
 * on a column of 17 terminal nodes consumes more than the chart's entire
 * height and collapses every band into a hairline.
 */
import { describe, expect, it } from 'vitest'
import {
  SANKEY_LABEL_FONT_SIZE,
  busiestColumnSize,
  sankeyNodePadding,
} from './sankeyLayout'

/** Income → draws → N terminal categories, the production shape. */
function fanOut(terminals: number) {
  const links = [{ source: 0, target: 1 }]
  for (let i = 2; i < 2 + terminals; i += 1) links.push({ source: 1, target: i })
  return { nodeCount: 2 + terminals, links }
}

describe('busiestColumnSize', () => {
  it('counts the terminal column, where recharts justifies every sink', () => {
    const { nodeCount, links } = fanOut(17)
    expect(busiestColumnSize(nodeCount, links)).toBe(17)
  })

  it('justifies a shallow sink into the last column alongside the deep one', () => {
    // 0 → 1 → 2 → 3 is three deep; 0 → 4 is a sink that lands in column 3 too.
    const links = [
      { source: 0, target: 1 },
      { source: 1, target: 2 },
      { source: 2, target: 3 },
      { source: 0, target: 4 },
    ]
    expect(busiestColumnSize(5, links)).toBe(2)
  })

  it('handles an empty chart without throwing', () => {
    expect(busiestColumnSize(0, [])).toBe(0)
  })

  it('terminates on a cyclic payload rather than spinning', () => {
    const links = [
      { source: 0, target: 1 },
      { source: 1, target: 0 },
    ]
    expect(busiestColumnSize(2, links)).toBeGreaterThan(0)
  })
})

describe('sankeyNodePadding', () => {
  it('leaves most of the height for the bands on a crowded column', () => {
    const { nodeCount, links } = fanOut(17)
    const padding = sankeyNodePadding(520, nodeCount, links)
    // The regression: 28px × 16 gaps = 448px of a 520px chart.
    expect(padding * (17 - 1)).toBeLessThan(520 * 0.6)
  })

  it('never drops below a line of label text, so labels cannot overprint', () => {
    const { nodeCount, links } = fanOut(40)
    expect(sankeyNodePadding(300, nodeCount, links)).toBeGreaterThanOrEqual(
      SANKEY_LABEL_FONT_SIZE,
    )
  })

  it('keeps the roomy original gap when there is nothing to stack', () => {
    expect(sankeyNodePadding(520, 2, [{ source: 0, target: 1 }])).toBe(28)
  })

  it('never exceeds the original gap, however tall the chart', () => {
    const { nodeCount, links } = fanOut(4)
    expect(sankeyNodePadding(5000, nodeCount, links)).toBe(28)
  })
})
