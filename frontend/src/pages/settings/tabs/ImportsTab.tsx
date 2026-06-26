import { useEffect, useRef, useState } from 'react'
import { Button } from '@connor-adams/designsystem'
import { Icon } from '@connor-adams/designsystem'
import { Card } from '@connor-adams/designsystem'
import { Input } from '@connor-adams/designsystem'
import { Textarea } from '@connor-adams/designsystem'
import { useConfirm } from '@/lib/ds-extras'
import { postJson } from '../../../lib/api'
import { formatMoney } from '../../../lib/formatMoney'
import {
  listCaptureTokens,
  mintCaptureToken,
  revokeCaptureToken,
  type CaptureTokenRow,
} from '../../../lib/captureTokens'
import { CounterpartyBackfillCard } from './imports/CounterpartyBackfillCard'
import { InteracSyncCard } from './imports/InteracSyncCard'
import { SimplefinConnectCard } from './imports/SimplefinConnectCard'

// ---------------------------------------------------------------------------
// Types (inlined from SettingsPage.tsx — no shared type file yet)
// ---------------------------------------------------------------------------

type ReceiptImportItem = {
  title: string
  quantity: number
  unitPrice: number | null
  totalPrice: number | null
  inferredCategory: string | null
}

type ReceiptImportTender = {
  paymentLast4: string | null
  network: string | null
  amount: number
}

type ReceiptImportResult = {
  order: { id: number; vendor: string; total: string | null; currency: string; orderDate: string | null }
  created: boolean
  extracted: {
    vendor: string
    vendorName: string | null
    orderDate: string | null
    orderId: string | null
    subtotal?: number | null
    tax?: number | null
    total: number | null
    currency: string | null
    paymentLast4: string | null
    tenders?: ReceiptImportTender[]
    items: ReceiptImportItem[]
    notes: string | null
  }
  /** Only populated by /import-pdf today. */
  warnings?: string[]
  parserId?: string
  match?: {
    created: number
    updated: number
    tendersProcessed: number
    candidatesScanned: number
  }
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

// ---------------------------------------------------------------------------
// Module-level helper (mirrors postFormDataFile in SettingsPage.tsx)
// ---------------------------------------------------------------------------

async function postFormDataFile<T>(endpoint: string, file: File): Promise<T> {
  const fd = new FormData()
  fd.append('file', file)
  const base = import.meta.env.VITE_API_BASE ?? ''
  const res = await fetch(`${base}${endpoint}`, {
    method: 'POST',
    credentials: 'include',
    body: fd,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(text || `HTTP ${res.status}`)
  }
  return (await res.json()) as T
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ImportsTab() {
  const confirm = useConfirm()

  // ── Import receipts state ────────────────────────────────────────────────
  const [receiptText, setReceiptText] = useState('')
  const [receiptBusy, setReceiptBusy] = useState<'text' | 'image' | 'csv' | 'pdf' | null>(null)
  const [receiptError, setReceiptError] = useState<string | null>(null)
  const [receiptResult, setReceiptResult] = useState<ReceiptImportResult | null>(null)
  const [csvVendor, setCsvVendor] = useState<'apple' | 'google' | 'amazon' | 'other'>('apple')
  const [csvResult, setCsvResult] = useState<PurchaseHistoryCsvResult | null>(null)

  // ── Receipt capture state ────────────────────────────────────────────────
  const [captureToken, setCaptureToken] = useState<CaptureTokenRow | null>(null)
  const [captureTokenPlaintext, setCaptureTokenPlaintext] = useState<string | null>(null)
  const [captureBookmarklets, setCaptureBookmarklets] = useState<{
    amazon: string
    apple: string
  } | null>(null)
  const [captureLoading, setCaptureLoading] = useState(false)
  const [captureError, setCaptureError] = useState<string | null>(null)

  // ── Capture paste fallback state (for sites whose CSP blocks the direct fetch)
  const [captureFromPasteText, setCaptureFromPasteText] = useState('')
  const [captureFromPasteBusy, setCaptureFromPasteBusy] = useState(false)
  const [captureFromPasteError, setCaptureFromPasteError] = useState<string | null>(null)
  const [captureFromPasteResult, setCaptureFromPasteResult] = useState<{
    created: number
    updated: number
    skipped: number
  } | null>(null)

  const mountedRef = useRef(true)
  useEffect(() => {
    return () => {
      mountedRef.current = false
    }
  }, [])

  // React 18+ blocks `javascript:` URLs in href props. Set them imperatively
  // via setAttribute after mount so the bookmarklet links remain draggable.
  const amazonAnchorRef = useRef<HTMLAnchorElement>(null)
  const appleAnchorRef = useRef<HTMLAnchorElement>(null)
  useEffect(() => {
    if (!captureBookmarklets) return
    amazonAnchorRef.current?.setAttribute('href', captureBookmarklets.amazon)
    appleAnchorRef.current?.setAttribute('href', captureBookmarklets.apple)
  }, [captureBookmarklets])

  useEffect(() => {
    void (async () => {
      try {
        const rows = await listCaptureTokens()
        if (!mountedRef.current) return
        setCaptureToken(rows[0] ?? null)
      } catch (e) {
        if (!mountedRef.current) return
        setCaptureError(e instanceof Error ? e.message : 'Could not load capture tokens')
      }
    })()
  }, [])

  // ── Import receipts handlers ─────────────────────────────────────────────

  async function uploadPurchaseHistoryCsv(file: File) {
    if (receiptBusy) return
    setReceiptBusy('csv')
    setReceiptError(null)
    setCsvResult(null)
    try {
      setCsvResult(await postFormDataFile<PurchaseHistoryCsvResult>(`/api/external-orders/import-csv?vendor=${csvVendor}`, file))
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

  async function uploadReceiptFile(
    file: File,
    busy: 'image' | 'pdf',
    endpoint: string,
    errorLabel: string,
  ) {
    if (receiptBusy) return
    setReceiptBusy(busy)
    setReceiptError(null)
    setReceiptResult(null)
    try {
      setReceiptResult(await postFormDataFile<ReceiptImportResult>(endpoint, file))
    } catch (e) {
      setReceiptError(e instanceof Error ? e.message : errorLabel)
    } finally {
      setReceiptBusy(null)
    }
  }

  function parseReceiptImage(file: File) {
    return uploadReceiptFile(file, 'image', '/api/external-orders/import-image', 'Image parse failed')
  }

  function parseReceiptPdf(file: File) {
    return uploadReceiptFile(file, 'pdf', '/api/external-orders/import-pdf', 'PDF parse failed')
  }

  // ── Receipt capture handlers ─────────────────────────────────────────────

  async function buildBookmarkletHref(
    name: 'amazon' | 'apple',
    token: string,
  ): Promise<string> {
    const sourceRes = await fetch(`/bookmarklets/${name}.js`)
    if (!sourceRes.ok) {
      throw new Error(
        `Could not load bookmarklet bundle (${sourceRes.status}). Run yarn build:bookmarklets if you're in dev.`,
      )
    }
    const source = await sourceRes.text()
    const apiUrl = `${window.location.origin}/api/capture/orders`
    // Wrap in outer IIFE so __CFC_TOKEN__ / __CFC_API__ stay in closure
    // and don't leak onto window for other scripts on the vendor page to read.
    const full = `(function(){var __CFC_TOKEN__=${JSON.stringify(token)};var __CFC_API__=${JSON.stringify(apiUrl)};${source}})()`
    return `javascript:${encodeURIComponent(full)}`
  }

  async function mintNewCaptureToken() {
    if (captureLoading) return
    setCaptureLoading(true)
    setCaptureError(null)
    try {
      const result = await mintCaptureToken('Browser')
      if (!mountedRef.current) return
      setCaptureToken({
        id: result.id,
        label: result.label,
        lastUsedAt: null,
        createdAt: result.createdAt,
        expiresAt: result.expiresAt,
      })
      setCaptureTokenPlaintext(result.plaintext)
      const [amazonHref, appleHref] = await Promise.all([
        buildBookmarkletHref('amazon', result.plaintext),
        buildBookmarkletHref('apple', result.plaintext),
      ])
      if (!mountedRef.current) return
      setCaptureBookmarklets({ amazon: amazonHref, apple: appleHref })
    } catch (e) {
      if (!mountedRef.current) return
      setCaptureError(e instanceof Error ? e.message : 'Mint failed')
    } finally {
      if (mountedRef.current) setCaptureLoading(false)
    }
  }

  async function revokeActiveToken() {
    if (!captureToken) return
    const ok = await confirm({
      title: 'Revoke capture token?',
      description:
        'Existing bookmarklets that use this token will stop working. You can mint a new one after.',
      confirmLabel: 'Revoke',
      destructive: true,
    })
    if (!ok) return
    try {
      await revokeCaptureToken(captureToken.id)
      if (!mountedRef.current) return
      setCaptureToken(null)
      setCaptureTokenPlaintext(null)
      setCaptureBookmarklets(null)
    } catch (e) {
      if (!mountedRef.current) return
      setCaptureError(e instanceof Error ? e.message : 'Revoke failed')
    }
  }

  async function submitCaptureFromPaste() {
    if (captureFromPasteBusy) return
    setCaptureFromPasteBusy(true)
    setCaptureFromPasteError(null)
    setCaptureFromPasteResult(null)
    try {
      const raw = captureFromPasteText.trim()
      if (!raw) throw new Error('Paste the JSON output by the bookmarklet first.')
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw new Error('Pasted content is not valid JSON.')
      }
      const result = await postJson<{ created: number; updated: number; skipped: number }>(
        '/api/capture/orders-from-paste',
        parsed,
      )
      if (!mountedRef.current) return
      setCaptureFromPasteResult(result)
      setCaptureFromPasteText('')
    } catch (e) {
      if (!mountedRef.current) return
      setCaptureFromPasteError(e instanceof Error ? e.message : 'Paste import failed')
    } finally {
      if (mountedRef.current) setCaptureFromPasteBusy(false)
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <>
      {confirm.dialog}
      {/* ── Import receipts ─────────────────────────────────────────────── */}
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
        <div className="mb-3 grid gap-3 grid-cols-[repeat(auto-fill,minmax(min(100%,180px),1fr))]">
          <label htmlFor="settings-receipt-text" className="flex flex-col gap-1 text-[0.82rem]">
            Paste receipt email body
            <Textarea
              id="settings-receipt-text"
              value={receiptText}
              onChange={(e) => setReceiptText(e.target.value)}
              disabled={receiptBusy != null}
              rows={6}
              placeholder="Paste the full email body, including header lines like 'Order ID' and item lines…"
            />
          </label>
          <div className="row" style={{ gap: '0.5rem' }}>
            <Button
              type="button"
              disabled={receiptBusy != null || !receiptText.trim()}
              onClick={() => void parseReceiptText()}
            >
              <Icon name="sparkles" aria-hidden="true" />
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
              <Icon name="sparkles" aria-hidden="true" />
              {receiptBusy === 'image' ? 'Parsing image…' : 'Or upload a receipt image'}
            </label>
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
                accept="application/pdf,.pdf"
                disabled={receiptBusy != null}
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) void parseReceiptPdf(file)
                  e.target.value = ''
                }}
              />
              <Icon name="sparkles" aria-hidden="true" />
              {receiptBusy === 'pdf' ? 'Parsing PDF…' : 'Or upload a receipt PDF (Costco)'}
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
              <Icon name="sparkles" aria-hidden="true" />
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
                {receiptResult.extracted.total != null && ` · ${formatMoney(Number(receiptResult.extracted.total), receiptResult.extracted.currency ?? undefined)}`}
              </div>
              {receiptResult.extracted.tenders && receiptResult.extracted.tenders.length > 1 && (
                <div className="muted" style={{ marginTop: '0.25rem', fontSize: '0.85rem' }}>
                  Split tender:{' '}
                  {receiptResult.extracted.tenders
                    .map((t) => `${t.network ?? 'card'}${t.paymentLast4 ? ` ••${t.paymentLast4}` : ''} ${formatMoney(Number(t.amount), receiptResult.extracted.currency ?? undefined)}`)
                    .join(' + ')}
                </div>
              )}
              {receiptResult.match && (
                <div className="muted" style={{ marginTop: '0.25rem', fontSize: '0.85rem' }}>
                  Auto-linked {receiptResult.match.created + receiptResult.match.updated} of{' '}
                  {receiptResult.match.tendersProcessed} payment(s) to card transactions
                  {receiptResult.match.candidatesScanned > 0
                    ? ` (scanned ${receiptResult.match.candidatesScanned} candidates)`
                    : ''}
                  .
                </div>
              )}
              {receiptResult.warnings && receiptResult.warnings.length > 0 && (
                <details style={{ marginTop: '0.25rem' }}>
                  <summary className="muted" style={{ cursor: 'pointer', fontSize: '0.85rem' }}>
                    Parser warnings ({receiptResult.warnings.length})
                  </summary>
                  <ul style={{ margin: '0.25rem 0 0', paddingLeft: '1.1rem', fontSize: '0.85rem' }}>
                    {receiptResult.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </details>
              )}
              {receiptResult.extracted.items.length > 0 && (
                <ul style={{ margin: '0.35rem 0 0', paddingLeft: '1.1rem', fontSize: '0.85rem' }}>
                  {receiptResult.extracted.items.slice(0, 8).map((item, i) => (
                    <li key={i}>
                      {item.title}
                      {item.quantity > 1 && ` × ${item.quantity}`}
                      {item.totalPrice != null && ` — ${formatMoney(item.totalPrice, receiptResult.extracted.currency ?? undefined)}`}
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

      {/* ── Receipt capture ──────────────────────────────────────────────── */}
      <Card className="accountsFormCard">
        <div className="accountsCardHeader">
          <div>
            <h2>Receipt capture</h2>
            <p className="muted">
              Capture itemised order data from Amazon and Apple without forwarding emails. Mint a
              personal token, then drag the bookmarklets to your bookmark bar.
            </p>
          </div>
          {captureToken ? (
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
              disabled={captureLoading}
              onClick={() => void mintNewCaptureToken()}
            >
              {captureLoading ? 'Minting…' : 'Mint capture token'}
            </Button>
          )}
        </div>
        {captureError && (
          <span className="error" role="alert">
            {captureError}
          </span>
        )}
        {captureTokenPlaintext && (
          <>
            <p className="muted">
              Token created — copy or install now. You won't see it again after you leave this
              page.
              {captureToken?.expiresAt && (
                <> It expires {new Date(captureToken.expiresAt).toLocaleDateString()}; re-mint before then.</>
              )}
            </p>
            <Input
              readOnly
              autoComplete="off"
              value={captureTokenPlaintext}
              onFocus={(e) => e.currentTarget.select()}
            />
          </>
        )}
        {captureToken && !captureTokenPlaintext && (
          <p className="muted">
            Active token: <code>{captureToken.label}</code>
            {captureToken.lastUsedAt && (
              <> · Last used {new Date(captureToken.lastUsedAt).toLocaleString()}</>
            )}
            {captureToken.expiresAt &&
              (new Date(captureToken.expiresAt).getTime() <= Date.now() ? (
                <>
                  {' '}
                  ·{' '}
                  <span className="error">
                    Expired {new Date(captureToken.expiresAt).toLocaleDateString()} — revoke and
                    mint a new one
                  </span>
                </>
              ) : (
                <> · Expires {new Date(captureToken.expiresAt).toLocaleDateString()}</>
              ))}
          </p>
        )}
        {captureBookmarklets && (
          <div className="row" style={{ gap: '0.5rem', marginTop: '0.75rem' }}>
            <a
              ref={amazonAnchorRef}
              draggable
              onClick={(e) => e.preventDefault()}
            >
              <Button variant="secondary">↗ Capture Amazon orders</Button>
            </a>
            <a
              ref={appleAnchorRef}
              draggable
              onClick={(e) => e.preventDefault()}
            >
              <Button variant="secondary">↗ Capture Apple purchases</Button>
            </a>
          </div>
        )}
        {captureToken && !captureBookmarklets && (
          <p className="muted">
            <em>
              Bookmarklet links are only shown immediately after minting. Re-mint if you need to
              install them on a new browser.
            </em>
          </p>
        )}

        <div className="mt-4 grid gap-2 border-t border-border pt-3 grid-cols-[repeat(auto-fill,minmax(min(100%,180px),1fr))]">
          <div>
            <strong style={{ display: 'block' }}>Paste captured orders</strong>
            <span className="muted" style={{ fontSize: '0.85rem' }}>
              Fallback for vendor pages (e.g. reportaproblem.apple.com) whose CSP blocks the
              bookmarklet's direct upload. The bookmarklet copies the captured JSON to your
              clipboard — paste it here to import.
            </span>
          </div>
          <Textarea
            value={captureFromPasteText}
            onChange={(e) => setCaptureFromPasteText(e.target.value)}
            disabled={captureFromPasteBusy}
            rows={4}
            placeholder='{"vendor":"apple","orders":[…]}'
          />
          <div className="row" style={{ gap: '0.5rem' }}>
            <Button
              type="button"
              disabled={captureFromPasteBusy || !captureFromPasteText.trim()}
              onClick={() => void submitCaptureFromPaste()}
            >
              {captureFromPasteBusy ? 'Importing…' : 'Import pasted capture'}
            </Button>
          </div>
          {captureFromPasteError && (
            <span className="error" role="alert">
              {captureFromPasteError}
            </span>
          )}
          {captureFromPasteResult && (
            <div
              style={{
                padding: '0.5rem 0.75rem',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md, 6px)',
                fontSize: '0.85rem',
              }}
            >
              Imported {captureFromPasteResult.created} new,{' '}
              {captureFromPasteResult.updated} updated,{' '}
              {captureFromPasteResult.skipped} unchanged.
            </div>
          )}
        </div>
      </Card>
      {/* ── SimpleFIN Bridge bank connection (issue #790) ───────────────── */}
      <SimplefinConnectCard />
      {/* ── Counterparty backfill (issue #376) ──────────────────────────── */}
      <CounterpartyBackfillCard />
      {/* ── Interac email counterparty sync ─────────────────────────────── */}
      <InteracSyncCard />
    </>
  )
}
