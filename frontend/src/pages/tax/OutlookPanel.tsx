import { Alert, Badge, Card, StatCard } from '@connor-adams/designsystem'
import type {
  ForwardViewDto,
  InstalmentBasis,
  InstalmentDueDto,
  InstalmentOptionDto,
} from '@cashflow/shared'
import { useTaxOutlook } from '../../hooks/useTaxOutlook'
import { fmtCurrency } from './util/format'

/**
 * CRA's three ways of arriving at the same four payments.
 *
 * Named rather than abbreviated: `no_calculation` is CRA's own term for the amounts
 * printed on the instalment reminder, and a reader comparing this panel against that
 * letter needs the letter's words.
 */
const BASIS_LABELS: Record<InstalmentBasis, string> = {
  no_calculation: 'No-calculation option',
  prior_year: 'Prior-year option',
  current_year: 'Current-year estimate',
}

const BASIS_DETAIL: Record<InstalmentBasis, string> = {
  no_calculation: 'The amounts on the CRA instalment reminder — two quarters of the second prior year, then the prior year’s remainder.',
  prior_year: 'Last year’s net tax owing, split four ways. Pay what a filed year proved and settle the rest with the return.',
  current_year: 'This year’s estimated net tax owing, split four ways. Pays the least up front — and is the only option that can fall short.',
}

/**
 * Left-rule accents, keyed so Tailwind's JIT sees literal class strings.
 *
 * `risk` is not decoration: the current-year option is the one that can leave a
 * shortfall CRA charges interest on, so it is marked the same way a blocker is on the
 * completeness panel.
 */
const OPTION_STYLES = {
  recommended: 'border-l-4 border-l-muted-foreground',
  risk: 'border-l-4 border-l-destructive',
  plain: 'border-l-4 border-l-transparent',
} as const

export interface OutlookPanelProps {
  year: number
}

/**
 * What is coming, rendered below the total: the next cash obligation and its date.
 *
 * Every other block on this tab answers what happened. Connor's question was "so I
 * know what I'm getting myself into", and its answer is two facts the app never
 * stated: whether quarterly instalments are required (they are not, for a year whose
 * two predecessors were under the threshold — a single-conjunct reading of CRA's test
 * would have reported him late all year), and that the whole amount then lands on one
 * April date.
 *
 * Fetches on its own `year` rather than taking the outlook as a prop: the figures come
 * from the entity's actual facts across a three-year window, so the active scenario's
 * overrides cannot move them.
 */
export function OutlookPanel({ year }: OutlookPanelProps) {
  const { data, loading, error } = useTaxOutlook(year)

  if (loading) return <p className="muted mb-4">Loading outlook…</p>
  // Surfaced, not swallowed. A year with no encoded rate table answers 409 here, and
  // silence would read as "no instalments required" — the opposite of the truth.
  if (error) return <Alert variant="error" className="mb-4">Failed to load the outlook: {error}</Alert>
  if (!data) return null

  const { obligation, forward, projectedCurrentYearNetOwing, provenanceWarnings } = data
  // Falls back to the first option rather than asserting: the balance hint is not
  // worth a crash if the backend ever recommends a basis the options list lacks.
  const recommendedOption =
    obligation.options.find((o) => o.basis === obligation.recommended) ?? obligation.options[0]

  return (
    <Card className="mb-4">
      <header className="mb-3">
        <h4 className="m-0 text-sm font-semibold">What’s coming</h4>
        <p className="m-0 text-xs text-muted-foreground">
          The next cash obligation for {obligation.year} and the year at its current run rate.
        </p>
      </header>

      <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {/* The balance-due date leads. It is the largest single obligation in the
            picture — for a year needing no instalments it is the whole of it — and
            nothing in the app named it before. */}
        <StatCard
          label="Balance due"
          value={obligation.balanceDueOn}
          hint={
            obligation.required
              ? `${fmtCurrency(recommendedOption.balanceWithReturn)} on this date if you follow the `
                + 'recommended option below.'
              : 'With no instalments required, the whole amount is due on this date.'
          }
        />
        <StatCard
          label="Projected net tax owing"
          value={fmtCurrency(projectedCurrentYearNetOwing)}
          hint={`Full year ${obligation.year}, projected. This is the figure CRA’s instalment threshold test reads.`}
        />
      </div>

      <Alert
        variant={obligation.required ? 'warning' : 'success'}
        title={
          obligation.required
            ? `Quarterly instalments are required for ${obligation.year}`
            : `No instalments are required for ${obligation.year}`
        }
        className="mb-3"
      >
        {/* Verbatim. The reason names which conjunct of CRA's two-part test decided
            it, and paraphrasing it would drop the years the verdict rests on — which
            is exactly what a reader needs in order to disagree with it. */}
        {obligation.reason}
      </Alert>

      {obligation.required && <InstalmentSchedule instalments={obligation.instalments} />}

      <section className="mb-3">
        <h5 className="m-0 mb-2 text-xs font-semibold uppercase text-muted-foreground">
          How CRA lets you calculate them
        </h5>
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {obligation.options.map((option) => (
            <OptionRow
              key={option.basis}
              option={option}
              recommended={option.basis === obligation.recommended}
            />
          ))}
        </ul>
      </section>

      <ForwardSection forward={forward} />

      {provenanceWarnings.length > 0 && (
        <Alert variant="warning" title="The inputs behind this carry uncertainty" className="mt-3">
          <ul className="m-0 list-disc pl-5">
            {provenanceWarnings.map((w) => <li key={w}>{w}</li>)}
          </ul>
        </Alert>
      )}
    </Card>
  )
}

/** The recommended option's four dated payments, shown only when they are owed. */
function InstalmentSchedule({ instalments }: { instalments: InstalmentDueDto[] }) {
  return (
    <section className="mb-3">
      <h5 className="m-0 mb-2 text-xs font-semibold uppercase text-muted-foreground">
        Instalments due
      </h5>
      <ul className="m-0 grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-4">
        {instalments.map((i) => (
          <li key={i.dueOn} className="rounded-sm bg-muted/40 px-3 py-2">
            <div className="text-xs text-muted-foreground">{i.dueOn}</div>
            <div className="text-sm font-semibold tabular-nums">{fmtCurrency(i.amount)}</div>
          </li>
        ))}
      </ul>
    </section>
  )
}

function OptionRow({ option, recommended }: { option: InstalmentOptionDto; recommended: boolean }) {
  const accent = option.carriesInterestRisk
    ? OPTION_STYLES.risk
    : recommended ? OPTION_STYLES.recommended : OPTION_STYLES.plain
  return (
    <li className={`rounded-sm bg-muted/40 px-3 py-2 ${accent}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm font-medium">{BASIS_LABELS[option.basis]}</span>
        <span className="text-sm font-semibold tabular-nums">{fmtCurrency(option.total)}</span>
        {recommended && <Badge variant="secondary">Recommended</Badge>}
        {/* Server-computed. Subtracting the instalments from the owing in the client
            would mean arithmetic on fixed-2 money strings. */}
        <span className="text-xs text-muted-foreground tabular-nums">
          {fmtCurrency(option.balanceWithReturn)} left with the return
        </span>
      </div>
      <p className="m-0 mt-1 text-xs text-muted-foreground">{BASIS_DETAIL[option.basis]}</p>
      {option.carriesInterestRisk && (
        <p className="m-0 mt-1 text-xs font-medium text-destructive">
          Interest risk: if this estimate comes in low, CRA charges interest on the shortfall from
          each missed due date.
        </p>
      )}
    </li>
  )
}

/**
 * The year at its run rate.
 *
 * Labelled a projection in the heading and again on the figures, because the draws
 * half of it is an average extrapolated over months that have not happened and the
 * tax half is that average priced through the engine. `draws.basis` is rendered
 * verbatim: it states the assumption and names any month with no transactions at all,
 * which is the difference between a month with no draws and a missing statement.
 */
function ForwardSection({ forward }: { forward: ForwardViewDto }) {
  const { draws } = forward
  return (
    <section>
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <h5 className="m-0 text-xs font-semibold uppercase text-muted-foreground">
          {forward.year} at the current run rate
        </h5>
        {forward.isProjection && <Badge variant="outline">Projection</Badge>}
      </div>
      <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div className="flex justify-between">
          <dt className="text-muted-foreground">Draws actually recorded</dt>
          <dd className="m-0 tabular-nums">{fmtCurrency(draws.actualToDate)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">Projected draws for the year</dt>
          <dd className="m-0 tabular-nums">{fmtCurrency(draws.projectedTotal)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">Total payable as it stands</dt>
          <dd className="m-0 tabular-nums">{fmtCurrency(forward.currentTotalPayable)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">Projected additional tax</dt>
          <dd className="m-0 tabular-nums">{fmtCurrency(forward.projectedAdditionalTax)}</dd>
        </div>
      </dl>
      <p className="m-0 mt-2 text-xs text-muted-foreground">{draws.basis}</p>
    </section>
  )
}
