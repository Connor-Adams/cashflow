import { clientLogger } from './clientLogger'
import type {
  ContactLedgerResponse,
  TransferLinkResult,
  SelfSuggestionsResponse,
  SimplefinConnectResponse,
  SimplefinDisconnectResponse,
  SimplefinStatusResponse,
  SimplefinAccountsResponse,
  SimplefinLinkRequest,
  SimplefinLinkResponse,
  SplitTransactionRequest,
  SplitTransactionResponse,
} from '@cashflow/shared'

const base = import.meta.env.VITE_API_BASE ?? ''

export class ApiError extends Error {
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
  const r = await fetch(`${base}${path}`, { credentials: 'include', cache: 'no-store' })
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

export async function putJson<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${base}${path}`, {
    method: 'PUT',
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

export async function deleteJson<T>(path: string): Promise<T> {
  const r = await fetch(`${base}${path}`, { method: 'DELETE', credentials: 'include' })
  if (!r.ok && r.status !== 204) throw await apiError(r, path)
  return parseJson<T>(r)
}

/** Response from DELETE /api/me/account — the right-to-erasure sweep summary (issue #850). */
export type AccountErasureResponse = {
  deleted: boolean
  householdId: number
  deletedUserIds: number[]
  filesSwept: number
}

/**
 * DELETE /api/me/account — owner-gated right-to-erasure. Permanently deletes the
 * caller's household and every member, all household-scoped data, and the on-disk
 * files those rows point at. The body must echo the household name exactly
 * (the server 400s on a mismatch). On success the server clears the session
 * cookie, so the caller must redirect to the login screen.
 */
export async function deleteAccount(confirm: string): Promise<AccountErasureResponse> {
  const r = await fetch(`${base}/api/me/account`, {
    method: 'DELETE',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm }),
  })
  if (!r.ok) throw await apiError(r, '/api/me/account')
  return parseJson<AccountErasureResponse>(r)
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

// ── Per-person loan ledger client functions ──────────────────────────────────

export function getContactLedger(id: number): Promise<ContactLedgerResponse> {
  return getJson<ContactLedgerResponse>(`/api/contacts/${id}/ledger`)
}
export function previewTransferLink(): Promise<TransferLinkResult> {
  return postJson<TransferLinkResult>('/api/transfer-link/preview')
}
export function commitTransferLink(): Promise<TransferLinkResult> {
  return postJson<TransferLinkResult>('/api/transfer-link/commit')
}
export function markTransactionAsLoan(txnId: number, contactId: number): Promise<unknown> {
  return postJson(`/api/transactions/${txnId}/reimbursable`, { contactId })
}
export function setTransactionContact(txnId: number, contactId: number): Promise<unknown> {
  return patchJson(`/api/transactions/${txnId}`, { counterpartyContactId: contactId })
}
export function getSelfSuggestions(): Promise<SelfSuggestionsResponse> {
  return getJson<SelfSuggestionsResponse>('/api/contacts/self-suggestions')
}
export function setContactSelf(id: number, isSelf: boolean): Promise<unknown> {
  return patchJson(`/api/contacts/${id}`, { isSelf })
}

// SimpleFIN Bridge bank connection (issue #790)
export function getSimplefinStatus(): Promise<SimplefinStatusResponse> {
  return getJson<SimplefinStatusResponse>('/api/simplefin/status')
}
export function connectSimplefin(setupToken: string): Promise<SimplefinConnectResponse> {
  return postJson<SimplefinConnectResponse>('/api/simplefin/connect', { setupToken })
}
export function disconnectSimplefin(): Promise<SimplefinDisconnectResponse> {
  return postJson<SimplefinDisconnectResponse>('/api/simplefin/disconnect')
}

// SimpleFIN explicit account mapping (issue #813)
export function getSimplefinAccounts(): Promise<SimplefinAccountsResponse> {
  return getJson<SimplefinAccountsResponse>('/api/simplefin/accounts')
}
export function linkSimplefinAccount(
  simplefinId: string,
  body: SimplefinLinkRequest,
): Promise<SimplefinLinkResponse> {
  return postJson<SimplefinLinkResponse>(
    `/api/simplefin/accounts/${encodeURIComponent(simplefinId)}/link`,
    body,
  )
}
export function unlinkSimplefinAccount(simplefinId: string): Promise<SimplefinLinkResponse> {
  return deleteJson<SimplefinLinkResponse>(
    `/api/simplefin/accounts/${encodeURIComponent(simplefinId)}/link`,
  )
}

// ── Multiway split ────────────────────────────────────────────────────────────

export function splitTransaction(
  txnId: number,
  body: SplitTransactionRequest,
): Promise<SplitTransactionResponse> {
  return postJson<SplitTransactionResponse>(`/api/transactions/${txnId}/split`, body)
}

export function unsplitTransaction(txnId: number): Promise<SplitTransactionResponse> {
  return deleteJson<SplitTransactionResponse>(`/api/transactions/${txnId}/split`)
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
