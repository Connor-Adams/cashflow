import { useCallback, useEffect, useRef, useState } from 'react'
import { Copy, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { useToast } from '@/components/ui/toast'
import { deleteReq, getJson, postJson } from '../../../lib/api'

type AuditToken = {
  id: number
  label: string
  lastUsedAt: string | null
  createdAt: string
}

type MintResponse = {
  id: number
  plaintext: string
  label: string
  createdAt: string
}

function formatDate(iso: string | null): string {
  if (!iso) return 'Never'
  return new Date(iso).toLocaleString()
}

export function AuditTokensTab() {
  const { showToast } = useToast()
  const [tokens, setTokens] = useState<AuditToken[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [label, setLabel] = useState('Audit')
  const [minting, setMinting] = useState(false)
  const [revealed, setRevealed] = useState<{ id: number; plaintext: string } | null>(null)
  const plaintextRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setErr(null)
    try {
      const rows = await getJson<AuditToken[]>('/api/audit/tokens')
      setTokens(rows)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load audit tokens')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function mint() {
    if (minting) return
    setMinting(true)
    try {
      const res = await postJson<MintResponse>('/api/audit/tokens', { label: label.trim() || 'Audit' })
      setRevealed({ id: res.id, plaintext: res.plaintext })
      await load()
    } catch (e) {
      showToast({ title: e instanceof Error ? e.message : 'Could not mint token', variant: 'destructive' })
    } finally {
      setMinting(false)
    }
  }

  async function revoke(token: AuditToken) {
    try {
      await deleteReq(`/api/audit/tokens/${token.id}`)
      if (revealed?.id === token.id) setRevealed(null)
      await load()
    } catch (e) {
      showToast({ title: e instanceof Error ? e.message : 'Could not revoke token', variant: 'destructive' })
    }
  }

  function copyPlaintext() {
    if (!revealed) return
    void navigator.clipboard.writeText(revealed.plaintext)
    showToast({ title: 'Token copied to clipboard' })
  }

  if (loading) return <p className="text-sm text-muted-foreground p-4">Loading…</p>
  if (err) return <p className="text-sm text-destructive p-4">{err}</p>

  return (
    <div className="space-y-6 p-4">
      <div className="max-w-prose">
        <h2 className="text-base font-semibold mb-1">AI audit tokens</h2>
        <p className="text-sm text-muted-foreground">
          Audit tokens grant an AI agent read-only access to system health, data integrity,
          and pipeline freshness so it can verify production is working correctly after a
          deploy. Tokens begin with <code className="font-mono text-xs">cfa_</code> and
          only work for GET requests on <code className="font-mono text-xs">/api/audit/*</code>.
        </p>
      </div>

      {revealed && (
        <Card className="p-4 space-y-2 border-warning bg-warning-bg">
          <p className="text-sm font-medium text-warning">
            Save this token now — it will not be shown again. Store it as{' '}
            <code className="font-mono text-xs">CASHFLOW_AUDIT_TOKEN</code> in your agent's environment.
          </p>
          <div className="flex items-center gap-2">
            <input
              ref={plaintextRef}
              readOnly
              value={revealed.plaintext}
              className="flex-1 font-mono text-xs bg-card border rounded px-2 py-1 select-all"
              onFocus={(e) => e.target.select()}
            />
            <Button size="sm" variant="outline" onClick={copyPlaintext}>
              <Copy className="h-3.5 w-3.5 mr-1" />
              Copy
            </Button>
          </div>
          <Button
            type="button"
            variant="link"
            className="text-xs text-warning underline"
            onClick={() => setRevealed(null)}
          >
            I've saved it — dismiss
          </Button>
        </Card>
      )}

      <Card className="p-4">
        <h3 className="text-sm font-medium mb-3">Mint a new token</h3>
        <div className="flex items-center gap-2">
          <input
            className="flex-1 border rounded px-2 py-1 text-sm"
            placeholder="Label (e.g. CI agent)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={64}
          />
          <Button size="sm" onClick={mint} disabled={minting}>
            {minting ? 'Minting…' : 'Mint token'}
          </Button>
        </div>
      </Card>

      {tokens.length === 0 ? (
        <EmptyState title="No active audit tokens" description="Mint a token above to get started." />
      ) : (
        <Card>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground text-xs">
                <th className="px-4 py-2 font-medium">Label</th>
                <th className="px-4 py-2 font-medium">Created</th>
                <th className="px-4 py-2 font-medium">Last used</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.id} className="border-b last:border-0">
                  <td className="px-4 py-2 font-medium">{t.label}</td>
                  <td className="px-4 py-2 text-muted-foreground">{formatDate(t.createdAt)}</td>
                  <td className="px-4 py-2 text-muted-foreground">{formatDate(t.lastUsedAt)}</td>
                  <td className="px-4 py-2 text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      onClick={() => void revoke(t)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  )
}
