import { deleteReq, getJson, postJson } from './api'

export interface CaptureTokenRow {
  id: number
  label: string
  lastUsedAt: string | null
  createdAt: string
  expiresAt: string | null
}

export interface CaptureTokenMintResult {
  id: number
  plaintext: string
  label: string
  createdAt: string
  expiresAt: string | null
}

export function listCaptureTokens(): Promise<CaptureTokenRow[]> {
  return getJson<CaptureTokenRow[]>('/api/capture/tokens')
}

export function mintCaptureToken(label: string): Promise<CaptureTokenMintResult> {
  return postJson<CaptureTokenMintResult>('/api/capture/tokens', { label })
}

export function revokeCaptureToken(id: number): Promise<void> {
  return deleteReq(`/api/capture/tokens/${id}`)
}
