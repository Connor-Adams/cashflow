/**
 * Small chip shown on a SubscriptionRow when priceChangeDetected is true.
 * Clicking it opens the PriceChangeDrawer for that subscription.
 */
import { AlertTriangle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'

type Props = {
  onClick: () => void
}

export function PriceChangeChip({ onClick }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="focus:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded"
      title="Price change detected — click for details"
    >
      <Badge variant="destructive" className="cursor-pointer hover:opacity-90 transition-opacity">
        <AlertTriangle size={12} aria-hidden="true" className="mr-1" />
        price up
      </Badge>
    </button>
  )
}
