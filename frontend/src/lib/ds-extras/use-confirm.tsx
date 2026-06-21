import * as React from 'react'
import { Dialog, Button } from '@connor-adams/designsystem'

/**
 * Promise-based confirm dialog over the DS Dialog. Fresh helper — the DS Dialog
 * is prop-based (open/onClose/title/description/footer) and ships no confirm hook.
 *
 * Usage: `const confirm = useConfirm()`; render `{confirm.dialog}` once; call
 * `await confirm({ title })` from an event handler to get a boolean.
 */
type ConfirmOptions = {
  title: React.ReactNode
  description?: React.ReactNode
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
}

type ConfirmState = ConfirmOptions & { resolve: (value: boolean) => void }

type ConfirmFn = ((options: ConfirmOptions) => Promise<boolean>) & {
  dialog: React.ReactNode
}

export function useConfirm(): ConfirmFn {
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
      onClose={() => settle(false)}
      title={state.title}
      description={state.description}
      footer={
        <>
          <Button variant="outline" onClick={() => settle(false)}>
            {state.cancelLabel ?? 'Cancel'}
          </Button>
          <Button
            variant={state.destructive ? 'destructive' : 'primary'}
            onClick={() => settle(true)}
          >
            {state.confirmLabel ?? 'Confirm'}
          </Button>
        </>
      }
    />
  ) : null

  return Object.assign(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setState({ ...options, resolve })
      }),
    { dialog },
  ) as ConfirmFn
}
