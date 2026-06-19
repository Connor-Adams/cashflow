import { Button } from '@cashflow/ui'

const row: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }

export function Variants() {
  return (
    <div style={row}>
      <Button variant="default">Save changes</Button>
      <Button variant="secondary">Cancel</Button>
      <Button variant="outline">Export CSV</Button>
      <Button variant="ghost">Skip</Button>
      <Button variant="destructive">Delete</Button>
      <Button variant="link">View statement</Button>
    </div>
  )
}

export function Sizes() {
  return (
    <div style={row}>
      <Button size="sm">Small</Button>
      <Button size="default">Default</Button>
      <Button size="lg">Large</Button>
    </div>
  )
}

export function States() {
  return (
    <div style={row}>
      <Button variant="primary">Primary CTA</Button>
      <Button disabled>Disabled</Button>
    </div>
  )
}
