/* eslint-disable react-refresh/only-export-components */
import * as React from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'
import { Button } from './button'

type DialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
  className?: string
  dismissOnBackdropClick?: boolean
  initialFocusRef?: React.RefObject<HTMLElement | null>
  labelledBy?: string
  describedBy?: string
}

const DialogTitleIdContext = React.createContext<{
  titleId: string
  descriptionId: string
  setHasTitle: (has: boolean) => void
  setHasDescription: (has: boolean) => void
} | null>(null)

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute('data-focus-sentinel')
  )
}

function Dialog({
  open,
  onOpenChange,
  children,
  className,
  dismissOnBackdropClick = true,
  initialFocusRef,
  labelledBy,
  describedBy,
}: DialogProps) {
  const reactId = React.useId()
  const titleId = labelledBy ?? `dialog-title-${reactId}`
  const descriptionId = describedBy ?? `dialog-description-${reactId}`
  const dialogRef = React.useRef<HTMLDivElement | null>(null)
  const previouslyFocusedRef = React.useRef<HTMLElement | null>(null)
  const [hasTitle, setHasTitle] = React.useState(false)
  const [hasDescription, setHasDescription] = React.useState(false)

  // Body scroll lock
  React.useEffect(() => {
    if (!open) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [open])

  // Save focus on open, restore on close
  React.useEffect(() => {
    if (open) {
      previouslyFocusedRef.current = (document.activeElement as HTMLElement) ?? null
      return () => {
        const target = previouslyFocusedRef.current
        if (target && typeof target.focus === 'function') {
          try {
            target.focus()
          } catch {
            // ignore
          }
        }
      }
    }
    return undefined
  }, [open])

  // Auto-focus initial element
  React.useEffect(() => {
    if (!open) return
    // Defer to allow children to mount
    const id = window.setTimeout(() => {
      if (initialFocusRef?.current) {
        initialFocusRef.current.focus()
        return
      }
      const container = dialogRef.current
      if (!container) return
      const focusables = getFocusable(container)
      if (focusables.length > 0) {
        focusables[0].focus()
      } else {
        container.focus()
      }
    }, 0)
    return () => window.clearTimeout(id)
  }, [open, initialFocusRef])

  // ESC to close + focus trap
  React.useEffect(() => {
    if (!open) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onOpenChange(false)
        return
      }
      if (event.key === 'Tab') {
        const container = dialogRef.current
        if (!container) return
        const focusables = getFocusable(container)
        if (focusables.length === 0) {
          event.preventDefault()
          container.focus()
          return
        }
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        const active = document.activeElement as HTMLElement | null
        if (event.shiftKey) {
          if (active === first || !container.contains(active)) {
            event.preventDefault()
            last.focus()
          }
        } else if (active === last) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [open, onOpenChange])

  if (!open) return null
  if (typeof document === 'undefined') return null

  function onBackdropMouseDown(event: React.MouseEvent<HTMLDivElement>) {
    if (!dismissOnBackdropClick) return
    if (event.target === event.currentTarget) {
      onOpenChange(false)
    }
  }

  const portalNode = (
    <div
      data-slot="dialog-overlay"
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/60 p-4"
      onMouseDown={onBackdropMouseDown}
    >
      <div
        data-slot="dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={hasTitle ? titleId : undefined}
        aria-describedby={hasDescription ? descriptionId : undefined}
        tabIndex={-1}
        className={cn(
          'relative w-full max-w-md rounded-lg border border-border shadow-lg outline-none',
          className
        )}
        style={{
          background: 'var(--card)',
          color: 'var(--fg)',
        }}
      >
        <DialogTitleIdContext.Provider
          value={{
            titleId,
            descriptionId,
            setHasTitle,
            setHasDescription,
          }}
        >
          {children}
        </DialogTitleIdContext.Provider>
      </div>
    </div>
  )

  return createPortal(portalNode, document.body)
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-header"
      className={cn('flex flex-col gap-1 border-b border-border p-4', className)}
      {...props}
    />
  )
}

function DialogTitle({ className, id, ...props }: React.ComponentProps<'h2'>) {
  const ctx = React.useContext(DialogTitleIdContext)
  React.useEffect(() => {
    if (!ctx) return
    ctx.setHasTitle(true)
    return () => ctx.setHasTitle(false)
  }, [ctx])
  return (
    <h2
      data-slot="dialog-title"
      id={id ?? ctx?.titleId}
      className={cn('text-base font-semibold', className)}
      {...props}
    />
  )
}

function DialogDescription({ className, id, ...props }: React.ComponentProps<'p'>) {
  const ctx = React.useContext(DialogTitleIdContext)
  React.useEffect(() => {
    if (!ctx) return
    ctx.setHasDescription(true)
    return () => ctx.setHasDescription(false)
  }, [ctx])
  return (
    <p
      data-slot="dialog-description"
      id={id ?? ctx?.descriptionId}
      className={cn('text-sm', className)}
      style={{ color: 'var(--muted-foreground)' }}
      {...props}
    />
  )
}

function DialogBody({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-body"
      className={cn('p-4 text-sm', className)}
      {...props}
    />
  )
}

function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        'flex flex-wrap items-center justify-end gap-2 border-t border-border p-4',
        className
      )}
      {...props}
    />
  )
}

// useConfirm hook ------------------------------------------------------------

type ConfirmOptions = {
  title: React.ReactNode
  description?: React.ReactNode
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
}

type ConfirmState = ConfirmOptions & {
  resolve: (value: boolean) => void
}

type ConfirmFn = ((options: ConfirmOptions) => Promise<boolean>) & {
  dialog: React.ReactNode
}

function useConfirm(): ConfirmFn {
  const [state, setState] = React.useState<ConfirmState | null>(null)

  const settle = React.useCallback((value: boolean) => {
    setState((current) => {
      if (current) current.resolve(value)
      return null
    })
  }, [])

  const dialog = state ? (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) settle(false)
      }}
    >
      <DialogHeader>
        <DialogTitle>{state.title}</DialogTitle>
        {state.description ? <DialogDescription>{state.description}</DialogDescription> : null}
      </DialogHeader>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => settle(false)}>
          {state.cancelLabel ?? 'Cancel'}
        </Button>
        <Button
          type="button"
          variant={state.destructive ? 'destructive' : 'primary'}
          onClick={() => settle(true)}
        >
          {state.confirmLabel ?? 'Confirm'}
        </Button>
      </DialogFooter>
    </Dialog>
  ) : null

  // `useConfirm` returns a callable function with an attached `.dialog` React
  // node. Consumers render `confirm.dialog` once in their tree; calling
  // `confirm({...})` resolves to a boolean. The returned function reference is
  // NOT stable across renders (it captures the latest `dialog`), so callers
  // should trigger the promise from an event handler rather than an effect.
  return Object.assign(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setState({ ...options, resolve })
      }),
    { dialog }
  ) as ConfirmFn
}

export {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
  useConfirm,
}
