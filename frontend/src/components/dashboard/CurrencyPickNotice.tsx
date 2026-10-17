import { Button } from '@connor-adams/designsystem'

type Props = {
  /** What the tile would show, e.g. "category totals". */
  subject: string
  /** Currencies present in the current filters — one pick button each. */
  currencies: string[]
  onPick: (currency: string) => void
}

/**
 * Stand-in for a money tile when "All currencies" is selected and the data
 * spans more than one currency. The dashboard has no FX-converted figures, so
 * adding CAD and USD amounts into one number would be wrong — the tile asks
 * for a currency instead of summing across them.
 */
export function CurrencyPickNotice({ subject, currencies, onPick }: Props) {
  return (
    <div className="flex h-full flex-col justify-center gap-3">
      <p className="m-0 text-sm text-muted-foreground">
        Pick a currency to see {subject}. These amounts span{' '}
        {currencies.join(', ')} and are never added across currencies.
      </p>
      <div className="flex flex-wrap gap-2">
        {currencies.map((c) => (
          <Button
            key={c}
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => onPick(c)}
          >
            Show {c}
          </Button>
        ))}
      </div>
    </div>
  )
}
