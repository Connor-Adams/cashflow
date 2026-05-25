import { Badge } from '@/components/ui/badge'
import { SecurityLogo } from '@/components/ui/security-logo'
import type { PortfolioSecurityDetail, PortfolioSecurityOverview } from '../../types/api'

export type SecurityHeaderProps = {
  security: PortfolioSecurityDetail['security']
  overview: PortfolioSecurityOverview | null
}

export function SecurityHeader({ security, overview }: SecurityHeaderProps) {
  return (
    <div className="flex items-center gap-4">
      <SecurityLogo
        symbol={security.symbol}
        name={security.name}
        size="xl"
        assetType={security.assetType}
        currency={security.currency}
      />
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">
          {security.symbol}
          {security.name ? <span className="muted"> — {security.name}</span> : null}
        </h1>
        <div className="flex items-center gap-2 flex-wrap">
          {security.assetType ? <Badge variant="secondary">{security.assetType}</Badge> : null}
          <Badge variant="outline">{security.currency}</Badge>
          {overview?.exchange ? <Badge variant="outline">{overview.exchange}</Badge> : null}
          {overview?.sector ? <Badge variant="outline">{overview.sector}</Badge> : null}
        </div>
      </div>
    </div>
  )
}
