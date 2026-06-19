import { EmptyState, Button } from '@cashflow/ui'

export function Default() {
  return (
    <EmptyState
      title="No transactions yet"
      description="Import a card CSV or PDF statement to start tracking spend."
    />
  )
}

export function WithActions() {
  return (
    <EmptyState
      title="No receipts attached"
      description="Drop a photo or PDF, or forward one from the Cashflow inbox."
      actions={
        <>
          <Button size="sm" variant="default">Upload receipt</Button>
          <Button size="sm" variant="ghost">Learn more</Button>
        </>
      }
    />
  )
}
