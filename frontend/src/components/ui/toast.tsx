/* eslint-disable react-refresh/only-export-components */
import * as React from 'react'
import { createPortal } from 'react-dom'
import { Button, Toast, type ToastProps } from '@connor-adams/designsystem'
import { cn } from '@/lib/utils'
import {
  DEFAULT_TOAST_DURATION_MS,
  MAX_VISIBLE_TOASTS,
  ToastContext,
  type ToastContextValue,
  type ToastOptions,
  type ToastRecord,
  type ToastVariant,
} from './toast-context'

function makeToastId() {
  return `toast-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`
}

// Map the app's toast variants onto the DS Toast's semantic accent variants.
function dsVariant(variant: ToastVariant): NonNullable<ToastProps['variant']> {
  switch (variant) {
    case 'destructive':
      return 'error'
    case 'success':
      return 'success'
    case 'warning':
      return 'warning'
    default:
      return 'default'
  }
}

function toastRole(variant: ToastVariant): 'status' | 'alert' {
  return variant === 'warning' || variant === 'destructive' ? 'alert' : 'status'
}

type ToastItemProps = {
  toast: ToastRecord
  onDismiss: (id: string) => void
}

function ToastItem({ toast, onDismiss }: ToastItemProps) {
  const [isMounted, setIsMounted] = React.useState(false)
  const [isPaused, setIsPaused] = React.useState(false)
  const dismissRef = React.useRef(onDismiss)
  React.useEffect(() => {
    dismissRef.current = onDismiss
  }, [onDismiss])

  // Slide-in animation: flip mounted flag on next frame so transition runs.
  React.useEffect(() => {
    const id = window.requestAnimationFrame(() => setIsMounted(true))
    return () => window.cancelAnimationFrame(id)
  }, [])

  // Auto-dismiss timer.
  React.useEffect(() => {
    if (toast.durationMs === Infinity) return
    if (isPaused) return
    const timeoutId = window.setTimeout(() => {
      dismissRef.current(toast.id)
    }, toast.durationMs)
    return () => window.clearTimeout(timeoutId)
  }, [toast.durationMs, toast.id, isPaused])

  const role = toastRole(toast.variant)

  // The DS Toast renders the presentational card (semantic accent, surface,
  // shadow, dismiss button). We keep ownership of timing, stacking, pause, the
  // slide-in animation, and the app's accessibility + test contract — so the
  // outer wrapper carries role/aria-live and the data-slot hooks, while the DS
  // Toast handles the look. (ToastProps is a closed interface and doesn't
  // accept arbitrary DOM/aria props, so they live on the wrapper.)
  return (
    <div
      data-slot="toast"
      data-variant={toast.variant}
      role={role}
      aria-live={role === 'alert' ? 'assertive' : 'polite'}
      aria-atomic="true"
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
      onFocus={() => setIsPaused(true)}
      onBlur={() => setIsPaused(false)}
      className={cn(
        'pointer-events-auto w-full max-w-sm transition-all duration-200 ease-out',
        isMounted ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'
      )}
    >
      <Toast
        className="w-full"
        variant={dsVariant(toast.variant)}
        title={toast.title}
        onClose={() => dismissRef.current(toast.id)}
        action={
          toast.action ? (
            <Button
              type="button"
              data-slot="toast-action"
              variant="outline"
              size="sm"
              onClick={() => {
                toast.action?.onClick()
                dismissRef.current(toast.id)
              }}
            >
              {toast.action.label}
            </Button>
          ) : undefined
        }
      >
        {toast.description}
      </Toast>
    </div>
  )
}

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: ToastRecord[]
  onDismiss: (id: string) => void
}) {
  if (typeof document === 'undefined') return null
  const visible = toasts.slice(-MAX_VISIBLE_TOASTS)
  return createPortal(
    // WCAG 2.1 AA 2.5.5: on mobile (<768px) anchor higher to avoid blocking bottom-anchored UI.
    <div
      data-slot="toast-viewport"
      className="pointer-events-none fixed bottom-20 right-4 md:bottom-4 z-60 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
    >
      {visible.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>,
    document.body
  )
}

function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<ToastRecord[]>([])

  const dismissToast = React.useCallback((id: string) => {
    setToasts((current) => current.filter((t) => t.id !== id))
  }, [])

  const showToast = React.useCallback((options: ToastOptions) => {
    const id = makeToastId()
    const record: ToastRecord = {
      id,
      title: options.title,
      description: options.description,
      action: options.action,
      variant: options.variant ?? 'default',
      durationMs: options.durationMs ?? DEFAULT_TOAST_DURATION_MS,
    }
    setToasts((current) => [...current, record])
    return id
  }, [])

  // ESC dismisses the top (most recent) toast.
  React.useEffect(() => {
    if (toasts.length === 0) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      setToasts((current) => {
        if (current.length === 0) return current
        return current.slice(0, -1)
      })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [toasts.length])

  const value = React.useMemo<ToastContextValue>(
    () => ({ showToast, dismissToast, toasts }),
    [showToast, dismissToast, toasts]
  )

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismissToast} />
    </ToastContext.Provider>
  )
}

function useToast() {
  const ctx = React.useContext(ToastContext)
  if (!ctx) {
    throw new Error('useToast must be used inside a ToastProvider')
  }
  return { showToast: ctx.showToast, dismissToast: ctx.dismissToast }
}

export { ToastProvider, useToast }
