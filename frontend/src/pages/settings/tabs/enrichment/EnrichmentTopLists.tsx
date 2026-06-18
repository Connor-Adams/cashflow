import { Link } from 'react-router-dom'
import { Card } from '@/components/ui/card'
import type { EnrichmentStats } from '../../../../types/api'

const MAX_ROWS = 6

type Props = {
  topRules: EnrichmentStats['topRules']
  topMerchants: EnrichmentStats['topCanonicalMerchants']
}

export function EnrichmentTopLists({ topRules, topMerchants }: Props) {
  const rules = topRules.slice(0, MAX_ROWS)
  const merchants = topMerchants.slice(0, MAX_ROWS)

  return (
    <div className="grid grid-cols-2 gap-[0.625rem] mb-[0.875rem] max-[760px]:grid-cols-1">
      <Card>
        <div className="flex justify-between items-baseline mb-[0.625rem]">
          <h3 className="text-[0.95rem] font-semibold m-0">Top firing rules</h3>
          <Link to="/rules" className="text-[0.78rem] font-medium text-[var(--primary)] no-underline hover:underline">Manage rules →</Link>
        </div>
        {rules.length === 0 ? (
          <p className="muted mb-0">No rule matches recorded yet.</p>
        ) : (
          <div className="text-[0.82rem]">
            {rules.map((r) => (
              <div
                key={r.ruleId}
                className="grid gap-[0.625rem] py-2 items-baseline border-b border-[var(--border)] last:border-b-0 [grid-template-columns:1fr_auto_auto]"
              >
                <span className="text-[var(--foreground)] min-w-0">
                  <code className="bg-[color-mix(in_srgb,var(--primary)_18%,transparent)] text-[var(--foreground)] px-[6px] py-[1px] rounded-[3px] text-[0.78rem]">{r.pattern}</code>{' '}
                  → {r.category ?? '(no category)'}
                </span>
                <span className="text-[var(--muted-foreground)] tabular-nums">{r.count.toLocaleString()}</span>
                <Link
                  to={`/rules?focus=${r.ruleId}`}
                  className="text-[0.75rem] text-[var(--primary)] no-underline hover:underline"
                  aria-label={`View rule for ${r.pattern}`}
                >
                  View
                </Link>
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
                className="grid gap-[0.625rem] py-2 items-baseline border-b border-[var(--border)] last:border-b-0 [grid-template-columns:1fr_auto]"
              >
                <span className="text-[var(--foreground)] min-w-0">{m.name}</span>
                <span className="text-[var(--muted-foreground)] tabular-nums">{m.count.toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
