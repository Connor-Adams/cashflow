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
  const [tokenPlaintext, setTokenPlaintext] = useState<string | null>(null)
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

  async function mintNewToken() {
    if (loading) return
    setLoading(true)
    setError(null)
    try {
      const result = await mintAuditToken('Agent')
      if (!mountedRef.current) return
      setToken({
        id: result.id,
        label: result.label,
        lastUsedAt: null,
        createdAt: result.createdAt,
      })
      setTokenPlaintext(result.plaintext)
    } catch (e) {
      if (!mountedRef.current) return
      setError(e instanceof Error ? e.message : 'Mint failed')
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }

  async function revokeActiveToken() {
    if (!token) return
    const ok = await confirm({
      title: 'Revoke AI audit token?',
      description:
        'Any AI agent using this token will lose access. You can mint a new one after.',
      confirmLabel: 'Revoke',
      destructive: true,
    })
    if (!ok) return
    try {
      await revokeAuditToken(token.id)
      if (!mountedRef.current) return
      setToken(null)
      setTokenPlaintext(null)
    } catch (e) {
      if (!mountedRef.current) return
      setError(e instanceof Error ? e.message : 'Revoke failed')
    }
  }

  return (
    <>
      {confirm.dialog}
      <Card className="accountsFormCard">
        <div className="accountsCardHeader">
          <div>
            <h2>AI audit tokens</h2>
            <p className="muted">
              Mint a personal <code>cfa_</code> token and pass it as a{' '}
              <code>Bearer</code> header to{' '}
              <code>GET /api/audit/*</code> endpoints. The token grants
              read-only access to integrity probes, row counts, error
              ring-buffers, and route health — nothing is writable via
              audit tokens. Store the value in{' '}
              <code>CASHFLOW_AUDIT_TOKEN</code> in your agent environment.
            </p>
          </div>
          {token ? (
            <Button
              type="button"
              variant="destructive"
              onClick={() => void revokeActiveToken()}
            >
              Revoke token
            </Button>
          ) : (
            <Button
              type="button"
              disabled={loading}
              onClick={() => void mintNewToken()}
            >
              {loading ? 'Minting…' : 'Mint audit token'}
            </Button>
          )}
        </div>
        {error && (
          <span className="error" role="alert">
            {error}
          </span>
        )}
        {tokenPlaintext && (
          <>
            <p className="muted">
              Token created — copy it now and store it as{' '}
              <code>CASHFLOW_AUDIT_TOKEN</code>. You will not see this
              value again after leaving this page.
            </p>
            <Input
              readOnly
              autoComplete="off"
              value={tokenPlaintext}
              onFocus={(e) => e.currentTarget.select()}
            />
          </>
        )}
        {token && !tokenPlaintext && (
          <p className="muted">
            Active token: <code>{token.label}</code>
            {token.lastUsedAt && (
              <> · Last used {new Date(token.lastUsedAt).toLocaleString()}</>
            )}
          </p>
        )}
        {!token && !loading && (
          <p className="muted">No active audit token. Mint one to grant read-only audit access.</p>
        )}
      </Card>
    </>
  )
}
