import { useCallback, useEffect, useRef } from 'react'

/**
 * Schedules a `setTimeout` that cannot outlive the component that scheduled it.
 *
 * The bug this exists to prevent: a handler fires `setFlag(true)` and parks a
 * `setTimeout` to put the flag back, the component unmounts before the delay
 * elapses, and the timer still runs. React dispatches the state update against
 * a torn-down tree and reaches for a `window` that no longer exists. Under
 * vitest that surfaces as an unhandled rejection, which exits the run non-zero
 * with every test still passing — see `RulesPage` and the fix in PR #1103.
 *
 * The returned `schedule` keeps only the latest timer: each call cancels the
 * pending one. Every caller is a "flash a flag, then put it back" handler the
 * user can re-trigger, so the newest press owns the window.
 */
export function useUnmountSafeTimeout(): (fn: () => void, delayMs: number) => void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    // Set on mount rather than only at declaration: StrictMode runs cleanup
    // and then re-runs the effect, and a hook latched permanently inactive
    // would silently swallow every later schedule in development.
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [])

  return useCallback((fn: () => void, delayMs: number) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      if (!mountedRef.current) return
      fn()
    }, delayMs)
  }, [])
}
