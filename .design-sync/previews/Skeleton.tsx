import { Skeleton, SkeletonText, Card } from '@cashflow/ui'

export function Shapes() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 320 }}>
      <Skeleton style={{ height: 28, width: 160 }} />
      <Skeleton style={{ height: 12, width: '100%' }} />
      <SkeletonText lines={3} />
    </div>
  )
}

export function LoadingCard() {
  return (
    <Card style={{ maxWidth: 300, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Skeleton style={{ height: 14, width: 120 }} />
      <Skeleton style={{ height: 30, width: 180 }} />
      <SkeletonText lines={2} />
    </Card>
  )
}
