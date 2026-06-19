import type { CSSProperties } from 'react'

/**
 * Per-label color support (issue #794).
 *
 * The label `color` is an optional 6-digit hex string (`#RRGGBB`) or `null`.
 * Because the value is user-chosen at runtime, chip tinting uses inline styles
 * — Tailwind's JIT can't generate classes for arbitrary hex values. When the
 * color is `null` the chip keeps its existing neutral (`bg-muted`) look, so
 * callers fall back to their current classes.
 *
 * The picker offers a fixed palette of swatches (no free-form wheel/hex input,
 * per the issue's "palette only" scope). Values are design-system-adjacent Tailwind
 * 500-weight hues that read well as a soft tinted pill with dark text.
 */

export const LABEL_COLOR_PALETTE: readonly string[] = [
  '#EF4444', // red
  '#F97316', // orange
  '#EAB308', // amber
  '#22C55E', // green
  '#14B8A6', // teal
  '#3B82F6', // blue
  '#8B5CF6', // violet
  '#EC4899', // pink
] as const

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

/** True when `color` is a well-formed `#RRGGBB` string. */
export function isValidLabelColor(color: string | null | undefined): color is string {
  return typeof color === 'string' && HEX_COLOR.test(color)
}

/**
 * Inline style that softly tints a label chip with the label's color: a low-alpha
 * fill of the hue plus a matching border and the solid hue as text, so the pill
 * stays legible against either theme. Returns an empty object when there's no
 * (valid) color, so the caller's neutral `bg-muted` classes win unchanged (AC 6,8).
 */
export function labelChipStyle(color: string | null | undefined): CSSProperties {
  if (!isValidLabelColor(color)) return {}
  return {
    backgroundColor: `${color}26`, // ~15% alpha fill
    borderColor: `${color}80`, // ~50% alpha border
    color,
  }
}
