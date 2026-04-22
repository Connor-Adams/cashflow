import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'

function resolveInitialValue<T>(initialValue: T | (() => T)): T {
  return typeof initialValue === 'function'
    ? (initialValue as () => T)()
    : initialValue
}

export function useSessionState<T>(
  key: string,
  initialValue: T | (() => T)
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    const fallback = resolveInitialValue(initialValue)
    if (typeof window === 'undefined') return fallback
    try {
      const raw = window.sessionStorage.getItem(key)
      return raw == null ? fallback : (JSON.parse(raw) as T)
    } catch {
      return fallback
    }
  })

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.sessionStorage.setItem(key, JSON.stringify(value))
    } catch {
      // Ignore storage failures and continue with in-memory state.
    }
  }, [key, value])

  return [value, setValue]
}
