import { Link } from 'react-router-dom'
import { BentoTile } from './BentoTile'
import { useAiInboxCount } from '@/hooks/useAiInboxCount'
import { useInsightsCount } from '@/hooks/useInsightsCount'

export function InboxSummaryTile() {
  const { count: inboxCount } = useAiInboxCount()
  const { count: insightsCount } = useInsightsCount()
  const total = inboxCount + insightsCount

  return (
    <BentoTile
      span={4}
      rows={1}
      label="Review inbox"
      description="AI suggestions, reviews, and insights awaiting action."
    >
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-2xl font-semibold tabular-nums">
          {total === 0 ? 'All clear' : `${total} pending`}
        </p>
        <Link
          to="/inbox"
          className="text-sm font-semibold underline whitespace-nowrap"
        >
          {total === 0 ? 'View inbox' : 'Review now'}
        </Link>
      </div>
      {total > 0 && (inboxCount > 0 || insightsCount > 0) ? (
        <p className="muted text-xs mt-1">
          {[
            inboxCount > 0 ? `${inboxCount} review item${inboxCount === 1 ? '' : 's'}` : null,
            insightsCount > 0 ? `${insightsCount} insight${insightsCount === 1 ? '' : 's'}` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      ) : null}
    </BentoTile>
  )
}
