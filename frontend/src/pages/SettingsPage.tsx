import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Edit3, Link2, Plus, Sparkles, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  useConfirm,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PageHeader } from '@/components/ui/page-header'
import { deleteReq, getJson, patchJson, postJson } from '../lib/api'
import { layoutWidthOptions, useLayoutWidth } from '../lib/layoutWidth'
import { useAuth } from '../lib/useAuth'
import type { Contact } from '../types/api'

import type { EnrichmentBackfillProgress, EnrichmentStats } from '../types/api'

type BackfillSummary = Extract<EnrichmentBackfillProgress, { kind: 'summary' }>
type BackfillProgressRow = Extract<EnrichmentBackfillProgress, { kind: 'progress' }>
type BackfillErrorEvent = Extract<EnrichmentBackfillProgress, { kind: 'error' }>

const MAX_FEED_ROWS = 200

type ReceiptImportItem = {
  title: string
  quantity: number
  unitPrice: number | null
  totalPrice: number | null
  inferredCategory: string | null
}

type PurchaseHistoryCsvResult = {
  vendor: string
  fileName: string
  totalRows: number
  ordersBuilt: number
  unparsedRows: number
  createdOrders: number
  skippedDuplicates: number
  errors: Array<{ rowIndex: number; message: string }>
  columnMapping: Record<string, string>
}

type ReceiptImportResult = {
  order: { id: number; vendor: string; total: string | null; currency: string; orderDate: string | null }
  created: boolean
  extracted: {
    vendor: string
    vendorName: string | null
    orderDate: string | null
    orderId: string | null
    total: number | null
    currency: string | null
    paymentLast4: string | null
    items: ReceiptImportItem[]
    notes: string | null
  }
}

export function SettingsPage() {
  const auth = useAuth()
  const [layoutWidth, setLayoutWidth] = useLayoutWidth()
  const [contacts, setContacts] = useState<Contact[]>([])
  const [invite, setInvite] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [renameTarget, setRenameTarget] = useState<Contact | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renameSaving, setRenameSaving] = useState(false)
  const [backfillRunning, setBackfillRunning] = useState<'dry' | 'real' | null>(null)
  const [backfillSummary, setBackfillSummary] = useState<BackfillSummary | null>(null)
  const [backfillError, setBackfillError] = useState<string | null>(null)
  const [backfillFeed, setBackfillFeed] = useState<BackfillProgressRow[]>([])
  const [backfillErrors, setBackfillErrors] = useState<BackfillErrorEvent[]>([])
  const [backfillLive, setBackfillLive] = useState<{ processed: number; cleared: number; skipped: number } | null>(null)
  const [backfillClearReview, setBackfillClearReview] = useState(true)
  const [backfillReviewOnly, setBackfillReviewOnly] = useState(false)
  const [backfillLimit, setBackfillLimit] = useState('')
  const [stats, setStats] = useState<EnrichmentStats | null>(null)
  const [statsError, setStatsError] = useState<string | null>(null)
  const [statsLoading, setStatsLoading] = useState(false)
  const [receiptText, setReceiptText] = useState('')
  const [receiptBusy, setReceiptBusy] = useState<'text' | 'image' | 'csv' | null>(null)
  const [receiptError, setReceiptError] = useState<string | null>(null)
  const [receiptResult, setReceiptResult] = useState<ReceiptImportResult | null>(null)
  const [csvVendor, setCsvVendor] = useState<'apple' | 'google' | 'amazon' | 'other'>('apple')
  const [csvResult, setCsvResult] = useState<PurchaseHistoryCsvResult | null>(null)

  async function uploadPurchaseHistoryCsv(file: File) {
    if (receiptBusy) return
    setReceiptBusy('csv')
    setReceiptError(null)
    setCsvResult(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const base = import.meta.env.VITE_API_BASE ?? ''
      const res = await fetch(`${base}/api/external-orders/import-csv?vendor=${csvVendor}`, {
        method: 'POST',
        credentials: 'include',
        body: fd,
      })
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText)
        throw new Error(text || `HTTP ${res.status}`)
      }
      const r = (await res.json()) as PurchaseHistoryCsvResult
      setCsvResult(r)
    } catch (e) {
      setReceiptError(e instanceof Error ? e.message : 'CSV upload failed')
    } finally {
      setReceiptBusy(null)
    }
  }

  async function parseReceiptText() {
    if (receiptBusy) return
    setReceiptBusy('text')
    setReceiptError(null)
    setReceiptResult(null)
    try {
      const r = await postJson<ReceiptImportResult>('/api/external-orders/import-text', { text: receiptText })
      setReceiptResult(r)
      setReceiptText('')
    } catch (e) {
      setReceiptError(e instanceof Error ? e.message : 'Receipt parse failed')
    } finally {
      setReceiptBusy(null)
    }
  }

  async function parseReceiptImage(file: File) {
    if (receiptBusy) return
    setReceiptBusy('image')
    setReceiptError(null)
    setReceiptResult(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const base = import.meta.env.VITE_API_BASE ?? ''
      const res = await fetch(`${base}/api/external-orders/import-image`, {
        method: 'POST',
        credentials: 'include',
        body: fd,
      })
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText)
        throw new Error(text || `HTTP ${res.status}`)
      }
      const r = (await res.json()) as ReceiptImportResult
      setReceiptResult(r)
    } catch (e) {
      setReceiptError(e instanceof Error ? e.message : 'Image parse failed')
    } finally {
      setReceiptBusy(null)
    }
  }

  const loadStats = useCallback(async () => {
    setStatsLoading(true)
    setStatsError(null)
    try {
      setStats(await getJson<EnrichmentStats>('/api/transactions/enrichment/stats'))
    } catch (e) {
      setStatsError(e instanceof Error ? e.message : 'Could not load stats')
    } finally {
      setStatsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadStats()
  }, [loadStats])
  const confirm = useConfirm()
  const errorId = 'settings-error'
  const hasError = Boolean(err)

  async function runBackfill(mode: 'dry' | 'real') {
    if (backfillRunning) return
    if (mode === 'real') {
      const ok = await confirm({
        title: 'Run enrichment backfill?',
        description:
          'Re-runs the import enrichment pipeline against every transaction in your household. Override fields and already-reviewed rows are untouched.',
        confirmLabel: 'Run backfill',
      })
      if (!ok) return
    }
    setBackfillRunning(mode)
    setBackfillError(null)
    setBackfillSummary(null)
    setBackfillFeed([])
    setBackfillErrors([])
    setBackfillLive({ processed: 0, cleared: 0, skipped: 0 })

    const limit = Number(backfillLimit.trim())
    const body: Record<string, unknown> = {
      dryRun: mode === 'dry',
      noReviewFlag: !backfillClearReview,
      reviewOnly: backfillReviewOnly,
    }
    if (Number.isFinite(limit) && limit > 0) body.limit = Math.floor(limit)

    try {
      const base = import.meta.env.VITE_API_BASE ?? ''
      const res = await fetch(`${base}/api/transactions/enrichment/backfill?stream=1`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/x-ndjson',
        },
        body: JSON.stringify(body),
      })
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => res.statusText)
        throw new Error(text || `HTTP ${res.status}`)
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let processed = 0
      let cleared = 0
      let skipped = 0
      let liveFeed: BackfillProgressRow[] = []
      let liveErrors: BackfillErrorEvent[] = []
      // Throttle React updates: only flush once per ~100ms
      let lastFlush = Date.now()
      const flush = () => {
        setBackfillFeed(liveFeed.slice())
        setBackfillErrors(liveErrors.slice())
        setBackfillLive({ processed, cleared, skipped })
        lastFlush = Date.now()
      }
      // eslint-disable-next-line no-constant-condition
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
          let event: EnrichmentBackfillProgress
          try {
            event = JSON.parse(line) as EnrichmentBackfillProgress
          } catch {
            continue
          }
          if (event.kind === 'progress') {
            processed++
            if (event.reviewFlagCleared) cleared++
            liveFeed = [event, ...liveFeed].slice(0, MAX_FEED_ROWS)
          } else if (event.kind === 'error') {
            skipped++
            liveErrors = [event, ...liveErrors].slice(0, 50)
          } else if (event.kind === 'summary') {
            setBackfillSummary(event)
          }
          if (Date.now() - lastFlush > 100) flush()
        }
      }
      flush()
      void loadStats()
    } catch (e) {
      setBackfillError(e instanceof Error ? e.message : 'Backfill failed')
    } finally {
      setBackfillRunning(null)
    }
  }

  const loadContacts = useCallback(async () => {
    try {
      setContacts(await getJson<Contact[]>('/api/contacts'))
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load contacts')
    }
  }, [])

  useEffect(() => {
    void loadContacts()
  }, [loadContacts])

  async function createInvite() {
    setErr(null)
    try {
      const data = await postJson<{ token: string }>('/api/auth/invites')
      setInvite(data.token)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not create invite')
    }
  }

  async function createContact(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const fd = new FormData(form)
    const name = String(fd.get('name') ?? '').trim()
    const notes = String(fd.get('notes') ?? '').trim()
    if (!name) return
    setErr(null)
    try {
      await postJson<Contact>('/api/contacts', { name, notes: notes || null })
      form.reset()
      await loadContacts()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not create contact')
    }
  }

  function openRename(contact: Contact) {
    setRenameTarget(contact)
    setRenameValue(contact.name)
  }

  function closeRename() {
    setRenameTarget(null)
    setRenameValue('')
    setRenameSaving(false)
  }

  async function submitRename(e?: FormEvent<HTMLFormElement>) {
    if (e) e.preventDefault()
    if (!renameTarget) return
    const next = renameValue.trim()
    if (!next) return
    setRenameSaving(true)
    try {
      await patchJson<Contact>(`/api/contacts/${renameTarget.id}`, { name: next })
      closeRename()
      await loadContacts()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not update contact')
      setRenameSaving(false)
    }
  }

  async function removeContact(contact: Contact) {
    const ok = await confirm({
      title: 'Delete contact?',
      description: `“${contact.name}” will be removed from your contacts ledger.`,
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    try {
      await deleteReq(`/api/contacts/${contact.id}`)
      await loadContacts()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not delete contact')
    }
  }

  const inviteUrl = invite
    ? `${window.location.origin}${window.location.pathname}?invite=${encodeURIComponent(invite)}`
    : null

  return (
    <>
    <div className="page">
      <PageHeader
        title="Settings"
        description={
          <>
            {auth.user?.household?.name} · {auth.user?.email}
            {auth.user?.globalRole === 'superadmin' ? ' · God mode' : ''}
          </>
        }
      />

      <Card className="settingsDisplayCard">
        <div className="accountsCardHeader">
          <div>
            <h2>Display width</h2>
            <p className="muted">Choose how much horizontal space the app can use on this browser.</p>
          </div>
        </div>
        <div className="settingsWidthOptions" role="radiogroup" aria-label="Display width">
          {layoutWidthOptions.map((option) => (
            <label className="settingsWidthOption" key={option.value}>
              <input
                type="radio"
                name="layoutWidth"
                value={option.value}
                checked={layoutWidth === option.value}
                onChange={() => setLayoutWidth(option.value)}
              />
              <span>
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </span>
            </label>
          ))}
        </div>
      </Card>

      <Card className="accountsFormCard">
        <div className="accountsCardHeader">
          <div>
            <h2>Import receipts</h2>
            <p className="muted">
              Paste a receipt email (Apple, Google, restaurant, anything) or drop an image. The AI extracts the
              line items and creates a linkable order. Run the enrichment backfill below afterwards to attach the
              order to a matching card transaction and derive the category from the items.
            </p>
          </div>
        </div>
        <div className="formGrid" style={{ gap: '0.75rem' }}>
          <Label htmlFor="settings-receipt-text">
            Paste receipt email body
            <textarea
              id="settings-receipt-text"
              value={receiptText}
              onChange={(e) => setReceiptText(e.target.value)}
              disabled={receiptBusy != null}
              rows={6}
              placeholder="Paste the full email body, including header lines like 'Order ID' and item lines…"
              style={{
                width: '100%',
                padding: '0.5rem',
                fontFamily: 'inherit',
                fontSize: '0.85rem',
                background: 'var(--bg)',
                color: 'var(--fg)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md, 6px)',
              }}
            />
          </Label>
          <div className="row" style={{ gap: '0.5rem' }}>
            <Button
              type="button"
              disabled={receiptBusy != null || !receiptText.trim()}
              onClick={() => void parseReceiptText()}
            >
              <Sparkles aria-hidden="true" />
              {receiptBusy === 'text' ? 'Parsing…' : 'Parse pasted text'}
            </Button>
            <label
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.5rem',
                cursor: 'pointer',
                color: 'var(--accent, currentColor)',
              }}
            >
              <input
                type="file"
                accept="image/png,image/jpeg,image/jpg,image/webp"
                disabled={receiptBusy != null}
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) void parseReceiptImage(file)
                  e.target.value = ''
                }}
              />
              <Sparkles aria-hidden="true" />
              {receiptBusy === 'image' ? 'Parsing image…' : 'Or upload a receipt image'}
            </label>
          </div>
          <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center', borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
            <div style={{ flex: 1, minWidth: '12rem' }}>
              <strong style={{ display: 'block' }}>Bulk: purchase-history CSV</strong>
              <span className="muted" style={{ fontSize: '0.85rem' }}>
                Apple ID → Account → Purchase History → Export CSV. Google Takeout → Google Pay → orders.csv.
              </span>
            </div>
            <select
              value={csvVendor}
              onChange={(e) => setCsvVendor(e.target.value as 'apple' | 'google' | 'amazon' | 'other')}
              disabled={receiptBusy != null}
              style={{
                padding: '0.4rem 0.5rem',
                background: 'var(--bg)',
                color: 'var(--fg)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md, 6px)',
              }}
            >
              <option value="apple">Apple</option>
              <option value="google">Google</option>
              <option value="amazon">Amazon</option>
              <option value="other">Other</option>
            </select>
            <label
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.5rem',
                cursor: 'pointer',
                color: 'var(--accent, currentColor)',
              }}
            >
              <input
                type="file"
                accept=".csv,text/csv"
                disabled={receiptBusy != null}
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) void uploadPurchaseHistoryCsv(file)
                  e.target.value = ''
                }}
              />
              <Sparkles aria-hidden="true" />
              {receiptBusy === 'csv' ? 'Importing CSV…' : 'Upload CSV'}
            </label>
          </div>
          {csvResult && (
            <div style={{ marginTop: '0.25rem', padding: '0.5rem 0.75rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-md, 6px)', fontSize: '0.85rem' }}>
              <div>
                <strong>{csvResult.fileName}</strong> ({csvResult.vendor})
              </div>
              <div className="muted">
                {csvResult.totalRows} rows · created {csvResult.createdOrders}, duplicates {csvResult.skippedDuplicates},
                {csvResult.unparsedRows > 0 ? ` skipped ${csvResult.unparsedRows} unparseable,` : ''}
                {csvResult.errors.length > 0 ? ` ${csvResult.errors.length} errored` : ' no errors'}
              </div>
              {Object.keys(csvResult.columnMapping).length > 0 && (
                <details style={{ marginTop: '0.35rem' }}>
                  <summary className="muted" style={{ cursor: 'pointer' }}>Column mapping ({Object.keys(csvResult.columnMapping).length})</summary>
                  <ul style={{ margin: '0.25rem 0 0', paddingLeft: '1.1rem' }}>
                    {Object.entries(csvResult.columnMapping).map(([h, role]) => (
                      <li key={h}><code>{h}</code> → {role}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
          {receiptError && (
            <span className="error" role="alert">{receiptError}</span>
          )}
          {receiptResult && (
            <div style={{ marginTop: '0.25rem', padding: '0.5rem 0.75rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-md, 6px)' }}>
              <div>
                <strong>{receiptResult.created ? 'Created' : 'Already on file'}:</strong>{' '}
                {receiptResult.extracted.vendorName ?? receiptResult.extracted.vendor}
                {receiptResult.extracted.orderDate && ` · ${receiptResult.extracted.orderDate}`}
                {receiptResult.extracted.total != null && ` · ${receiptResult.extracted.total} ${receiptResult.extracted.currency ?? ''}`}
              </div>
              {receiptResult.extracted.items.length > 0 && (
                <ul style={{ margin: '0.35rem 0 0', paddingLeft: '1.1rem', fontSize: '0.85rem' }}>
                  {receiptResult.extracted.items.slice(0, 8).map((item, i) => (
                    <li key={i}>
                      {item.title}
                      {item.quantity > 1 && ` × ${item.quantity}`}
                      {item.totalPrice != null && ` — ${item.totalPrice}`}
                      {item.inferredCategory && <span className="muted"> · {item.inferredCategory}</span>}
                    </li>
                  ))}
                  {receiptResult.extracted.items.length > 8 && (
                    <li className="muted">…+{receiptResult.extracted.items.length - 8} more</li>
                  )}
                </ul>
              )}
              <p className="muted" style={{ marginTop: '0.5rem', fontSize: '0.8rem' }}>
                Now run the backfill below (or wait for your next CSV import) — link-items will attach this
                order to the matching card transaction and derive its category.
              </p>
            </div>
          )}
        </div>
      </Card>

      <Card className="accountsFormCard">
        <div className="accountsCardHeader">
          <div>
            <h2>Enrichment maintenance</h2>
            <p className="muted">
              Re-runs the import enrichment pipeline against every transaction in your household. Useful after
              normalisation or rule changes. Override fields and already-reviewed rows are never touched.
            </p>
          </div>
        </div>
        <div className="formGrid" style={{ gap: '0.5rem' }}>
          <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={backfillClearReview}
              onChange={(e) => setBackfillClearReview(e.target.checked)}
              disabled={backfillRunning != null}
            />
            Clear review flag on rows the pipeline can now confidently categorise
          </label>
          <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={backfillReviewOnly}
              onChange={(e) => setBackfillReviewOnly(e.target.checked)}
              disabled={backfillRunning != null}
            />
            Only re-process rows currently in review
          </label>
          <Label htmlFor="settings-backfill-limit" style={{ maxWidth: '20rem' }}>
            Row limit (optional, for testing)
            <Input
              id="settings-backfill-limit"
              type="number"
              min={1}
              placeholder="all rows"
              value={backfillLimit}
              onChange={(e) => setBackfillLimit(e.target.value)}
              disabled={backfillRunning != null}
            />
          </Label>
        </div>
        <div className="row" style={{ gap: '0.5rem', marginTop: '0.75rem' }}>
          <Button
            type="button"
            variant="secondary"
            disabled={backfillRunning != null}
            onClick={() => void runBackfill('dry')}
          >
            <Sparkles aria-hidden="true" />
            {backfillRunning === 'dry' ? 'Running dry run…' : 'Dry run'}
          </Button>
          <Button
            type="button"
            disabled={backfillRunning != null}
            onClick={() => void runBackfill('real')}
          >
            <Sparkles aria-hidden="true" />
            {backfillRunning === 'real' ? 'Running backfill…' : 'Run backfill'}
          </Button>
        </div>
        {backfillError && (
          <span className="error" role="alert" style={{ marginTop: '0.5rem' }}>
            {backfillError}
          </span>
        )}
        {(backfillRunning || backfillLive || backfillSummary) && (
          <div style={{ marginTop: '0.75rem' }}>
            {backfillSummary ? (
              <p>
                <strong>
                  {backfillSummary.dryRun ? 'Dry run — no changes written.' : 'Backfill complete.'}
                </strong>{' '}
                Processed {backfillSummary.processed}, updated {backfillSummary.updated}, review flag cleared on{' '}
                {backfillSummary.reviewFlagCleared}, signals written {backfillSummary.signalsWritten}, skipped{' '}
                {backfillSummary.skipped} ({(backfillSummary.durationMs / 1000).toFixed(1)}s).
              </p>
            ) : backfillLive ? (
              <p className="muted">
                Streaming… processed {backfillLive.processed}, cleared {backfillLive.cleared}, skipped{' '}
                {backfillLive.skipped}
              </p>
            ) : null}
            {backfillErrors.length > 0 && (
              <details style={{ marginTop: '0.25rem' }}>
                <summary className="error">{backfillErrors.length} row(s) failed</summary>
                <ul style={{ fontSize: '0.8rem', marginTop: '0.25rem' }}>
                  {backfillErrors.slice(0, 20).map((e, i) => (
                    <li key={i}>txn {e.txnId ?? '?'}: {e.message}</li>
                  ))}
                </ul>
              </details>
            )}
            {backfillFeed.length > 0 && (
              <div
                style={{
                  marginTop: '0.5rem',
                  maxHeight: '18rem',
                  overflowY: 'auto',
                  borderTop: '1px solid var(--border)',
                  paddingTop: '0.5rem',
                  fontSize: '0.78rem',
                  lineHeight: 1.3,
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                }}
                role="log"
                aria-live="polite"
              >
                {backfillFeed.map((row) => (
                  <div key={row.txnId} style={{ display: 'flex', gap: '0.5rem', alignItems: 'baseline' }}>
                    <span className="muted" style={{ width: '4rem', textAlign: 'right' }}>#{row.txnId}</span>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {row.merchantRaw}
                    </span>
                    <span>
                      → <strong>{row.merchantCanonical ?? row.merchantClean}</strong>
                    </span>
                    <span className="muted" style={{ minWidth: '6rem' }}>
                      {row.autoSource ?? '—'}/{row.autoConfidence ?? '—'}
                    </span>
                    {row.reviewFlagCleared && <span style={{ color: 'var(--success, green)' }}>✓ cleared</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Card>

      <Card className="accountsFormCard">
        <div className="accountsCardHeader">
          <div>
            <h2>Enrichment dashboard</h2>
            <p className="muted">
              How the pipeline has labelled your household&apos;s transactions.
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" disabled={statsLoading} onClick={() => void loadStats()}>
            Refresh
          </Button>
        </div>
        {statsError && <span className="error" role="alert">{statsError}</span>}
        {statsLoading && !stats && <p className="muted">Loading…</p>}
        {stats && (
          <div style={{ display: 'grid', gap: '0.75rem' }}>
            <div className="row" style={{ gap: '1.5rem', flexWrap: 'wrap' }}>
              <div>
                <div className="muted" style={{ fontSize: '0.75rem' }}>Total transactions</div>
                <div style={{ fontSize: '1.4rem', fontWeight: 600 }}>{stats.total.toLocaleString()}</div>
              </div>
              <div>
                <div className="muted" style={{ fontSize: '0.75rem' }}>In review</div>
                <div style={{ fontSize: '1.4rem', fontWeight: 600 }}>
                  {stats.reviewFlagTrue.toLocaleString()}{' '}
                  <span className="muted" style={{ fontSize: '0.8rem', fontWeight: 400 }}>
                    ({stats.total ? Math.round((stats.reviewFlagTrue / stats.total) * 100) : 0}%)
                  </span>
                </div>
              </div>
              <div>
                <div className="muted" style={{ fontSize: '0.75rem' }}>Cleared</div>
                <div style={{ fontSize: '1.4rem', fontWeight: 600 }}>{stats.reviewFlagFalse.toLocaleString()}</div>
              </div>
              <div>
                <div className="muted" style={{ fontSize: '0.75rem' }}>Recurring</div>
                <div style={{ fontSize: '1.4rem', fontWeight: 600 }}>{stats.isRecurringCount.toLocaleString()}</div>
              </div>
              <div>
                <div className="muted" style={{ fontSize: '0.75rem' }}>Refunds linked</div>
                <div style={{ fontSize: '1.4rem', fontWeight: 600 }}>{stats.refundLinkedCount.toLocaleString()}</div>
              </div>
              <div>
                <div className="muted" style={{ fontSize: '0.75rem' }}>Transfers linked</div>
                <div style={{ fontSize: '1.4rem', fontWeight: 600 }}>{stats.transferLinkedCount.toLocaleString()}</div>
              </div>
            </div>

            <div className="row" style={{ gap: '2rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <div style={{ minWidth: '12rem' }}>
                <h3 style={{ marginBottom: '0.25rem' }}>By source</h3>
                <ul style={{ fontSize: '0.85rem', margin: 0, paddingLeft: '1rem' }}>
                  {Object.entries(stats.bySource)
                    .sort((a, b) => b[1] - a[1])
                    .map(([k, v]) => (
                      <li key={k}>
                        <code>{k}</code>: {v.toLocaleString()}
                      </li>
                    ))}
                </ul>
              </div>
              <div style={{ minWidth: '12rem' }}>
                <h3 style={{ marginBottom: '0.25rem' }}>By confidence</h3>
                <ul style={{ fontSize: '0.85rem', margin: 0, paddingLeft: '1rem' }}>
                  {Object.entries(stats.byConfidence)
                    .sort((a, b) => b[1] - a[1])
                    .map(([k, v]) => (
                      <li key={k}>
                        <code>{k}</code>: {v.toLocaleString()}
                      </li>
                    ))}
                </ul>
              </div>
              <div style={{ minWidth: '12rem' }}>
                <h3 style={{ marginBottom: '0.25rem' }}>By type</h3>
                <ul style={{ fontSize: '0.85rem', margin: 0, paddingLeft: '1rem' }}>
                  {Object.entries(stats.byTxnType)
                    .sort((a, b) => b[1] - a[1])
                    .map(([k, v]) => (
                      <li key={k}>
                        <code>{k}</code>: {v.toLocaleString()}
                      </li>
                    ))}
                </ul>
              </div>
            </div>

            <div className="row" style={{ gap: '2rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <div style={{ minWidth: '16rem', flex: 1 }}>
                <h3 style={{ marginBottom: '0.25rem' }}>Top canonical merchants</h3>
                {stats.topCanonicalMerchants.length === 0 ? (
                  <p className="muted" style={{ fontSize: '0.85rem' }}>
                    None yet. Run the backfill to populate.
                  </p>
                ) : (
                  <ul style={{ fontSize: '0.85rem', margin: 0, paddingLeft: '1rem' }}>
                    {stats.topCanonicalMerchants.map((m) => (
                      <li key={m.name}>
                        {m.name}: {m.count.toLocaleString()}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div style={{ minWidth: '16rem', flex: 1 }}>
                <h3 style={{ marginBottom: '0.25rem' }}>Top firing rules</h3>
                {stats.topRules.length === 0 ? (
                  <p className="muted" style={{ fontSize: '0.85rem' }}>
                    No rule matches recorded yet.
                  </p>
                ) : (
                  <ul style={{ fontSize: '0.85rem', margin: 0, paddingLeft: '1rem' }}>
                    {stats.topRules.map((r) => (
                      <li key={r.ruleId}>
                        <code>{r.pattern}</code> → {r.category ?? '(no category)'} · {r.count.toLocaleString()}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        )}
      </Card>

      <Card className="accountsFormCard">
        <div className="accountsCardHeader">
          <div>
            <h2>Partner invite</h2>
            <p className="muted">Invite links let another user join shared household reporting.</p>
          </div>
          <Button type="button" onClick={createInvite}>
            <Link2 aria-hidden="true" />
            Create invite
          </Button>
        </div>
        {inviteUrl && (
          <Input readOnly value={inviteUrl} onFocus={(e) => e.currentTarget.select()} />
        )}
      </Card>

      <Card className="accountsFormCard">
        <form onSubmit={createContact}>
          <div className="accountsCardHeader">
            <div>
              <h2>Contacts ledger</h2>
              <p className="muted">Contacts track loans and reimbursements without giving login access.</p>
            </div>
          </div>
          <div className="formGrid">
            <Label htmlFor="settings-contact-name">
              Name
              <Input
                id="settings-contact-name"
                name="name"
                required
                aria-invalid={hasError || undefined}
                aria-describedby={hasError ? errorId : undefined}
              />
            </Label>
            <Label htmlFor="settings-contact-notes">
              Notes
              <Input id="settings-contact-notes" name="notes" />
            </Label>
          </div>
          <Button type="submit">
            <Plus aria-hidden="true" />
            Add contact
          </Button>
        </form>
      </Card>

      {err && (
        <span className="error" id={errorId} role="alert">
          {err}
        </span>
      )}
      <section className="accountsGrid">
        {contacts.map((contact) => (
          <Card className="accountCard" key={contact.id}>
            <div>
              <h3>{contact.name}</h3>
              {contact.notes && <p className="muted">{contact.notes}</p>}
            </div>
            <div className="row">
              <Button type="button" size="sm" variant="secondary" onClick={() => openRename(contact)}>
                <Edit3 aria-hidden="true" />
                Edit
              </Button>
              <Button type="button" size="sm" variant="destructive" onClick={() => void removeContact(contact)}>
                <Trash2 aria-hidden="true" />
                Delete
              </Button>
            </div>
          </Card>
        ))}
      </section>
    </div>
    {renameTarget && (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) closeRename()
        }}
      >
        <DialogHeader>
          <DialogTitle>Rename contact</DialogTitle>
        </DialogHeader>
        <form onSubmit={submitRename}>
          <DialogBody>
            <Label htmlFor="settings-rename-name">
              Contact name
              <Input
                id="settings-rename-name"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                required
                autoComplete="off"
              />
            </Label>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeRename}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={renameSaving || !renameValue.trim() || renameValue.trim() === renameTarget.name}
            >
              Save
            </Button>
          </DialogFooter>
        </form>
      </Dialog>
    )}
    {confirm.dialog}
    </>
  )
}
