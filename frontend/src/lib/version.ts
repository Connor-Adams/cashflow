import { useEffect, useState } from 'react'

export const FRONTEND_VERSION: string = import.meta.env.VITE_APP_VERSION ?? 'dev'

type BackendVersionState =
  | { status: 'loading' }
  | { status: 'ok'; version: string }
  | { status: 'error' }

export function useBackendVersion(): BackendVersionState {
  const [state, setState] = useState<BackendVersionState>({ status: 'loading' })

  useEffect(() => {
    const base = import.meta.env.VITE_API_BASE ?? ''
    const controller = new AbortController()
    fetch(`${base}/api/version`, { signal: controller.signal })
      .then((res) => (res.ok ? (res.json() as Promise<{ version: string }>) : Promise.reject(new Error(`status ${res.status}`))))
      .then((body) => setState({ status: 'ok', version: body.version }))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setState({ status: 'error' })
      })
    return () => controller.abort()
  }, [])

  return state
}
