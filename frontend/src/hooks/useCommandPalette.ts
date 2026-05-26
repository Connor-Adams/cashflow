/**
 * Hook owning command-palette open state + the global ⌘K / Ctrl+K listener.
 *
 * Lives in its own file so consumers can import it without dragging the
 * full `CommandPalette` component tree along — `Layout.tsx` uses the hook
 * to expose an "open palette" button while the palette itself is rendered
 * separately, which also keeps fast-refresh boundaries clean
 * (the component file then only exports components).
 *
 * Listener semantics:
 *   - fires on `keydown` at the window level, mounted once
 *   - matches `(meta|ctrl) + k` with no alt/shift modifiers
 *   - safe inside text inputs because users never type ⌘K characters there
 *   - prevents default so the browser doesn't trigger any built-in ⌘K
 *     behavior (Firefox focuses the URL bar, etc.)
 */
import { useCallback, useEffect, useState } from 'react'

export function useCommandPalette(): {
  open: boolean
  setOpen: (open: boolean) => void
  toggle: () => void
} {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    function handler(event: KeyboardEvent) {
      const isPaletteShortcut =
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        (event.key === 'k' || event.key === 'K')
      if (!isPaletteShortcut) return
      event.preventDefault()
      setOpen((prev) => !prev)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const toggle = useCallback(() => setOpen((p) => !p), [])
  return { open, setOpen, toggle }
}
