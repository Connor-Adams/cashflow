import * as React from 'react'
import { cn } from '@/lib/utils'

function TxnMerchantCell({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="txn-merchant-cell"
      className={cn('flex min-w-[180px] flex-col gap-1', className)}
      {...props}
    />
  )
}

function TxnMerchantName({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="txn-merchant-name"
      className={cn('font-medium text-foreground', className)}
      {...props}
    />
  )
}

function TxnMerchantMeta({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="txn-merchant-meta"
      className={cn('text-xs text-muted-foreground', className)}
      {...props}
    />
  )
}

export { TxnMerchantCell, TxnMerchantName, TxnMerchantMeta }
