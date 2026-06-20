import { AmountText } from '@connor-adams/designsystem'

type Tone = 'business' | 'personal'

const TONE_COLOR: Record<Tone, string> = {
  business: 'var(--chart-business)',
  personal: 'var(--positive)',
}

function FocusCard({
  label,
  value,
  tone,
  currency,
}: {
  label: string
  value: number
  tone: Tone
  currency: string
}) {
  const color = TONE_COLOR[tone]
  return (
    <div
      className="rounded-lg p-3.5"
      style={{
        border: `1px solid color-mix(in srgb, ${color} 44%, var(--border))`,
        boxShadow: `inset 0 0 0 1px color-mix(in oklch, ${color} 18%, transparent)`,
        background: 'color-mix(in oklch, var(--background) 60%, transparent)',
      }}
    >
      <p className="m-0 text-xs font-bold uppercase tracking-wide text-[var(--muted-foreground)]">{label}</p>
      <p className="m-0 mt-1 text-2xl font-bold tabular-nums tracking-tight text-[var(--foreground)]">
        <AmountText value={value} currency={currency || undefined} colored={false} decimals={0} />
      </p>
    </div>
  )
}

type SplitPanelProps = {
  business: number
  personal: number
  businessShare: number
  currency: string
  emptyCaption: string
}

export function SplitPanel({ business, personal, businessShare, currency, emptyCaption }: SplitPanelProps) {
  const personalShare = 100 - businessShare
  const isEmpty = business + personal <= 0
  return (
    <div data-slot="split-panel" className="flex h-full flex-col">
      <div className="grid grid-cols-2 gap-3.5">
        <FocusCard label="Business" value={business} tone="business" currency={currency} />
        <FocusCard label="Personal" value={personal} tone="personal" currency={currency} />
      </div>
      <div className="mt-4">
        <div className="mb-2 flex justify-between text-sm font-semibold text-[var(--foreground)]" aria-hidden="true">
          <span>Business {businessShare.toFixed(0)}%</span>
          <span>Personal {personalShare.toFixed(0)}%</span>
        </div>
        <div
          className="flex h-3.5 overflow-hidden rounded-md border border-[var(--border)]"
          role="img"
          aria-label={`Business ${businessShare.toFixed(0)} percent, personal ${personalShare.toFixed(0)} percent`}
        >
          <span style={{ width: `${businessShare}%`, background: 'var(--chart-business)' }} />
          <span style={{ width: `${personalShare}%`, background: 'var(--positive)' }} />
        </div>
        {isEmpty ? (
          <p className="mt-2 mb-0 text-sm leading-6 text-muted-foreground">{emptyCaption}</p>
        ) : null}
      </div>
    </div>
  )
}
