import { Textarea, Label } from '@cashflow/ui'

export function WithLabel() {
  return (
    <Label style={{ maxWidth: 360 }}>
      Note for this transaction
      <Textarea
        rows={4}
        defaultValue="Split with Sam — reimbursed half via e-transfer on Jun 14."
      />
    </Label>
  )
}

export function States() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 360 }}>
      <Textarea placeholder="Add a note…" />
      <Textarea defaultValue="Locked — imported from statement memo." disabled />
    </div>
  )
}
