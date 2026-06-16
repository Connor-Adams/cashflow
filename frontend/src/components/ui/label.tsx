import * as React from 'react'
import { cn } from '@/lib/utils'

function Label({ className, ...props }: React.ComponentProps<'label'>) {
  return (
    <label
      data-slot="label"
      className={cn('grid gap-1 text-[0.82rem] font-semibold text-muted-foreground', className)}
      {...props}
    />
  )
}

// Frontend UI <Label> component; unrelated to the backend Label model that shares the name across packages.
export { Label }
