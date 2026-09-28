import { Card } from '@connor-adams/designsystem'
import { useJsonResource } from '../../lib/useJsonResource'
import type { PortfolioSecurityNews } from '../../types/api'

export type NewsCardProps = {
  securityId: number
}

function relativeTime(iso: string): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  const diffSec = Math.max(0, (Date.now() - t) / 1000)
  if (diffSec < 60) return 'just now'
  const mins = Math.floor(diffSec / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}

/** The fetch's own message when it has one, else a plain fallback. */
function newsErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Could not load news'
}

export function NewsCard({ securityId }: NewsCardProps) {
  const { data, loading, error } = useJsonResource<PortfolioSecurityNews>(
    `/api/portfolio/security/${securityId}/news`,
  )
  const err = error == null ? null : newsErrorMessage(error)

  if (loading) {
    return (
      <Card>
        <h2 className="text-base">News</h2>
        <p className="muted">Loading…</p>
      </Card>
    )
  }
  if (err) {
    return (
      <Card>
        <h2 className="text-base">News</h2>
        <p className="error">{err}</p>
      </Card>
    )
  }
  const items = data?.items ?? []
  if (items.length === 0) return null

  return (
    <Card>
      <div className="transactionsPanelHeader">
        <div>
          <h2 className="text-base">News</h2>
          <p className="muted">Live from Yahoo Finance.</p>
        </div>
      </div>
      <ul className="mt-3 divide-y divide-border">
        {items.map((item) => (
          <li key={item.uuid} className="py-2.5 first:pt-0 last:pb-0">
            <a
              href={item.link}
              target="_blank"
              rel="noopener noreferrer"
              className="flex gap-3 hover:underline"
            >
              {item.thumbnailUrl && (
                <img
                  src={item.thumbnailUrl}
                  alt=""
                  className="size-16 flex-none rounded-md object-cover"
                  loading="lazy"
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium leading-tight">{item.title}</p>
                <p className="muted text-xs mt-1">
                  {item.publisher}
                  {item.publishedAt && (
                    <>
                      <span className="mx-1">·</span>
                      {relativeTime(item.publishedAt)}
                    </>
                  )}
                </p>
              </div>
            </a>
          </li>
        ))}
      </ul>
    </Card>
  )
}
