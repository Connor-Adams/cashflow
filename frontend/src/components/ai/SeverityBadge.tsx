import { Badge } from '@connor-adams/designsystem'

export type InsightSeverity = 'action' | 'watch' | 'info'

const VARIANT_BY_SEVERITY: Record<InsightSeverity, 'destructive' | 'secondary' | 'outline'> = {
  action: 'destructive',
  watch: 'secondary',
  info: 'outline',
}

export function SeverityBadge({ severity }: { severity: InsightSeverity }) {
  return <Badge variant={VARIANT_BY_SEVERITY[severity]}>{severity}</Badge>
}
