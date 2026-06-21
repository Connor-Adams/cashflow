import { Link } from 'react-router-dom'
import { Card } from '@connor-adams/designsystem'
import type { EnrichmentStats } from '../../../../types/api'
import { enrichmentFilterHref } from './enrichmentFilterHref'

const MAX_ROWS = 6

type Props = {
  topRules: EnrichmentStats['topRules']
  topMerchants: EnrichmentStats['topCanonicalMerchants']
  deadRules: EnrichmentStats['deadRules']
}

export function EnrichmentTopLists({ topRules, topMerchants, deadRules }: Props) {
  const rules = topRules.slice(0, MAX_ROWS)
  const merchants = topMerchants.slice(0, MAX_ROWS)

  return (
    <div className="grid grid-cols-2 gap-[0.625rem] mb-[0.875rem] max-[760px]:grid-cols-1">
      <Card>
        <div className="flex justify-between items-baseline mb-[0.625rem]">
          <h3 className="text-[0.95rem] font-semibold m-0">Top firing rules</h3>
          <Link to="/rules" className="text-[0.78rem] font-medium text-primary no-underline hover:underline">Manage rules →</Link>
        </div>
        {rules.length === 0 ? (
          <p className="muted mb-0">No rule matches recorded yet.</p>
        ) : (
          <div className="text-[0.82rem]">
            {rules.map((r) => (
              <div
                key={r.ruleId}
                className="grid gap-[0.625rem] py-2 items-baseline border-b border-border last:border-b-0 [grid-template-columns:1fr_auto_auto]"
              >
                <span className="text-foreground min-w-0">
                  <code className="bg-[color-mix(in_srgb,var(--primary)_18%,transparent)] text-foreground px-[6px] py-[1px] rounded-[3px] text-[0.78rem]">{r.pattern}</code>{' '}
                  → {r.category ?? '(no category)'}
                </span>
                <span className="text-muted-foreground tabular-nums">{r.count.toLocaleString()}</span>
                <Link
                  to={`/rules?focus=${r.ruleId}`}
                  className="text-[0.75rem] text-primary no-underline hover:underline"
                  aria-label={`View rule for ${r.pattern}`}
                >
                  View
                </Link>
              </div>
            ))}
          </div>
        )}

        {deadRules.length > 0 && (
          <div className="mt-3 pt-3 border-t border-border">
            <p className="text-[0.75rem] font-semibold text-warning-foreground m-0 mb-1">
              Dead rules ({deadRules.length}) — never fired
            </p>
            {deadRules.slice(0, MAX_ROWS).map((r) => (
              <div key={r.ruleId} className="flex justify-between text-[0.78rem] py-1">
                <code className="bg-[color-mix(in_srgb,var(--warning)_18%,transparent)] px-[6px] py-[1px] rounded-[3px]">{r.pattern}</code>
                <Link to={`/rules?focus=${r.ruleId}`} className="text-primary no-underline hover:underline" aria-label={`View dead rule for ${r.pattern}`}>View</Link>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <div className="flex justify-between items-baseline mb-[0.625rem]">
          <h3 className="text-[0.95rem] font-semibold m-0">Top canonical merchants</h3>
        </div>
        {merchants.length === 0 ? (
          <p className="muted mb-0">None yet. Run the backfill to populate.</p>
        ) : (
          <div className="text-[0.82rem]">
            {merchants.map((m) => (
              <div
                key={m.name}
                className="grid gap-[0.625rem] py-2 items-baseline border-b border-border last:border-b-0 [grid-template-columns:1fr_auto]"
              >
                <Link
                  to={enrichmentFilterHref('merchantCanonical', m.name)}
                  className="text-foreground min-w-0 no-underline hover:underline"
                >
                  {m.name}
                </Link>
                <span className="text-muted-foreground tabular-nums">{m.count.toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
