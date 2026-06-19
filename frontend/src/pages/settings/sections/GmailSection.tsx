import { useCallback, useEffect, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { Button } from '@cashflow/ui'
import { Card } from '@cashflow/ui'
import { Input } from '@cashflow/ui'
import { deleteReq, getJson, patchJson, postJson } from '@/lib/api'

// ---------------------------------------------------------------------------
// Types (extracted from SettingsPage.tsx module scope)
// ---------------------------------------------------------------------------

type AllowlistDefault = { address: string; vendorHint: string; label: string }
type AllowlistCustom = {
  id: number
  emailAddress: string
  label: string | null
  vendorHint: string | null
  enabled: boolean
}
type AllowlistResponse = {
  defaults: AllowlistDefault[]
  custom: AllowlistCustom[]
}

type GmailStatus = {
  featureEnabled: boolean
  connected: boolean
  provider?: string
  accountEmail?: string | null
  status?: string
  statusReason?: string | null
  lastScanAt?: string | null
  scopes?: string | null
}

type GmailScanFeedMessage = {
  messageId: string
  from: string | null
  subject: string | null
  vendor: string
  parser: string | null
  status: string
  itemsCount: number
  orderCreated: boolean
  error: string | null
}

type GmailStreamEvent =
  | { kind: 'started'; maxMessages: number; sinceDays: number | null }
  | { kind: 'phase'; phase: 'listing'; fetched: number; hasMore: boolean }
  | { kind: 'phase'; phase: 'processing-start'; total: number }
  | { kind: 'phase'; phase: 'processed'; index: number; total: number }
  | ({ kind: 'message' } & GmailScanFeedMessage)
  | ({ kind: 'summary'; messageCount: number } & Omit<GmailScanResult, 'messages'>)
  | { kind: 'error'; message: string }

type GmailScanResult = {
  scannedMessages: number
  createdOrders: number
  duplicateOrders: number
  failedExtractions: number
  filteredBySubject: number
  skippedAlreadySeen: number
  byParser: Record<string, number>
  aiExtractions: number
  messages?: Array<GmailScanFeedMessage>
  messageCount?: number
  query: string
  sinceDate: string | null
}

// ---------------------------------------------------------------------------
// SenderSuggestions
// ---------------------------------------------------------------------------

type SenderSuggestion = {
  id: number
  emailAddress: string
  label: string | null
  sampleSubject: string | null
  candidateCount: number
  lastSeenAt: string | null
}

export function SenderSuggestions() {
  const [items, setItems] = useState<SenderSuggestion[]>([])
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const result = await getJson<SenderSuggestion[]>('/api/email/suggestions')
      setItems(Array.isArray(result) ? result : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load suggestions')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function act(id: number, action: 'approve' | 'dismiss') {
    setError(null)
    try {
      await postJson(`/api/email/suggestions/${id}/${action}`)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : `Could not ${action}`)
    }
  }

  if (items.length === 0) {
    return error ? <span className="error" role="alert">{error}</span> : null
  }

  return (
    <div style={{ marginTop: '0.5rem', display: 'grid', gap: '0.4rem' }}>
      <strong style={{ fontSize: '0.85rem' }}>Suggested receipt senders</strong>
      <p className="muted" style={{ fontSize: '0.8rem', margin: 0 }}>
        Discovery found these senders. Approve to scan them on every run, or dismiss to ignore.
      </p>
      <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'grid', gap: '0.3rem' }}>
        {items.map((s) => (
          <li key={s.id} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <code>{s.emailAddress}</code>{' '}
              <span className="muted">· {s.candidateCount} emails{s.sampleSubject ? ` · "${s.sampleSubject}"` : ''}</span>
            </span>
            <Button type="button" size="sm" variant="outline" onClick={() => void act(s.id, 'approve')}>Approve</Button>
            <Button type="button" size="sm" variant="destructive" onClick={() => void act(s.id, 'dismiss')}>Dismiss</Button>
          </li>
        ))}
      </ul>
      {error && <span className="error" role="alert" style={{ fontSize: '0.85rem' }}>{error}</span>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function GmailSection() {
  const [gmailStatus, setGmailStatus] = useState<GmailStatus | null>(null)
  const [gmailScanning, setGmailScanning] = useState(false)
  const [gmailScanResult, setGmailScanResult] = useState<GmailScanResult | null>(null)
  const [gmailError, setGmailError] = useState<string | null>(null)
  const [gmailScanFeed, setGmailScanFeed] = useState<GmailScanFeedMessage[]>([])
  const [gmailScanLive, setGmailScanLive] = useState<{
    listed: number
    processed: number
    total: number
    hasMore: boolean
    listing: boolean
  } | null>(null)
  const [allowlist, setAllowlist] = useState<AllowlistResponse | null>(null)
  const [allowlistDraftEmail, setAllowlistDraftEmail] = useState('')
  const [allowlistDraftLabel, setAllowlistDraftLabel] = useState('')
  const [allowlistError, setAllowlistError] = useState<string | null>(null)

  const loadAllowlist = useCallback(async () => {
    try {
      setAllowlist(await getJson<AllowlistResponse>('/api/email/allowlist'))
    } catch (e) {
      setAllowlistError(e instanceof Error ? e.message : 'Could not load allowlist')
    }
  }, [])

  useEffect(() => {
    void loadAllowlist()
  }, [loadAllowlist])

  const loadGmailStatus = useCallback(async () => {
    try {
      setGmailStatus(await getJson<GmailStatus>('/api/email/status'))
    } catch (e) {
      setGmailError(e instanceof Error ? e.message : 'Could not load Gmail status')
    }
  }, [])

  useEffect(() => {
    void loadGmailStatus()
  }, [loadGmailStatus])

  // Surface the post-OAuth redirect status from the query string.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const gmail = params.get('gmail')
    if (gmail === 'connected') {
      void loadGmailStatus()
      // Clean URL so a refresh doesn't keep showing the toast.
      params.delete('gmail')
      const nextSearch = params.toString()
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${nextSearch ? '?' + nextSearch : ''}${window.location.hash}`,
      )
    } else if (gmail === 'denied') {
      setGmailError('Gmail consent denied. You can try again any time.')
      params.delete('gmail')
      const nextSearch = params.toString()
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${nextSearch ? '?' + nextSearch : ''}${window.location.hash}`,
      )
    }
  }, [loadGmailStatus])

  async function addAllowlistRow() {
    setAllowlistError(null)
    const emailAddress = allowlistDraftEmail.trim().toLowerCase()
    if (!emailAddress) return
    try {
      await postJson('/api/email/allowlist', {
        emailAddress,
        label: allowlistDraftLabel.trim() || undefined,
      })
      setAllowlistDraftEmail('')
      setAllowlistDraftLabel('')
      await loadAllowlist()
    } catch (e) {
      setAllowlistError(e instanceof Error ? e.message : 'Could not add sender')
    }
  }

  async function toggleAllowlistRow(id: number, enabled: boolean) {
    setAllowlistError(null)
    try {
      await patchJson(`/api/email/allowlist/${id}`, { enabled })
      await loadAllowlist()
    } catch (e) {
      setAllowlistError(e instanceof Error ? e.message : 'Could not update sender')
    }
  }

  async function deleteAllowlistRow(id: number) {
    setAllowlistError(null)
    try {
      await deleteReq(`/api/email/allowlist/${id}`)
      await loadAllowlist()
    } catch (e) {
      setAllowlistError(e instanceof Error ? e.message : 'Could not remove sender')
    }
  }

  function connectGmail() {
    const base = import.meta.env.VITE_API_BASE ?? ''
    // Browser-level redirect — server responds with 302 to Google's consent screen.
    window.location.href = `${base}/api/email/auth/google`
  }

  async function disconnectGmail() {
    setGmailError(null)
    try {
      await postJson('/api/email/disconnect/google')
      await loadGmailStatus()
      setGmailScanResult(null)
    } catch (e) {
      setGmailError(e instanceof Error ? e.message : 'Disconnect failed')
    }
  }

  async function runGmailScanAt(path: string, maxMessages: number, sinceDays?: number) {
    if (gmailScanning) return
    setGmailScanning(true)
    setGmailError(null)
    setGmailScanResult(null)
    setGmailScanFeed([])
    setGmailScanLive({ listed: 0, processed: 0, total: 0, hasMore: false, listing: true })
    const body: Record<string, unknown> = { maxMessages }
    if (sinceDays != null) body.sinceDays = sinceDays
    try {
      const base = import.meta.env.VITE_API_BASE ?? ''
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/x-ndjson',
        },
        body: JSON.stringify(body),
      })
      if (!res.ok || !res.body) {
        const t = await res.text().catch(() => res.statusText)
        throw new Error(t || `HTTP ${res.status}`)
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let liveFeed: GmailScanFeedMessage[] = []
      let liveListed = 0
      let liveProcessed = 0
      let liveTotal = 0
      let liveHasMore = false
      let liveListing = true
      let lastFlush = Date.now()
      const flush = () => {
        setGmailScanFeed(liveFeed.slice())
        setGmailScanLive({
          listed: liveListed,
          processed: liveProcessed,
          total: liveTotal,
          hasMore: liveHasMore,
          listing: liveListing,
        })
        lastFlush = Date.now()
      }
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let nl = buffer.indexOf('\n')
        while (nl !== -1) {
          const line = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          nl = buffer.indexOf('\n')
          if (!line) continue
          let event: GmailStreamEvent
          try {
            event = JSON.parse(line) as GmailStreamEvent
          } catch {
            continue
          }
          if (event.kind === 'phase') {
            if (event.phase === 'listing') {
              liveListed = event.fetched
              liveHasMore = event.hasMore
              liveListing = true
            } else if (event.phase === 'processing-start') {
              liveListing = false
              liveTotal = event.total
            } else if (event.phase === 'processed') {
              liveProcessed = event.index
              liveTotal = event.total
            }
          } else if (event.kind === 'message') {
            liveFeed = [event, ...liveFeed].slice(0, 200)
          } else if (event.kind === 'summary') {
            const rest = { ...event } as Partial<{ kind: string }> & GmailScanResult
            delete rest.kind
            setGmailScanResult(rest as GmailScanResult)
          } else if (event.kind === 'error') {
            setGmailError(event.message)
          }
          if (Date.now() - lastFlush > 100) flush()
        }
      }
      flush()
      await loadGmailStatus()
    } catch (e) {
      setGmailError(e instanceof Error ? e.message : 'Scan failed')
    } finally {
      setGmailScanning(false)
      setGmailScanLive((prev) => (prev ? { ...prev, listing: false } : prev))
    }
  }

  async function runGmailScan(maxMessages: number, sinceDays?: number) {
    await runGmailScanAt('/api/email/scan/google?stream=1', maxMessages, sinceDays)
  }

  async function runDiscovery() {
    if (gmailScanning) return
    await runGmailScanAt('/api/email/discover/google?stream=1', 300, 30)
  }

  return (
    <Card className="accountsFormCard">
      <div className="accountsCardHeader">
        <div>
          <h2>Connect Gmail</h2>
          <p className="muted">
            Connect your Gmail once and Cashflow auto-scrapes receipt emails (Apple, Google, Amazon,
            Uber, DoorDash, etc.), extracts the line items, and links them to your card transactions.
            Read-only access; tokens encrypted at rest; disconnect any time.
          </p>
        </div>
      </div>
      {!gmailStatus?.featureEnabled && (
        <p className="muted" role="status">
          Email integration isn&apos;t configured on this server. Ask the operator to set
          <code> GOOGLE_OAUTH_CLIENT_ID</code>, <code>GOOGLE_OAUTH_CLIENT_SECRET</code>, and{' '}
          <code>EMAIL_INTEGRATION_ENCRYPTION_KEY</code>.
        </p>
      )}
      {gmailStatus?.featureEnabled && !gmailStatus.connected && (
        <Button type="button" onClick={() => connectGmail()}>
          <Sparkles aria-hidden="true" />
          Connect Gmail
        </Button>
      )}
      {gmailStatus?.connected && (
        <div style={{ display: 'grid', gap: '0.5rem' }}>
          <div>
            <strong>Connected as</strong> {gmailStatus.accountEmail ?? '(unknown email)'} · status{' '}
            <code>{gmailStatus.status}</code>
            {gmailStatus.lastScanAt && (
              <> · last scan {new Date(gmailStatus.lastScanAt).toLocaleString()}</>
            )}
          </div>
          {gmailStatus.status === 'reconnect_needed' && (
            <div className="error" role="alert" style={{ display: 'grid', gap: '0.5rem' }}>
              <span>
                {gmailStatus.statusReason ??
                  'Gmail access was revoked or expired. Reconnect to resume scanning.'}
              </span>
              <div>
                <Button type="button" onClick={() => connectGmail()}>
                  Reconnect Gmail
                </Button>
              </div>
            </div>
          )}
          <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
            <Button type="button" disabled={gmailScanning} onClick={() => void runGmailScan(500)}>
              <Sparkles aria-hidden="true" />
              {gmailScanning ? 'Scanning…' : 'Scan inbox (up to 500)'}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={gmailScanning}
              onClick={() => void runGmailScan(2000, 90)}
              title="Scan the last 90 days (first-time backfill, up to 2000 msgs)"
            >
              90-day backfill (2000 msgs)
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={gmailScanning}
              onClick={() => void runGmailScan(5000, 365)}
              title="Scan the last year (up to 5000 messages — can take a while)"
            >
              1-year backfill (5000 msgs)
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={gmailScanning}
              onClick={() => void runDiscovery()}
              title="Find receipts from senders not yet on your allowlist"
            >
              <Sparkles aria-hidden="true" />
              Discover new receipt sources
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={gmailScanning}
              onClick={() => void disconnectGmail()}
            >
              Disconnect
            </Button>
          </div>
          {gmailScanLive && (gmailScanning || gmailScanFeed.length > 0) && !gmailScanResult && (
            <div style={{ padding: '0.5rem 0.75rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-md, 6px)', fontSize: '0.85rem' }}>
              <div>
                {gmailScanLive.listing ? (
                  <>Listing matching messages… <strong>{gmailScanLive.listed}</strong> found{gmailScanLive.hasMore ? ' (more pages)' : ''}</>
                ) : (
                  <>Processing <strong>{gmailScanLive.processed} / {gmailScanLive.total}</strong> messages…</>
                )}
              </div>
              {gmailScanFeed.length > 0 && (
                <div
                  style={{
                    marginTop: '0.4rem',
                    maxHeight: '14rem',
                    overflowY: 'auto',
                    fontSize: '0.78rem',
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    lineHeight: 1.3,
                  }}
                  role="log"
                  aria-live="polite"
                >
                  {gmailScanFeed.map((m) => (
                    <div key={m.messageId} style={{ display: 'flex', gap: '0.5rem', alignItems: 'baseline' }}>
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {m.subject ?? '(no subject)'}
                      </span>
                      <span className="muted" style={{ minWidth: '7rem', textAlign: 'right' }}>
                        {m.status === 'extracted' ? (
                          <span style={{ color: 'var(--success)' }}>
                            {m.parser}/{m.itemsCount}
                          </span>
                        ) : m.status === 'duplicate' ? (
                          'duplicate'
                        ) : m.status === 'skipped_already_seen' ? (
                          'already-seen'
                        ) : m.status === 'filtered_subject' ? (
                          'filtered'
                        ) : m.status === 'no_items' ? (
                          'no items'
                        ) : (
                          <span className="error">{m.status}</span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {gmailScanResult && (
            <div style={{ padding: '0.5rem 0.75rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-md, 6px)', fontSize: '0.85rem' }}>
              <div>
                <strong>Scanned {gmailScanResult.scannedMessages}</strong> · created {gmailScanResult.createdOrders}, duplicates {gmailScanResult.duplicateOrders}, already seen {gmailScanResult.skippedAlreadySeen}, filtered by subject {gmailScanResult.filteredBySubject}, failed {gmailScanResult.failedExtractions}
              </div>
              <div className="muted">
                Parsers:{' '}
                {Object.entries(gmailScanResult.byParser)
                  .sort((a, b) => b[1] - a[1])
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(' · ') || 'none'}{' '}
                · AI calls: {gmailScanResult.aiExtractions}
              </div>
              {(() => {
                const detail = gmailScanResult.messages ?? gmailScanFeed
                return detail.length > 0 ? (
                  <details style={{ marginTop: '0.35rem' }}>
                    <summary className="muted" style={{ cursor: 'pointer' }}>
                      Per-message detail ({detail.length}{gmailScanResult.messageCount && gmailScanResult.messageCount !== detail.length ? ` of ${gmailScanResult.messageCount}` : ''})
                    </summary>
                    <ul style={{ margin: '0.25rem 0 0', paddingLeft: '1.1rem' }}>
                      {detail.slice(0, 50).map((m) => (
                        <li key={m.messageId}>
                          {m.from ?? '(no from)'} — {m.subject ?? '(no subject)'} →{' '}
                          {m.status === 'skipped_already_seen' ? (
                            <span className="muted">already processed</span>
                          ) : m.status === 'filtered_subject' ? (
                            <span className="muted">filtered: {m.error}</span>
                          ) : m.error ? (
                            <span className="error">{m.error}</span>
                          ) : (
                            <>
                              {m.vendor} · {m.itemsCount} items · parser <code>{m.parser ?? '—'}</code>
                              {m.orderCreated ? ' · new order' : ' · duplicate'}
                            </>
                          )}
                        </li>
                      ))}
                      {detail.length > 50 && <li className="muted">…+{detail.length - 50} more</li>}
                    </ul>
                  </details>
                ) : null
              })()}
              <p className="muted" style={{ marginTop: '0.35rem', fontSize: '0.8rem' }}>
                Run the backfill below to attach the new orders to your card transactions.
              </p>
            </div>
          )}
          {gmailError && (
            <span className="error" role="alert">{gmailError}</span>
          )}
          <details style={{ marginTop: '0.25rem' }}>
            <summary style={{ cursor: 'pointer' }}>
              Sender allowlist ({allowlist ? (allowlist.defaults.length + allowlist.custom.filter((c) => c.enabled).length) : '…'} active)
            </summary>
            <div style={{ marginTop: '0.5rem', display: 'grid', gap: '0.5rem' }}>
              <p className="muted" style={{ fontSize: '0.8rem', margin: 0 }}>
                Senders we'll pull receipts from on each scan. Defaults are baked in; add custom ones below.
              </p>
              {allowlist && (
                <details>
                  <summary className="muted" style={{ cursor: 'pointer', fontSize: '0.8rem' }}>
                    Built-in defaults ({allowlist.defaults.length})
                  </summary>
                  <ul style={{ margin: '0.25rem 0 0', paddingLeft: '1rem', fontSize: '0.8rem' }}>
                    {allowlist.defaults.map((d) => (
                      <li key={d.address}><code>{d.address}</code> — {d.label}</li>
                    ))}
                  </ul>
                </details>
              )}
              {allowlist && allowlist.custom.length > 0 && (
                <div>
                  <strong style={{ fontSize: '0.85rem' }}>Your additions</strong>
                  <ul style={{ margin: '0.25rem 0 0', paddingLeft: '1rem', fontSize: '0.85rem', listStyle: 'none' }}>
                    {allowlist.custom.map((row) => (
                      <li key={row.id} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', padding: '0.15rem 0' }}>
                        <input
                          type="checkbox"
                          checked={row.enabled}
                          onChange={() => void toggleAllowlistRow(row.id, !row.enabled)}
                          aria-label={`Enabled: ${row.emailAddress}`}
                        />
                        <code style={{ flex: 1 }}>{row.emailAddress}</code>
                        {row.label && <span className="muted">{row.label}</span>}
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          onClick={() => void deleteAllowlistRow(row.id)}
                        >
                          Remove
                        </Button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  void addAllowlistRow()
                }}
                style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}
              >
                <Input
                  type="email"
                  placeholder="receipts@somemerchant.com"
                  value={allowlistDraftEmail}
                  onChange={(e) => setAllowlistDraftEmail(e.target.value)}
                  required
                  style={{ minWidth: '16rem' }}
                />
                <Input
                  type="text"
                  placeholder="Label (optional)"
                  value={allowlistDraftLabel}
                  onChange={(e) => setAllowlistDraftLabel(e.target.value)}
                  style={{ minWidth: '10rem' }}
                />
                <Button type="submit" size="sm" variant="outline">Add</Button>
              </form>
              {allowlistError && (
                <span className="error" role="alert" style={{ fontSize: '0.85rem' }}>{allowlistError}</span>
              )}
            </div>
          </details>
          <SenderSuggestions />
        </div>
      )}
    </Card>
  )
}
