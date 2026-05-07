import { clientLogger } from './clientLogger'

const base = import.meta.env.VITE_API_BASE ?? ''

class ApiError extends Error {
  readonly status: number
  readonly path: string
  readonly requestId: string | null

  constructor(
    message: string,
    status: number,
    path: string,
    requestId: string | null,
  ) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.path = path
    this.requestId = requestId
  }
}

async function parseError(res: Response): Promise<string> {
  const raw = await res.text()
  if (!raw) return res.statusText

  try {
    const j = JSON.parse(raw) as { error?: string }
    return j.error ?? res.statusText
  } catch {
    return raw
  }
}

async function parseJson<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(`${base}${path}`, { credentials: 'include' })
  if (!r.ok) throw await apiError(r, path)
  return parseJson<T>(r)
}

export async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: body != null ? JSON.stringify(body) : undefined,
  })
  if (!r.ok) throw await apiError(r, path)
  return parseJson<T>(r)
}

export async function patchJson<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${base}${path}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw await apiError(r, path)
  return parseJson<T>(r)
}

export async function deleteReq(path: string): Promise<void> {
  const r = await fetch(`${base}${path}`, { method: 'DELETE', credentials: 'include' })
  if (!r.ok && r.status !== 204) throw await apiError(r, path)
}

export async function postFormData<T>(path: string, form: FormData): Promise<T> {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    credentials: 'include',
    body: form,
  })
  if (!r.ok) throw await apiError(r, path)
  return parseJson<T>(r)
}

async function apiError(res: Response, path: string): Promise<ApiError> {
  const message = await parseError(res)
  const requestId = res.headers.get('x-request-id')
  clientLogger.warn('api_request_failed', {
    apiPath: path,
    status: res.status,
    requestId,
    message,
  })
  return new ApiError(message, res.status, path, requestId)
}
