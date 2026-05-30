import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { useConfirm } from '@/components/ui/dialog'
import { getJson, postJson, deleteReq } from '../../../lib/api'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AuditTokenRow {
  id: number
  label: string
  createdAt: string
  lastUsedAt: string | null
}

interface AuditTokenMintResult {
  id: number
  plaintext: string
  label: string
  createdAt: string
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AuditTokensTab() {
  const confirm = useConfirm()

  const [tokens, setTokens] = useState<AuditTokenRow[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)

  const [mintLabel, setMintLabel] = useState('Audit')
  const [minting, setMinting] = useState(false)
  const [mintError, setMintError] = useState<string | null>(null)

  const [newPlaintext, setNewPlaintext] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const [revokingId, setRevokingId] = useState<number | null>(null)

  const mountedRef = useRef(true)
  useEffect(() => {
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Load tokens on mount
  useEffect(() => {
    void (async () => {
      try {
        const rows = await getJson<AuditTokenRow[]>('/api/audit/tokens')
        if (!mountedRef.current) return
        setTokens(rows)
      } catch (e) {
        if (!mountedRef.current) return
        setListError(e instanceof Error ? e.message : 'Could not load audit tokens')
      } finally {
        if (mountedRef.current) setLoading(false)
      }
    })()
  }, [])

  async function handleMint() {
    if (minting) return
    setMinting(true)
    setMintError(null)
    setNewPlaintext(null)
    setCopied(false)
    try {
      const result = await postJson<AuditTokenMintResult>('/api/audit/tokens', {
        label: mintLabel.trim() || 'Audit',
      })
      if (!mountedRef.current) return
      setTokens((prev) => [
        { id: result.id, label: result.label, createdAt: result.createdAt, lastUsedAt: null },
        ...prev,
      ])
      setNewPlaintext(result.plaintext)
      setMintLabel('Audit')
    } catch (e) {
      if (!mountedRef.current) return
      setMintError(e instanceof Error ? e.message : 'Mint failed')
    } finally {
      if (mountedRef.current) setMinting(false)
    }
  }

  async function handleRevoke(token: AuditTokenRow) {
    const ok = await confirm({
      title: 'Revoke audit token?',
      description: `"${token.label}" will stop working immediately. This cannot be undone.`,
      confirmLabel: 'Revoke',
      destructive: true,
    })
    if (!ok) return
    setRevokingId(token.id)
    try {
      await deleteReq(`/api/audit/tokens/${token.id}`)
      if (!mountedRef.current) return
      setTokens((prev) => prev.filter((t) => t.id !== token.id))
      if (newPlaintext !== null) {
        // If the just-minted token was revoked, clear its plaintext reveal
        setNewPlaintext(null)
        setCopied(false)
      }
    } catch (e) {
      if (!mountedRef.current) return
      setListError(e instanceof Error ? e.message : 'Revoke failed')
    } finally {
      if (mountedRef.current) setRevokingId(null)
    }
  }

  async function handleCopy() {
    if (!newPlaintext) return
    try {
      await navigator.clipboard.writeText(newPlaintext)
      setCopied(true)
    } catch {
      // Fallback: select the text block so the user can copy manually
    }
  }

  function dismissReveal() {
    setNewPlaintext(null)
    setCopied(false)
  }

  return (
    <>
      {confirm.dialog}

      {/* ── Intro ─────────────────────────────────────────────────────────── */}
      <Card className="accountsFormCard">
        <div className="accountsCardHeader">
          <div>
            <h2>AI Audit Tokens</h2>
            <p className="muted">
              Audit tokens grant an AI agent read-only access to system health, data integrity, and
              pipeline freshness so it can verify production is working correctly after a deploy.
              Store your token as <code>CASHFLOW_AUDIT_TOKEN</code> in your agent's environment.
            </p>
          </div>
        </div>

        {/* ── Mint form ──────────────────────────────────────────────────── */}
        <div className="formGrid" style={{ gap: '0.75rem' }}>
          <div className="row" style={{ gap: '0.5rem', alignItems: 'flex-end' }}>
            <label htmlFor="audit-token-label" style={{ flex: 1 }}>
              Label
              <Input
                id="audit-token-label"
                value={mintLabel}
                onChange={(e) => setMintLabel(e.target.value)}
                disabled={minting}
                placeholder="Audit"
                style={{ marginTop: '0.25rem' }}
              />
            </label>
            <Button
              type="button"
              disabled={minting}
              onClick={() => void handleMint()}
            >
              {minting ? 'Minting…' : 'Mint token'}
            </Button>
          </div>
          {mintError && (
            <span className="error" role="alert">
              {mintError}
            </span>
          )}
        </div>

        {/* ── One-time plaintext reveal ──────────────────────────────────── */}
        {newPlaintext && (
          <div
            style={{
              marginTop: '1rem',
              padding: '0.75rem 1rem',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md, 6px)',
              background: 'var(--surface-raised, var(--bg))',
            }}
          >
            <p style={{ margin: '0 0 0.4rem', fontWeight: 600 }}>
              Save this token now — it will not be shown again.
            </p>
            <pre
              style={{
                margin: '0 0 0.6rem',
                padding: '0.5rem 0.75rem',
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md, 6px)',
                fontFamily: 'monospace',
                fontSize: '0.85rem',
                wordBreak: 'break-all',
                whiteSpace: 'pre-wrap',
                overflowX: 'auto',
              }}
            >
              {newPlaintext}
            </pre>
            <div className="row" style={{ gap: '0.5rem' }}>
              <Button
                type="button"
                variant="secondary"
                onClick={() => void handleCopy()}
              >
                {copied ? 'Copied!' : 'Copy to clipboard'}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={dismissReveal}
              >
                Dismiss
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* ── Token list ────────────────────────────────────────────────────── */}
      <Card className="accountsFormCard">
        <div className="accountsCardHeader">
          <div>
            <h2>Active tokens</h2>
          </div>
        </div>

        {listError && (
          <span className="error" role="alert">
            {listError}
          </span>
        )}

        {loading ? (
          <p className="muted">Loading…</p>
        ) : tokens.length === 0 ? (
          <p className="muted">No audit tokens yet. Mint one above.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {tokens.map((token) => (
              <div
                key={token.id}
                className="row"
                style={{
                  alignItems: 'center',
                  gap: '0.75rem',
                  padding: '0.5rem 0.75rem',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md, 6px)',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <strong style={{ display: 'block' }}>{token.label}</strong>
                  <span className="muted" style={{ fontSize: '0.8rem' }}>
                    Created {new Date(token.createdAt).toLocaleString()}
                    {token.lastUsedAt
                      ? ` · Last used ${new Date(token.lastUsedAt).toLocaleString()}`
                      : ' · Never used'}
                  </span>
                </div>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={revokingId === token.id}
                  onClick={() => void handleRevoke(token)}
                >
                  {revokingId === token.id ? 'Revoking…' : 'Revoke'}
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  )
}
