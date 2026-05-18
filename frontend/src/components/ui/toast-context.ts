import { createContext } from 'react'

export type ToastVariant = 'default' | 'success' | 'warning' | 'destructive'

export type ToastAction = {
  label: string
  onClick: () => void
}

export type ToastOptions = {
  title: React.ReactNode
  description?: React.ReactNode
  variant?: ToastVariant
  action?: ToastAction
  durationMs?: number
}

export type ToastRecord = ToastOptions & {
  id: string
  variant: ToastVariant
  durationMs: number
}

export type ToastContextValue = {
  showToast: (options: ToastOptions) => string
  dismissToast: (id: string) => void
  toasts: ToastRecord[]
}

export const ToastContext = createContext<ToastContextValue | null>(null)

export const DEFAULT_TOAST_DURATION_MS = 5000
export const MAX_VISIBLE_TOASTS = 3
