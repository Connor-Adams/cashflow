import type { ReactNode } from 'react'
import { Alert, Button } from '@connor-adams/designsystem'

type LoadErrorAlertProps = {
  /** Short headline, e.g. "Couldn't load budgets". */
  title: ReactNode
  /** Optional detail line under the title (usually the error message). */
  children?: ReactNode
  /** When provided, renders a Retry button in the alert's action slot. */
  onRetry?: () => void
}

/**
 * Inline "this failed to load" state for a tile or section. Composes the DS
 * `Alert` (error variant) as-is, with an optional Retry in its `action` slot.
 *
 * Use it wherever a failed fetch would otherwise fall through to the empty
 * state ("No budgets", "All clear", "Nothing planned") — a failure must never
 * read as "there is no data".
 */
export function LoadErrorAlert({ title, children, onRetry }: LoadErrorAlertProps) {
  return (
    <Alert
      variant="error"
      title={title}
      action={
        onRetry ? (
          <Button size="sm" variant="outline" onClick={onRetry}>
            Retry
          </Button>
        ) : undefined
      }
    >
      {children}
    </Alert>
  )
}
