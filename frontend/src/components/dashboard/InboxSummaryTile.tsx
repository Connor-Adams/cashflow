import { Link } from 'react-router-dom'
import { Skeleton } from '@connor-adams/designsystem'
import { BentoTile } from './BentoTile'
import { LoadErrorAlert } from '../LoadErrorAlert'
import { useAiInboxCount } from '@/hooks/useAiInboxCount'
import { useInsightsCount } from '@/hooks/useInsightsCount'

export function InboxSummaryTile() {
  const inbox = useAiInboxCount()
  const insights = useInsightsCount()

  return (
    <BentoTile
      span={6}
      rows={1}
      label="Review inbox"
      description="AI suggestions, reviews, and insights awaiting action."
    >
      <InboxSummaryBody
        inboxCount={inbox.count}
        insightsCount={insights.count}
        loading={inbox.loading || insights.loading}
        onRetry={() => {
          inbox.refetch()
          insights.refetch()
        }}
      />
    </BentoTile>
  )
}

/**
 * A count is `null` until a fetch has succeeded. Unknown counts must never
 * collapse to 0 ("All clear"): show a skeleton while loading and an error
 * with Retry once a fetch has failed. After a later refetch failure the hooks
 * keep the last good value, so the tile keeps showing it.
 */
function InboxSummaryBody({
  inboxCount,
  insightsCount,
  loading,
  onRetry,
}: {
  inboxCount: number | null
  insightsCount: number | null
  loading: boolean
  onRetry: () => void
}) {
  if (inboxCount == null || insightsCount == null) {
    if (loading) return <Skeleton h={32} w={160} aria-label="Loading inbox count" />
    return <LoadErrorAlert title="Couldn't load the inbox count" onRetry={onRetry} />
  }

  const total = inboxCount + insightsCount
  return (
    <>
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
      {total > 0 ? (
        <p className="muted text-xs mt-1">
          {[
            inboxCount > 0 ? `${inboxCount} review item${inboxCount === 1 ? '' : 's'}` : null,
            insightsCount > 0 ? `${insightsCount} insight${insightsCount === 1 ? '' : 's'}` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      ) : null}
    </>
  )
}
