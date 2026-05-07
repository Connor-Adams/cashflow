const base = import.meta.env.VITE_API_BASE ?? ''

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
  if (!r.ok) throw new Error(await parseError(r))
  return parseJson<T>(r)
}

export async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: body != null ? JSON.stringify(body) : undefined,
  })
  if (!r.ok) throw new Error(await parseError(r))
  return parseJson<T>(r)
}

export async function patchJson<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${base}${path}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(await parseError(r))
  return parseJson<T>(r)
}

export async function deleteReq(path: string): Promise<void> {
  const r = await fetch(`${base}${path}`, { method: 'DELETE', credentials: 'include' })
  if (!r.ok && r.status !== 204) throw new Error(await parseError(r))
}

export async function postFormData<T>(path: string, form: FormData): Promise<T> {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    credentials: 'include',
    body: form,
  })
  if (!r.ok) throw new Error(await parseError(r))
  return parseJson<T>(r)
}
