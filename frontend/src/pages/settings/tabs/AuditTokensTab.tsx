import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useConfirm } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/toast'
import { listAuditTokens, mintAuditToken, revokeAuditToken, type AuditTokenRow } from '../../../lib/auditTokens'

export function AuditTokensTab() {
  const [tokens, setTokens] = useState<AuditTokenRow[]>([])
  const [loading, setLoading] = useState(true)
  const [mintLabel, setMintLabel] = useState('Audit')
  const [minting, setMinting] = useState(false)
  const [newPlaintext, setNewPlaintext] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const confirm = useConfirm()
  const { showToast } = useToast()

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const rows = await listAuditTokens()
      if (!mountedRef.current) return
      setTokens(rows)
    } catch (e) {
      if (!mountedRef.current) return
      setErr(e instanceof Error ? e.message : 'Could not load audit tokens')
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  async function mint() {
    if (minting) return
    setMinting(true)
    setErr(null)
    setNewPlaintext(null)
    try {
      const result = await mintAuditToken(mintLabel.trim() || 'Audit')
      if (!mountedRef.current) return
      setNewPlaintext(result.plaintext)
      setMintLabel('Audit')
      await load()
    } catch (e) {
      if (!mountedRef.current) return
      setErr(e instanceof Error ? e.message : 'Mint failed')
    } finally {
      if (mountedRef.current) setMinting(false)
    }
  }

  async function revoke(token: AuditTokenRow) {
    const ok = await confirm({
      title: 'Revoke audit token?',
      description: `"${token.label}" will stop working immediately. Any agent using it will need a new token.`,
      confirmLabel: 'Revoke',
      destructive: true,
    })
    if (!ok) return
    try {
      await revokeAuditToken(token.id)
      if (!mountedRef.current) return
      setTokens((ts) => ts.filter((t) => t.id !== token.id))
      showToast({ title: 'Token revoked.' })
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Revoke failed')
    }
  }

  return (
    <>
      {confirm.dialog}
      <div className="page space-y-4">
        <Card className="accountsFormCard">
          <h2>AI audit tokens</h2>
          <p className="muted">
            Audit tokens grant an AI agent read-only access to system health, data integrity, and pipeline
            freshness — so it can verify production is working correctly after a deploy. Tokens are prefixed
            <code> cfa_</code>. Store them as <code>CASHFLOW_AUDIT_TOKEN</code> in your agent's environment.
          </p>

          {err && <p className="error" role="alert">{err}</p>}

          {newPlaintext && (
            <Card style={{ background: 'var(--warning-bg, #fef9c3)', padding: '1rem', marginBottom: '1rem' }}>
              <p style={{ fontWeight: 600 }}>Save this token now — it will not be shown again.</p>
              <code style={{ display: 'block', wordBreak: 'break-all', margin: '0.5rem 0' }}>{newPlaintext}</code>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void navigator.clipboard.writeText(newPlaintext).then(() => showToast({ title: 'Copied!' }))}
                >
                  Copy
                </Button>
                <Button type="button" size="sm" variant="secondary" onClick={() => setNewPlaintext(null)}>
                  Dismiss
                </Button>
              </div>
            </Card>
          )}

          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end' }}>
            <Label>
              Label
              <Input
                value={mintLabel}
                onChange={(e) => setMintLabel(e.target.value)}
                placeholder="Audit"
                maxLength={64}
                style={{ width: '14rem' }}
              />
            </Label>
            <Button type="button" onClick={() => void mint()} disabled={minting}>
              {minting ? 'Minting…' : 'Mint token'}
            </Button>
          </div>
        </Card>

        <Card className="accountsFormCard">
          <h2>Active tokens</h2>
          {loading ? (
            <p className="muted">Loading…</p>
          ) : tokens.length === 0 ? (
            <p className="muted">No active audit tokens. Mint one above.</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: '0.5rem 0' }}>Label</th>
                  <th style={{ textAlign: 'left', padding: '0.5rem 0' }}>Created</th>
                  <th style={{ textAlign: 'left', padding: '0.5rem 0' }}>Last used</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {tokens.map((t) => (
                  <tr key={t.id} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '0.5rem 0' }}>{t.label}</td>
                    <td style={{ padding: '0.5rem 0' }} className="muted">{new Date(t.createdAt).toLocaleDateString()}</td>
                    <td style={{ padding: '0.5rem 0' }} className="muted">
                      {t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleDateString() : '—'}
                    </td>
                    <td style={{ padding: '0.5rem 0', textAlign: 'right' }}>
                      <Button type="button" size="sm" variant="destructive" onClick={() => void revoke(t)}>
                        Revoke
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  )
}
