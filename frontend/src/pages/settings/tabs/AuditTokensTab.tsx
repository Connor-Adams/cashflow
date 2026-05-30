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

  const [tokens, setTokens] = useState<AuditTokenRow[]>([])
  const [plaintext, setPlaintext] = useState<string | null>(null)
  const [label, setLabel] = useState('Audit')
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
        setTokens(rows)
      } catch (e) {
        if (!mountedRef.current) return
        setError(e instanceof Error ? e.message : 'Could not load audit tokens')
      }
    })()
  }, [])

  async function mintToken() {
    if (loading) return
    setLoading(true)
    setError(null)
    setPlaintext(null)
    try {
      const result = await mintAuditToken(label.trim() || 'Audit')
      if (!mountedRef.current) return
      setTokens((prev) => [
        { id: result.id, label: result.label, lastUsedAt: null, createdAt: result.createdAt },
        ...prev,
      ])
      setPlaintext(result.plaintext)
      setLabel('Audit')
    } catch (e) {
      if (!mountedRef.current) return
      setError(e instanceof Error ? e.message : 'Mint failed')
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }

  async function revokeToken(token: AuditTokenRow) {
    const ok = await confirm({
      title: 'Revoke AI audit token?',
      description: `Any agent using "${token.label}" will lose access immediately. You can mint a new one afterwards.`,
      confirmLabel: 'Revoke',
      destructive: true,
    })
    if (!ok) return
    try {
      await revokeAuditToken(token.id)
      if (!mountedRef.current) return
      setTokens((prev) => prev.filter((t) => t.id !== token.id))
      if (plaintext) setPlaintext(null)
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
              Audit tokens grant an AI agent read-only access to system health, data integrity,
              and pipeline freshness so it can verify production is working correctly after a
              deploy. Tokens use the <code>cfa_</code> prefix and never carry write permissions.
              Store the token as <code>CASHFLOW_AUDIT_TOKEN</code> in your agent&apos;s
              environment.
            </p>
          </div>
        </div>

        {error && (
          <span className="error" role="alert">
            {error}
          </span>
        )}

        {/* ── Mint form ─────────────────────────────────────────────────── */}
        <div className="formGrid" style={{ gap: '0.5rem', marginBottom: '1rem' }}>
          <label htmlFor="audit-token-label">
            Token label
            <Input
              id="audit-token-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              disabled={loading}
              placeholder="Audit"
              maxLength={64}
            />
          </label>
          <Button
            type="button"
            disabled={loading}
            onClick={() => void mintToken()}
            style={{ alignSelf: 'flex-end' }}
          >
            {loading ? 'Minting…' : 'Mint audit token'}
          </Button>
        </div>

        {/* ── Plaintext reveal ──────────────────────────────────────────── */}
        {plaintext && (
          <div
            style={{
              padding: '0.75rem',
              marginBottom: '1rem',
              border: '1px solid var(--warning, #d97706)',
              borderRadius: 'var(--radius-md, 6px)',
              background: 'var(--warning-subtle, rgba(217,119,6,0.08))',
            }}
          >
            <p style={{ marginBottom: '0.5rem', fontWeight: 600 }}>
              Save this token now — it will not be shown again.
            </p>
            <Input
              readOnly
              autoComplete="off"
              value={plaintext}
              onFocus={(e) => e.currentTarget.select()}
              style={{ fontFamily: 'monospace', marginBottom: '0.5rem' }}
            />
            <p className="muted" style={{ fontSize: '0.85rem' }}>
              Store it as <code>CASHFLOW_AUDIT_TOKEN</code> in your agent&apos;s environment.
            </p>
            <Button
              type="button"
              variant="secondary"
              onClick={() => void navigator.clipboard.writeText(plaintext)}
            >
              Copy to clipboard
            </Button>
            <Button
              type="button"
              variant="ghost"
              style={{ marginLeft: '0.5rem' }}
              onClick={() => setPlaintext(null)}
            >
              Dismiss
            </Button>
          </div>
        )}

        {/* ── Token list ────────────────────────────────────────────────── */}
        {tokens.length === 0 ? (
          <p className="muted">No active audit tokens.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {tokens.map((token) => (
              <div
                key={token.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.75rem',
                  padding: '0.5rem 0.75rem',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md, 6px)',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <strong>{token.label}</strong>
                  <span className="muted" style={{ marginLeft: '0.75rem', fontSize: '0.85rem' }}>
                    Created {new Date(token.createdAt).toLocaleDateString()}
                  </span>
                  {token.lastUsedAt && (
                    <span className="muted" style={{ marginLeft: '0.5rem', fontSize: '0.85rem' }}>
                      · Last used {new Date(token.lastUsedAt).toLocaleString()}
                    </span>
                  )}
                </div>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => void revokeToken(token)}
                >
                  Revoke
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  )
}
