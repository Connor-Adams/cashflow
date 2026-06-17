import * as React from 'react'
import { cn } from '@/lib/utils'
import { Card } from './card'

type FilterCardProps = React.ComponentProps<typeof Card> & {
  density?: 'compact' | 'comfortable'
}

const DENSITY: Record<NonNullable<FilterCardProps['density']>, string> = {
  compact: 'w-fit max-w-full p-2 sm:p-3',
  comfortable: '',
}

function FilterCard({ density = 'comfortable', className, ...props }: FilterCardProps) {
  return <Card data-slot="filter-card" className={cn('mb-4', DENSITY[density], className)} {...props} />
}

export { FilterCard }
export type { FilterCardProps }
