import { Alert, Button } from '@cashflow/ui'

const stack: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10 }

export function Variants() {
  return (
    <div style={stack}>
      <Alert variant="success" title="Statement imported">
        142 transactions added from RBC Visa · March 2026.
      </Alert>
      <Alert variant="info" title="3 transactions need a category">
        Review them before they roll into your monthly summary.
      </Alert>
      <Alert variant="warning" title="Duplicate import detected">
        This file overlaps an earlier upload by 18 rows.
      </Alert>
      <Alert variant="error" title="Couldn't parse statement">
        Rows 44–51 have an unexpected date format.
      </Alert>
    </div>
  )
}

export function WithAction() {
  return (
    <Alert
      variant="warning"
      title="Budget exceeded — Dining"
      action={<Button size="sm" variant="outline">Adjust budget</Button>}
    >
      You're $128.40 over your $400 monthly limit.
    </Alert>
  )
}
