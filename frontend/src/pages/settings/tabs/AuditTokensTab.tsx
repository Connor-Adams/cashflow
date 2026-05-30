import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { useConfirm } from '@/components/ui/dialog'
import {
  listAuditTokens,
  mintAuditToken,
  revokeAuditToken,
  type AuditTokenRow,
} from '../../../lib/auditTokens'

export function AuditTokensTab() {
  const confirm = useConfirm()
  const [token, setToken] = useState<AuditTokenRow | null>(null)
  const [plaintext, setPlaintext] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        const rows = await listAuditTokens()
        if (!mountedRef.current) return
        setToken(rows[0] ?? null)
      } catch (e) {
        if (!mountedRef.current) return
        setError(e instanceof Error ? e.message : 'Could not load audit tokens')
      }
    })()
  }, [])

  async function mintNew() {
    if (loading) return
    setLoading(true)
    setError(null)
    try {
      const result = await mintAuditToken('AI agent')
      if (!mountedRef.current) return
      setToken({ id: result.id, label: result.label, lastUsedAt: null, createdAt: result.createdAt })
      setPlaintext(result.plaintext)
    } catch (e) {
      if (!mountedRef.current) return
      setError(e instanceof Error ? e.message : 'Could not mint audit token')
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }

  async function revokeActive() {
    if (!token) return
    const ok = await confirm('Revoke this audit token? Any AI agent using it will lose access.')
    if (!ok) return
    try {
      await revokeAuditToken(token.id)
      if (!mountedRef.current) return
      setToken(null)
      setPlaintext(null)
    } catch (e) {
      if (!mountedRef.current) return
      setError(e instanceof Error ? e.message : 'Could not revoke audit token')
    }
  }

  return (
    <Card className="p-4 flex flex-col gap-3">
      <div className="accountsCardHeader">
        <div>
          <h2>AI audit token</h2>
          <p className="muted">
            Audit tokens grant an AI agent read-only access to system health, data integrity, and
            pipeline freshness signals so it can verify production is working correctly after a
            deploy.
          </p>
        </div>
        {token ? (
          <Button type="button" variant="destructive" onClick={() => void revokeActive()}>
            Revoke token
          </Button>
        ) : (
          <Button type="button" disabled={loading} onClick={() => void mintNew()}>
            {loading ? 'Minting…' : 'Mint audit token'}
          </Button>
        )}
      </div>
      {error && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
      {plaintext && (
        <>
          <p className="muted">
            Save this token now — it won&apos;t be shown again after you leave this page.
          </p>
          <Input
            readOnly
            autoComplete="off"
            value={plaintext}
            onFocus={(e) => e.currentTarget.select()}
          />
        </>
      )}
      {token && !plaintext && (
        <p className="muted">
          Active token: <code>{token.label}</code>
          {token.lastUsedAt && (
            <> · Last used {new Date(token.lastUsedAt).toLocaleString()}</>
          )}
        </p>
      )}
    </Card>
  )
}
