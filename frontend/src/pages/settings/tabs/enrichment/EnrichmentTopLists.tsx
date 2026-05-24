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
    <div className="enrichListsGrid">
      <Card className="enrichListCard">
        <div className="enrichListCard__header">
          <h3 className="enrichListCard__title">Top firing rules</h3>
          <Link to="/rules" className="enrichListCard__manage">Manage rules →</Link>
        </div>
        {rules.length === 0 ? (
          <p className="muted text-sm m-0">No rule matches recorded yet.</p>
        ) : (
          <div className="enrichListCard__rows">
            {rules.map((r) => (
              <div key={r.ruleId} className="enrichListRow">
                <span className="enrichListRow__primary">
                  <code className="enrichInlineCode">{r.pattern}</code>{' '}
                  → {r.category ?? '(no category)'}
                </span>
                <span className="enrichListRow__count">{r.count.toLocaleString()}</span>
                <Link
                  to={`/rules?focus=${r.ruleId}`}
                  className="enrichListRow__action"
                  aria-label={`View rule for ${r.pattern}`}
                >
                  View
                </Link>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="enrichListCard">
        <div className="enrichListCard__header">
          <h3 className="enrichListCard__title">Top canonical merchants</h3>
        </div>
        {merchants.length === 0 ? (
          <p className="muted text-sm m-0">None yet. Run the backfill to populate.</p>
        ) : (
          <div className="enrichListCard__rows">
            {merchants.map((m) => (
              <div key={m.name} className="enrichListRow enrichListRow--twoCol">
                <span className="enrichListRow__primary">{m.name}</span>
                <span className="enrichListRow__count">{m.count.toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
