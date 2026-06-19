import { Grid, Card } from '@cashflow/ui'

const tiles = [
  { label: 'Income', value: '$5,420.00', tone: 'var(--positive)' },
  { label: 'Spending', value: '$2,914.08', tone: 'var(--oxblood-500)' },
  { label: 'Net', value: '+$2,505.92', tone: 'var(--positive)' },
  { label: 'Savings rate', value: '46%', tone: 'var(--fg)' },
]

function Tile({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <Card>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted-foreground)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4, color: tone }}>{value}</div>
    </Card>
  )
}

export function SummaryGrid() {
  return (
    <Grid minItemWidth={150} gap="md">
      {tiles.map((t) => <Tile key={t.label} {...t} />)}
    </Grid>
  )
}
