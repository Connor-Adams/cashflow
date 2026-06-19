import { Card, CardHeader, CardTitle, CardDescription, CardContent, Badge } from '@cashflow/ui'

export function AccountCard() {
  return (
    <Card style={{ maxWidth: 360, padding: 0 }}>
      <CardHeader>
        <CardTitle>RBC Chequing</CardTitle>
        <CardDescription>Last synced 2 hours ago · CAD</CardDescription>
      </CardHeader>
      <CardContent>
        <div style={{ fontSize: 28, fontWeight: 700 }}>$4,182.55</div>
        <div style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'center' }}>
          <Badge variant="secondary">Chequing</Badge>
          <span style={{ color: 'var(--positive)', fontWeight: 600 }}>+$1,240 this month</span>
        </div>
      </CardContent>
    </Card>
  )
}

export function MetricCard() {
  return (
    <Card style={{ maxWidth: 240 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted-foreground)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        Spent in June
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, marginTop: 4 }}>$2,914.08</div>
      <div style={{ marginTop: 4, fontSize: 13, color: 'var(--oxblood-500)', fontWeight: 600 }}>↑ 12% vs May</div>
    </Card>
  )
}
