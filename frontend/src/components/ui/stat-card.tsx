import * as React from 'react'
import { cn } from '@/lib/utils'
import { Card } from './card'

type StatCardProps = React.ComponentProps<typeof Card> & {
  label: React.ReactNode
  value: React.ReactNode
  hint?: React.ReactNode
  delta?: React.ReactNode
}

function StatCard({ label, value, hint, delta, className, ...props }: StatCardProps) {
  return (
    <Card data-slot="stat-card" className={cn('mb-0', className)} {...props}>
      <p className="statLabel">{label}</p>
      <p className="statValue">{value}</p>
      {hint ? <p className="muted statHint">{hint}</p> : null}
      {delta ? <p className="muted statDelta">{delta}</p> : null}
    </Card>
  )
}

export { StatCard }
