import * as React from 'react'
import { cn } from '../lib/cn'

type AlertVariant = 'error' | 'warning' | 'info' | 'success'

type AlertProps = Omit<React.ComponentProps<'div'>, 'title'> & {
  variant?: AlertVariant
  title?: React.ReactNode
  action?: React.ReactNode
}

const VARIANT_STYLE: Record<AlertVariant, React.CSSProperties> = {
  error: {
    background: 'color-mix(in srgb, var(--danger) 10%, transparent)',
    borderColor: 'color-mix(in srgb, var(--danger) 42%, var(--border))',
    color: 'var(--fg)',
  },
  warning: {
    background: 'color-mix(in srgb, var(--accent-warm) 12%, transparent)',
    borderColor: 'color-mix(in srgb, var(--accent-warm) 45%, var(--border))',
    color: 'var(--fg)',
  },
  info: {
    background: 'color-mix(in srgb, var(--primary) 10%, transparent)',
    borderColor: 'color-mix(in srgb, var(--primary) 40%, var(--border))',
    color: 'var(--fg)',
  },
  success: {
    background: 'color-mix(in srgb, var(--accent-green) 12%, transparent)',
    borderColor: 'color-mix(in srgb, var(--accent-green) 45%, var(--border))',
    color: 'var(--fg)',
  },
}

function Alert({
  variant = 'info',
  title,
  action,
  className,
  children,
  ...props
}: AlertProps) {
  const role = variant === 'error' ? 'alert' : 'status'
  const ariaLive = variant === 'error' ? 'assertive' : 'polite'
  return (
    <div
      data-slot="alert"
      data-variant={variant}
      role={role}
      aria-live={ariaLive}
      aria-atomic="true"
      className={cn(
        'flex flex-col gap-2 rounded-lg border p-3 text-sm',
        className
      )}
      style={VARIANT_STYLE[variant]}
      {...props}
    >
      {title || action ? (
        <div className="flex items-start justify-between gap-3">
          {title ? (
            <p data-slot="alert-title" className="m-0 font-semibold">
              {title}
            </p>
          ) : null}
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      ) : null}
      {children ? (
        <div data-slot="alert-body" className="text-sm leading-5">
          {children}
        </div>
      ) : null}
    </div>
  )
}

export { Alert }
export type { AlertVariant }
