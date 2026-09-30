import { Link } from 'react-router-dom'
import { Alert, Button, Card } from '@connor-adams/designsystem'
import type {
  CompletenessFixSurface,
  CompletenessItemDto,
  CompletenessReportDto,
} from '@cashflow/shared'
import { fmtCurrency } from './util/format'

/**
 * Where an item gets fixed.
 *
 * `tab` is a key in `TaxPage`'s own tab list, reached through `onNavigate` because
 * that state is local to the page rather than in the URL. `href` is a real route.
 * `null` means there is no destination in the app, and the item then renders with no
 * action at all — a dead link is worse than no link, and a `projected_rate_table` gap
 * is cleared by editing a source file.
 */
const FIX_TARGETS: Record<CompletenessFixSurface, { tab?: string; href?: string } | null> = {
  classify: { tab: 'classify' },
  slips: { tab: 'slips' },
  import: { href: '/accounts/statements' },
  transactions: { href: '/transactions' },
  securities: { href: '/portfolio' },
  // No duplicate-review surface exists yet; part 1b ships a script, not a page.
  duplicates: null,
  // No carryforward editor exists; the roll happens via ?roll=true on the return.
  carryforwards: null,
  rates: null,
}

const SEVERITY_STYLES = {
  blocker: 'border-l-4 border-l-destructive',
  gap: 'border-l-4 border-l-muted-foreground',
} as const

export interface CompletenessPanelProps {
  report: CompletenessReportDto
  /** Switches `TaxPage`'s tab. Items whose fix lives on another tab call it. */
  onNavigate: (tab: string) => void
}

/**
 * What the return does not know, rendered above the total and always present.
 *
 * "My personal tax looks too low" was investigated three times, and each time the
 * answer was that the data was incomplete while the tab showed a clean, confident
 * number. No modal and no interstitial: the total stays readable, it just never
 * appears without its caveat.
 */
export function CompletenessPanel({ report, onNavigate }: CompletenessPanelProps) {
  const { status, blockers, gaps, coverageThrough } = report

  if (status === 'complete') {
    return (
      <Alert variant="success" className="mb-4">
        {coverageThrough === null
          ? 'No transactions in this year, so there is nothing to check yet.'
          : `Every completeness check passed. Transactions cover through ${coverageThrough}.`}
      </Alert>
    )
  }

  return (
    <Card className="mb-4">
      <header className="mb-3">
        <h4 className="m-0 text-sm font-semibold">
          {status === 'blocked'
            ? 'This total is incomplete'
            : 'This total may be incomplete'}
        </h4>
        <p className="m-0 text-xs text-muted-foreground">
          {status === 'blocked'
            ? 'Money is known to be missing from the return. The figure below is wrong until these are cleared.'
            : 'No missing money was found, but these could change the result.'}
          {coverageThrough !== null && ` Transactions cover through ${coverageThrough}.`}
        </p>
      </header>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {/* Blockers first: they say the total is wrong, not merely uncertain. */}
        {[...blockers, ...gaps].map((item) => (
          <CompletenessRow key={item.kind} item={item} onNavigate={onNavigate} />
        ))}
      </ul>
    </Card>
  )
}

function CompletenessRow({
  item,
  onNavigate,
}: {
  item: CompletenessItemDto
  onNavigate: (tab: string) => void
}) {
  const target = FIX_TARGETS[item.fix.surface]
  return (
    <li className={`rounded-sm bg-muted/40 px-3 py-2 ${SEVERITY_STYLES[item.severity]}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm font-medium">{item.title}</span>
        {/* Figures appear only where the report supplies one. An invented number is
            worse than none, so there is no placeholder and no zero. */}
        {item.amount !== null && (
          <span className="text-sm font-semibold tabular-nums">{fmtCurrency(item.amount)}</span>
        )}
        {item.taxEstimate !== null && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {fmtCurrency(item.taxEstimate)} of tax
          </span>
        )}
        {item.references.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {item.references.length} transactions
          </span>
        )}
        {target?.tab !== undefined && (
          <Button
            variant="secondary"
            size="sm"
            className="ml-auto"
            onClick={() => onNavigate(target.tab as string)}
          >
            {item.fix.label}
          </Button>
        )}
        {target?.href !== undefined && (
          <Link to={target.href} className="ml-auto text-sm underline">
            {item.fix.label}
          </Link>
        )}
      </div>
      <p className="m-0 mt-1 text-xs text-muted-foreground">{item.detail}</p>
    </li>
  )
}
