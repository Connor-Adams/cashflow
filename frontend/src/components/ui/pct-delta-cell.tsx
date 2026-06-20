import { resolveDeltaTone } from '@connor-adams/designsystem'

export type PctDeltaCellProps = {
  value: number | null
}

const TONE_CLASS: Record<'positive' | 'negative' | 'neutral', string> = {
  positive: 'text-positive',
  negative: 'text-danger',
  neutral: 'text-muted-foreground',
}

export function PctDeltaCell({ value }: PctDeltaCellProps) {
  if (value == null) return <>—</>
  const up = value >= 0
  // Percent delta is a `gain`-kind metric: up = green/positive, down = red/danger.
  const tone = resolveDeltaTone(up ? 'positive' : 'negative', 'gain')
  const arrow = up ? '↑' : '↓'
  return (
    <span className={`tabular-nums ${TONE_CLASS[tone]}`}>
      {arrow} {Math.abs(value).toFixed(2)}%
    </span>
  )
}
