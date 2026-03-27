const base = import.meta.env.VITE_API_BASE ?? ''

async function parseError(res: Response): Promise<string> {
  try {
    const j = await res.json()
    return (j as { error?: string }).error ?? res.statusText
  } catch {
    return await res.text()
  }
}

export async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(`${base}${path}`)
  if (!r.ok) throw new Error(await parseError(r))
  return r.json() as Promise<T>
}

export async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body != null ? JSON.stringify(body) : undefined,
  })
  if (!r.ok) throw new Error(await parseError(r))
  return r.json() as Promise<T>
}

export async function patchJson<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${base}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(await parseError(r))
  return r.json() as Promise<T>
}

export async function deleteReq(path: string): Promise<void> {
  const r = await fetch(`${base}${path}`, { method: 'DELETE' })
  if (!r.ok && r.status !== 204) throw new Error(await parseError(r))
}

export async function postFormData<T>(path: string, form: FormData): Promise<T> {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    body: form,
  })
  if (!r.ok) throw new Error(await parseError(r))
  return r.json() as Promise<T>
}
