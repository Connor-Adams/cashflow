import * as React from 'react'
import { cn } from '../lib/cn'

function Label({ className, ...props }: React.ComponentProps<'label'>) {
  return (
    <label
      data-slot="label"
      className={cn('grid gap-1 text-[0.82rem] font-semibold text-muted-foreground', className)}
      {...props}
    />
  )
}

export { Label }
