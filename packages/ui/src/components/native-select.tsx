import * as React from 'react'
import { cn } from '../lib/cn'

function NativeSelect({
  className,
  size = 'default',
  ...props
}: Omit<React.ComponentProps<'select'>, 'size'> & { size?: 'default' | 'sm' }) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        'min-h-9 rounded-md border border-input bg-background/70 px-3 text-sm text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/35 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20',
        size === 'sm' && 'min-h-8 px-2 text-xs',
        className
      )}
      {...props}
    />
  )
}

function NativeSelectOption(props: React.ComponentProps<'option'>) {
  return <option data-slot="native-select-option" {...props} />
}

export { NativeSelect, NativeSelectOption }
