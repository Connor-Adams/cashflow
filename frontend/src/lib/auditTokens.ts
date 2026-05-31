import { deleteReq, getJson, postJson } from './api'

export interface AuditTokenRow {
  id: number
  label: string
  lastUsedAt: string | null
  createdAt: string
}

export interface AuditTokenMintResult {
  id: number
  plaintext: string
  label: string
  createdAt: string
}

export function listAuditTokens(): Promise<AuditTokenRow[]> {
  return getJson<AuditTokenRow[]>('/api/audit/tokens')
}

export function mintAuditToken(label: string): Promise<AuditTokenMintResult> {
  return postJson<AuditTokenMintResult>('/api/audit/tokens', { label })
}

export function revokeAuditToken(id: number): Promise<void> {
  return deleteReq(`/api/audit/tokens/${id}`)
}
