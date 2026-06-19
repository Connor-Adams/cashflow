import { Badge } from '@cashflow/ui'

const row: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }

export function Variants() {
  return (
    <div style={row}>
      <Badge variant="default">Reconciled</Badge>
      <Badge variant="secondary">Pending</Badge>
      <Badge variant="outline">Recurring</Badge>
      <Badge variant="destructive">Overdue</Badge>
      <Badge variant="count">3 new</Badge>
    </div>
  )
}

export function InContext() {
  return (
    <div style={row}>
      <span style={{ fontWeight: 600 }}>Hydro Québec</span>
      <Badge variant="secondary">Utilities</Badge>
      <Badge variant="outline">Monthly</Badge>
    </div>
  )
}
