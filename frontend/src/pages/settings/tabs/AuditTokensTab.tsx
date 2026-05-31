import { useEffect, useState } from 'react'
import { Copy, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/toast'
import { deleteReq, getJson, postJson } from '../../../lib/api'

interface AuditToken {
  id: number
  label: string
  lastUsedAt: string | null
  createdAt: string
}

function formatRelative(iso: string | null): string {
  if (!iso) return 'Never'
  const d = new Date(iso)
  const diffMs = Date.now() - d.getTime()
  if (diffMs < 60_000) return 'just now'
  const mins = Math.round(diffMs / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return d.toLocaleDateString()
}

export function AuditTokensTab() {
  const toast = useToast()
  const [tokens, setTokens] = useState<AuditToken[]>([])
  const [loading, setLoading] = useState(true)
  const [label, setLabel] = useState('')
  const [minting, setMinting] = useState(false)
  const [revealed, setRevealed] = useState<string | null>(null)
  const [revealedId, setRevealedId] = useState<number | null>(null)

  useEffect(() => {
    void load()
  }, [])

  async function load() {
    try {
      const data = await getJson<AuditToken[]>('/api/audit/tokens')
      setTokens(data)
    } catch {
      toast.error('Failed to load audit tokens')
    } finally {
      setLoading(false)
    }
  }

  async function mint() {
    setMinting(true)
    try {
      const res = await postJson<{ id: number; plaintext: string; label: string; createdAt: string }>(
        '/api/audit/tokens',
        { label: label.trim() || 'Audit' },
      )
      setRevealed(res.plaintext)
      setRevealedId(res.id)
      setLabel('')
      setTokens((prev) => [
        { id: res.id, label: res.label, lastUsedAt: null, createdAt: res.createdAt },
        ...prev,
      ])
    } catch {
      toast.error('Failed to mint token')
    } finally {
      setMinting(false)
    }
  }

  async function revoke(id: number) {
    try {
      await deleteReq(`/api/audit/tokens/${id}`)
      setTokens((prev) => prev.filter((t) => t.id !== id))
      if (revealedId === id) {
        setRevealed(null)
        setRevealedId(null)
      }
      toast.success('Token revoked')
    } catch {
      toast.error('Failed to revoke token')
    }
  }

  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      toast.success('Copied to clipboard')
    } catch {
      toast.error('Failed to copy')
    }
  }

  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      <div>
        <h2 className="text-lg font-semibold mb-1">AI audit tokens</h2>
        <p className="text-sm text-slate-600">
          Audit tokens grant an AI agent read-only access to system health, data integrity, and
          pipeline freshness so it can verify production is working correctly after a deploy.
          Store the token as{' '}
          <code className="bg-slate-100 px-1 rounded text-xs">CASHFLOW_AUDIT_TOKEN</code> in
          your agent's environment.
        </p>
      </div>

      {revealed && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 flex flex-col gap-2">
          <p className="text-sm font-medium text-amber-800">
            Save this token now — it will not be shown again.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-white border border-amber-200 rounded px-3 py-2 text-xs font-mono break-all">
              {revealed}
            </code>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void copyToClipboard(revealed)}
            >
              <Copy className="w-3 h-3 mr-1" />
              Copy
            </Button>
          </div>
          <p className="text-xs text-amber-700">
            Store as <code className="bg-amber-100 px-1 rounded">CASHFLOW_AUDIT_TOKEN</code> in
            your agent's environment.
          </p>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Mint a new token</h3>
        <div className="flex items-center gap-2">
          <input
            type="text"
            className="flex-1 border rounded px-3 py-2 text-sm"
            placeholder="Label (e.g. ci-bot)"
            maxLength={64}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !minting) void mint() }}
          />
          <Button onClick={() => void mint()} disabled={minting} size="sm">
            {minting ? 'Minting…' : 'Mint token'}
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Active tokens</h3>
        {loading ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : tokens.length === 0 ? (
          <p className="text-sm text-slate-500">No active tokens.</p>
        ) : (
          <div className="border rounded-lg divide-y">
            {tokens.map((token) => (
              <div key={token.id} className="flex items-center justify-between px-4 py-3">
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">{token.label}</span>
                  <span className="text-xs text-slate-500">
                    Created {formatRelative(token.createdAt)} · Last used{' '}
                    {formatRelative(token.lastUsedAt)}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void revoke(token.id)}
                  className="text-red-600 hover:text-red-700 hover:bg-red-50"
                >
                  <Trash2 className="w-3 h-3 mr-1" />
                  Revoke
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
