import type { ClientLogLevel, ClientLogPayload } from '@cashflow/shared'

const base = import.meta.env.VITE_API_BASE ?? ''
const endpoint = `${base}/api/client-logs`

function toMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return undefined
}

function normalizeFields(fields: Record<string, unknown> = {}) {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (
      value == null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      out[key] = value
    }
  }
  return out
}

function emit(payload: ClientLogPayload): void {
  const body = JSON.stringify({
    ...payload,
    path: payload.path ?? window.location.pathname,
    fields: normalizeFields(payload.fields),
  })

  void fetch(endpoint, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => {
    if (import.meta.env.DEV) {
      console.warn('[client-log] failed to send log')
    }
  })
}

export const clientLogger = {
  log(level: ClientLogLevel, event: string, fields: Record<string, unknown> = {}) {
    emit({ level, event, fields })
  },
  error(event: string, error: unknown, fields: Record<string, unknown> = {}) {
    emit({
      level: 'error',
      event,
      message: toMessage(error),
      fields: {
        ...fields,
        errorName: error instanceof Error ? error.name : undefined,
      },
    })
  },
  warn(event: string, fields: Record<string, unknown> = {}) {
    emit({ level: 'warn', event, fields })
  },
}

export function installGlobalClientLogging(): void {
  window.addEventListener('error', (event) => {
    clientLogger.error('window_error', event.error ?? event.message, {
      source: event.filename,
      line: event.lineno,
      column: event.colno,
    })
  })

  window.addEventListener('unhandledrejection', (event) => {
    clientLogger.error('unhandled_rejection', event.reason)
  })
}
