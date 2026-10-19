import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Icon } from '@connor-adams/designsystem'
import { Card } from '@connor-adams/designsystem'
import { EmptyState } from '@connor-adams/designsystem'
import { useToast } from '@/components/ui/toast'
import { deleteReq, getJson, postJson } from '../../../lib/api'

/**
 * Bearer-token scopes managed from Settings → API tokens. Capture (cfc_)
 * tokens are not listed here: they are minted inline by the bookmarklet flow
 * in ImportsTab.
 */
export type PanelTokenScope = 'audit' | 'reporting'

type TokenRow = {
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

const code = (s: string) => <code className="font-mono text-xs">{s}</code>

interface ScopeCopy {
  endpoint: string
  title: string
  noun: string
  defaultLabel: string
  placeholder: string
  description: ReactNode
  saveHint: ReactNode
}

const SCOPES: Record<PanelTokenScope, ScopeCopy> = {
  audit: {
    endpoint: '/api/audit/tokens',
    title: 'AI audit tokens',
    noun: 'audit',
    defaultLabel: 'Audit',
    placeholder: 'Label (e.g. CI agent)',
    description: (
      <>
        Audit tokens grant an AI agent read-only access to system health, data integrity,
        and pipeline freshness so it can verify production is working correctly after a
        deploy. Tokens begin with {code('cfa_')} and only work for GET requests on{' '}
        {code('/api/audit/*')}.
      </>
    ),
    saveHint: <> Store it as {code('CASHFLOW_AUDIT_TOKEN')} in your agent's environment.</>,
  },
  reporting: {
    endpoint: '/api/v1/tokens',
    title: 'Reporting tokens',
    noun: 'reporting',
    defaultLabel: 'Reporting',
    placeholder: 'Label (e.g. Blackbox)',
    description: (
      <>
        Reporting tokens grant a downstream consumer read-only access to your financial
        reporting data. Tokens begin with {code('cfr_')} and only work for GET requests on{' '}
        {code('/api/v1/*')}, passed as {code('Authorization: Bearer cfr_…')}.
      </>
    ),
    saveHint: null,
  },
}

function formatDate(iso: string | null): string {
  if (!iso) return 'Never'
  return new Date(iso).toLocaleString()
}

export function ScopedTokensPanel({ scope }: { scope: PanelTokenScope }) {
  const { endpoint, title, noun, defaultLabel, placeholder, description, saveHint } = SCOPES[scope]
  const { showToast } = useToast()
  const [tokens, setTokens] = useState<TokenRow[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [label, setLabel] = useState(defaultLabel)
  const [minting, setMinting] = useState(false)
  const [revealed, setRevealed] = useState<{ id: number; plaintext: string } | null>(null)
  const plaintextRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setErr(null)
    try {
      setTokens(await getJson<TokenRow[]>(endpoint))
    } catch (e) {
      setErr(e instanceof Error ? e.message : `Could not load ${noun} tokens`)
    } finally {
      setLoading(false)
    }
  }, [endpoint, noun])

  useEffect(() => {
    void load()
  }, [load])

  async function mint() {
    if (minting) return
    setMinting(true)
    try {
      const res = await postJson<MintResponse>(endpoint, { label: label.trim() || defaultLabel })
      setRevealed({ id: res.id, plaintext: res.plaintext })
      await load()
    } catch (e) {
      showToast({ title: e instanceof Error ? e.message : 'Could not mint token', variant: 'destructive' })
    } finally {
      setMinting(false)
    }
  }

  async function revoke(token: TokenRow) {
    try {
      await deleteReq(`${endpoint}/${token.id}`)
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
        <h2 className="text-base font-semibold mb-1">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>

      {revealed && (
        <Card className="p-4 space-y-2 border-warning bg-warning-bg">
          <p className="text-sm font-medium text-warning">
            Save this token now — it will not be shown again.{saveHint}
          </p>
          <div className="flex items-center gap-2">
            <input
              ref={plaintextRef}
              readOnly
              value={revealed.plaintext}
              aria-label={`New ${noun} token`}
              className="flex-1 font-mono text-xs bg-card border rounded px-2 py-1 select-all"
              onFocus={(e) => e.target.select()}
            />
            <Button size="sm" variant="outline" onClick={copyPlaintext}>
              <Icon name="copy" className="h-3.5 w-3.5 mr-1" />
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
            placeholder={placeholder}
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
        <EmptyState title={`No active ${noun} tokens`} description="Mint a token above to get started." />
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
                      aria-label={`Revoke ${t.label}`}
                      className="text-destructive hover:text-destructive"
                      onClick={() => void revoke(t)}
                    >
                      <Icon name="trash" className="h-3.5 w-3.5" />
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
