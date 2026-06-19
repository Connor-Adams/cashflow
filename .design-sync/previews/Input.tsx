import { Input, Label } from '@cashflow/ui'

const field: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 320 }

export function WithLabels() {
  return (
    <div style={field}>
      <Label>
        Payee name
        <Input placeholder="e.g. Whole Foods Market" defaultValue="Whole Foods Market" />
      </Label>
      <Label>
        Amount
        <Input type="text" inputMode="decimal" placeholder="0.00" defaultValue="84.20" />
      </Label>
    </div>
  )
}

export function States() {
  return (
    <div style={field}>
      <Input placeholder="Search transactions…" />
      <Input defaultValue="Locked field" disabled />
      <Input defaultValue="not-an-amount" aria-invalid="true" />
    </div>
  )
}
