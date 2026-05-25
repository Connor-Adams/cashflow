export type PctDeltaCellProps = {
  value: number | null
}

export function PctDeltaCell({ value }: PctDeltaCellProps) {
  if (value == null) return <>—</>
  const up = value >= 0
  const color = up ? 'var(--accent-positive)' : 'var(--accent-warm)'
  const arrow = up ? '↑' : '↓'
  return (
    <span style={{ color, fontVariantNumeric: 'tabular-nums' }}>
      {arrow} {Math.abs(value).toFixed(2)}%
    </span>
  )
}
