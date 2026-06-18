import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Check,
  LinkIcon,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { useConfirm } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { deleteReq, getJson, patchJson, postFormData, postJson } from '../lib/api'
import { formatMoney } from '../lib/formatMoney'
import { formatSyncAge } from '../lib/formatSyncAge'

type AmazonItem = {
  id: number
  title: string
  quantity: number
  unitPrice: string | null
  totalPrice: string | null
  inferredCategory: string | null
  businessUsePercent: string | null
  confidence: string | null
}

type AmazonOrder = {
  id: number
  vendorOrderId: string | null
  orderDate: string | null
  shipmentDate: string | null
  total: string | null
  currency: string
  paymentLast4: string | null
  source: string
  items?: AmazonItem[]
}

type AmazonLink = {
  id: number
  confidence: string
  matchReason: string
  status: 'suggested' | 'accepted' | 'rejected'
  order?: AmazonOrder
}

type AmazonTransaction = {
  id: number
  date: string
  merchantClean: string
  amount: string
  currency: string
  orderLinks?: AmazonLink[]
}

type ImportSummary = {
  created: number
  skipped: number
  failed: number
  importedItems: number
  failedRows: Array<{ rowIndex: number; message: string }>
}

type AiCategorizeResult = {
  categorizationId: number
  updated: number
  suggestions: Array<{
    itemId: number
    category: string
    businessUsePercent: number | null
    confidence: number
    rationale: string
  }>
}

// Confidence values are stored as DECIMAL(5,2) strings on a 0–100 scale
// (see backend/src/amazon/matcher.ts and aiCategorizeAmazonItems.ts:clampConfidence).
// Number(confidence) is already the whole-percent value — no multiplier needed.
const confidenceLabel = (n: number) => {
  if (n >= 90) return 'High'
  if (n >= 70) return 'Medium'
  return 'Low'
}

const confidenceColor = (n: number): string => {
  if (n >= 90) return 'var(--primary)'
  if (n >= 70) return 'var(--chart-2)'
  return 'var(--muted-foreground)'
}

const AI_DISABLED_TITLE =
  'AI categorization unavailable — OpenAI not configured for this session (check OPENAI_API_KEY or whether you are using the demo account)'

function itemPreview(order?: AmazonOrder): string {
  const items = order?.items ?? []
  if (!items.length) return 'No items'
  return items
    .slice(0, 3)
    .map((item) => `${item.title}${item.inferredCategory ? ` (${item.inferredCategory})` : ''}`)
    .join(' · ')
}

function categoryPreview(order?: AmazonOrder): string {
  const counts = new Map<string, number>()
  for (const item of order?.items ?? []) {
    const category = item.inferredCategory || 'Uncategorized'
    counts.set(category, (counts.get(category) ?? 0) + 1)
  }
  const rows = Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  return rows.length
    ? rows.map(([category, count]) => `${category}${count > 1 ? ` x${count}` : ''}`).join(' · ')
    : '—'
}

export function AmazonPage({ embedded = false }: { embedded?: boolean } = {}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const confirm = useConfirm()
  const [orders, setOrders] = useState<AmazonOrder[]>([])
  const [txns, setTxns] = useState<AmazonTransaction[]>([])
  const [categories, setCategories] = useState<string[]>([])
  const [summary, setSummary] = useState<ImportSummary | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [aiEnabled, setAiEnabled] = useState(false)
  const [aiStatusLoaded, setAiStatusLoaded] = useState(false)
  const [aiCategorizing, setAiCategorizing] = useState(false)
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(null)
  const [selectedOrder, setSelectedOrder] = useState<AmazonOrder | null>(null)
  const [manualOrderByTxn, setManualOrderByTxn] = useState<Record<number, string>>({})
  const [itemPriceErrors, setItemPriceErrors] = useState<Record<number, string>>({})
  const [syncStatus, setSyncStatus] = useState<{ orderCount: number; lastCapturedAt: string | null } | null>(null)

  const refresh = useCallback(async () => {
    const [orderRows, txnRows, categoryRows, sync] = await Promise.all([
      getJson<AmazonOrder[]>('/api/amazon/orders?limit=50'),
      getJson<AmazonTransaction[]>('/api/amazon/review-transactions'),
      getJson<{ categories: string[] }>('/api/amazon/categories'),
      getJson<{ orderCount: number; lastCapturedAt: string | null }>('/api/amazon/sync-status'),
    ])
    setOrders(orderRows)
    setTxns(txnRows)
    setCategories(categoryRows.categories)
    setSyncStatus(sync)
  }, [])

  useEffect(() => {
    void refresh().catch((e: Error) => setMessage(e.message))
  }, [refresh])

  useEffect(() => {
    void getJson<{ openai: boolean }>('/api/ai/status')
      .then((status) => {
        setAiEnabled(status.openai)
        setAiStatusLoaded(true)
      })
      .catch(() => {
        setAiEnabled(false)
        setAiStatusLoaded(true)
      })
  }, [])

  useEffect(() => {
    if (selectedOrderId == null) {
      setSelectedOrder(null)
      return
    }
    void getJson<AmazonOrder>(`/api/amazon/orders/${selectedOrderId}`)
      .then(setSelectedOrder)
      .catch((e: Error) => setMessage(e.message))
  }, [selectedOrderId])

  async function onUpload(event: React.FormEvent) {
    event.preventDefault()
    const file = fileRef.current?.files?.[0]
    if (!file) {
      setMessage('Choose an Amazon report CSV first.')
      return
    }
    setLoading(true)
    setMessage(null)
    try {
      const form = new FormData()
      form.append('file', file)
      const result = await postFormData<ImportSummary>('/api/amazon/import', form)
      setSummary(result)
      await refresh()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Upload failed')
    } finally {
      setLoading(false)
    }
  }

  async function runMatching() {
    setLoading(true)
    setMessage(null)
    try {
      const result = await postJson<{ suggested: number; scannedTransactions: number }>(
        '/api/amazon/match/run',
      )
      setMessage(`Created ${result.suggested} suggestion(s) from ${result.scannedTransactions} Amazon-like transaction(s).`)
      await refresh()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Matching failed')
    } finally {
      setLoading(false)
    }
  }

  async function runAiCategorization(orderId?: number) {
    if (!aiStatusLoaded) {
      setMessage('AI status is still loading. Try again in a moment.')
      return
    }
    if (!aiEnabled) {
      setMessage('AI categorization is unavailable for this session. Check OpenAI configuration or whether you are using the demo account.')
      return
    }
    setAiCategorizing(true)
    setMessage(orderId ? 'AI categorizing this Amazon order...' : 'AI categorizing the next 100 Amazon items...')
    try {
      const result = await postJson<AiCategorizeResult>('/api/amazon/categorize/run', {
        orderId,
        limit: orderId ? undefined : 100,
      })
      setMessage(`AI categorized ${result.updated} Amazon item(s).`)
      if (selectedOrderId != null) {
        const order = await getJson<AmazonOrder>(`/api/amazon/orders/${selectedOrderId}`)
        setSelectedOrder(order)
      }
      await refresh()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'AI categorization failed')
    } finally {
      setAiCategorizing(false)
    }
  }

  async function linkAction(path: string) {
    setLoading(true)
    try {
      await postJson(path)
      await refresh()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Link update failed')
    } finally {
      setLoading(false)
    }
  }

  async function unlink(id: number) {
    const ok = await confirm({
      title: 'Unlink order from transaction?',
      description: "This won't delete either. You can re-link later.",
      confirmLabel: 'Unlink',
      cancelLabel: 'Keep linked',
    })
    if (!ok) return
    setLoading(true)
    try {
      await deleteReq(`/api/amazon/links/${id}`)
      await refresh()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Unlink failed')
    } finally {
      setLoading(false)
    }
  }

  async function manualLink(transactionId: number) {
    const externalOrderId = Number(manualOrderByTxn[transactionId])
    if (!externalOrderId) return
    setLoading(true)
    try {
      await postJson('/api/amazon/links/manual', { transactionId, externalOrderId })
      await refresh()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Manual link failed')
    } finally {
      setLoading(false)
    }
  }

  async function updateItem(item: AmazonItem, patch: Partial<AmazonItem>) {
    if (!selectedOrder) return
    // Validate totalPrice — block negative values per AC #1 of issue #262.
    if (Object.prototype.hasOwnProperty.call(patch, 'totalPrice')) {
      const raw = patch.totalPrice
      const isEmpty = raw == null || raw === ''
      const num = isEmpty ? null : Number(raw)
      if (num != null && Number.isFinite(num) && num < 0) {
        setItemPriceErrors((prev) => ({ ...prev, [item.id]: "Price can't be negative." }))
        // Still update the local form value so the user sees what they typed,
        // but block the network save until they fix it.
        const nextOptimistic = { ...item, ...patch }
        setSelectedOrder({
          ...selectedOrder,
          items: (selectedOrder.items ?? []).map((row) => (row.id === item.id ? nextOptimistic : row)),
        })
        return
      }
      // Clear any prior error on this item when the new value is valid (or cleared).
      setItemPriceErrors((prev) => {
        if (!(item.id in prev)) return prev
        const { [item.id]: _drop, ...rest } = prev
        void _drop
        return rest
      })
    }
    const next = { ...item, ...patch }
    setSelectedOrder({
      ...selectedOrder,
      items: (selectedOrder.items ?? []).map((row) => (row.id === item.id ? next : row)),
    })
    try {
      await patchJson(`/api/amazon/orders/${selectedOrder.id}/items/${item.id}`, patch)
      await refresh()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Item update failed')
    }
  }

  return (
    <div className={embedded ? 'amazonPage' : 'page amazonPage'}>
      {confirm.dialog}
      <div className="amazonHeader">
        {!embedded && (
          <div>
            <h1>Amazon Enrichment</h1>
            <p className="text-sm leading-6 text-muted-foreground">Import Amazon order reports, match them to card charges, and review item-level categories.</p>
          </div>
        )}
        <div className="amazonActionRow">
          {syncStatus && (
            <span className="text-sm leading-6 text-muted-foreground" title={syncStatus.lastCapturedAt ?? 'No Amazon orders captured yet'}>
              {formatSyncAge(syncStatus.lastCapturedAt)} · {syncStatus.orderCount} order{syncStatus.orderCount === 1 ? '' : 's'}
            </span>
          )}
          <Button type="button" variant="secondary" onClick={runMatching} disabled={loading}>
            <RefreshCw aria-hidden="true" />
            Run matching
          </Button>
          <Button
            type="button"
            onClick={() => void runAiCategorization()}
            disabled={aiCategorizing || (aiStatusLoaded && !aiEnabled)}
            title={
              aiStatusLoaded && !aiEnabled
                ? AI_DISABLED_TITLE
                : 'Categorize imported Amazon items with AI'
            }
            aria-disabled={aiStatusLoaded && !aiEnabled ? true : undefined}
          >
            <Sparkles aria-hidden="true" />
            {aiCategorizing ? 'Categorizing...' : 'AI categorize'}
          </Button>
        </div>
      </div>

      {message && <Alert variant="error" className="mb-4">{message}</Alert>}

      {syncStatus?.orderCount === 0 && txns.length === 0 && (
        <EmptyState
          title="No Amazon data yet"
          description="Install the Cashflow Amazon Capture extension, paste a capture token from Settings → Imports, then open Amazon → Your Orders. Captured orders appear here automatically and match to your card charges."
        />
      )}

      <Card className="amazonImportPanel">
        <form onSubmit={onUpload} className="contents">
          <div>
            <h2>Amazon Import</h2>
            <p className="text-sm leading-6 text-muted-foreground">Upload an Amazon report CSV. Re-uploading the same rows is safe.</p>
          </div>
          <Label htmlFor="amazonImportFile">
            CSV file
            <Input
              ref={fileRef}
              id="amazonImportFile"
              type="file"
              accept=".csv,text/csv"
            />
          </Label>
          <Button type="submit" disabled={loading}>
            <Upload aria-hidden="true" />
            Upload CSV
          </Button>
        </form>
      </Card>

      {summary && (
        <section className="amazonSummaryGrid mb-4">
          <Card><strong>{summary.created}</strong><span>Orders created</span></Card>
          <Card><strong>{summary.skipped}</strong><span>Skipped</span></Card>
          <Card><strong>{summary.importedItems}</strong><span>Items imported</span></Card>
          <Card><strong>{summary.failed}</strong><span>Failed rows</span></Card>
        </section>
      )}

      <Card>
        <h2>Amazon Review</h2>
        <div className="amazonReviewList">
          {txns.map((txn) => (
            <article key={txn.id} className="amazonReviewRow">
              <div>
                <strong>{txn.merchantClean}</strong>
                <div className="text-sm leading-6 text-muted-foreground">{txn.date} · {formatMoney(Number(txn.amount), txn.currency)}</div>
              </div>
              <div className="amazonLinks">
                {(txn.orderLinks ?? []).map((link) => (
                  <div key={link.id} className="amazonSuggestedLink">
                    <div>
                      {(() => {
                        const pct = Math.round(Number(link.confidence))
                        const valid = Number.isFinite(pct)
                        return (
                          <strong style={{ color: valid ? confidenceColor(pct) : undefined }}>
                            {valid ? `${pct}% (${confidenceLabel(pct)})` : '—'}
                          </strong>
                        )
                      })()}
                      <span className="text-sm leading-6 text-muted-foreground">{link.status} · {link.matchReason}</span>
                      <span>{itemPreview(link.order)}</span>
                      <span className="text-sm leading-6 text-muted-foreground">{categoryPreview(link.order)}</span>
                    </div>
                    <div className="amazonActionRow">
                      <Button type="button" onClick={() => void linkAction(`/api/amazon/links/${link.id}/accept`)} disabled={loading}>
                        <Check aria-hidden="true" />
                        Accept
                      </Button>
                      <Button type="button" variant="secondary" onClick={() => void linkAction(`/api/amazon/links/${link.id}/reject`)} disabled={loading}>
                        <X aria-hidden="true" />
                        Reject
                      </Button>
                      <Button type="button" variant="ghost" onClick={() => link.order && setSelectedOrderId(link.order.id)}>
                        <Search aria-hidden="true" />
                        View/Edit
                      </Button>
                      <Button type="button" variant="destructive" onClick={() => void unlink(link.id)} disabled={loading}>
                        <Trash2 aria-hidden="true" />
                        Unlink
                      </Button>
                    </div>
                  </div>
                ))}
                <div className="amazonManualLink">
                  <NativeSelect
                    aria-label={`Manually link order to ${txn.merchantClean}`}
                    value={manualOrderByTxn[txn.id] ?? ''}
                    onChange={(event) => setManualOrderByTxn((prev) => ({ ...prev, [txn.id]: event.target.value }))}
                  >
                    <NativeSelectOption value="">Manually link order...</NativeSelectOption>
                    {orders.map((order) => (
                      <NativeSelectOption key={order.id} value={order.id}>
                        #{order.id} {order.orderDate ?? order.shipmentDate ?? 'No date'} {order.total ? formatMoney(Number(order.total), order.currency) : ''}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                  <Button type="button" onClick={() => void manualLink(txn.id)} disabled={loading || !manualOrderByTxn[txn.id]}>
                    <LinkIcon aria-hidden="true" />
                    Link
                  </Button>
                </div>
              </div>
            </article>
          ))}
          {txns.length === 0 && syncStatus?.orderCount !== 0 && (
            <EmptyState title="No Amazon-like transactions found." />
          )}
        </div>
      </Card>

      <Card>
        <h2>Recent Imported Orders</h2>
        <Table>
          <TableHeader>
            <TableRow><TableHead>Order</TableHead><TableHead>Date</TableHead><TableHead>Total</TableHead><TableHead>Categories</TableHead><TableHead>Items</TableHead><TableHead></TableHead></TableRow>
          </TableHeader>
          <TableBody>
            {orders.map((order) => (
              <TableRow key={order.id}>
                <TableCell>{order.vendorOrderId ?? `#${order.id}`}</TableCell>
                <TableCell>{order.orderDate ?? order.shipmentDate ?? '—'}</TableCell>
                <TableCell>{order.total ? formatMoney(Number(order.total), order.currency) : '—'}</TableCell>
                <TableCell>{categoryPreview(order)}</TableCell>
                <TableCell>{itemPreview(order)}</TableCell>
                <TableCell>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setSelectedOrderId(order.id)}>
                    View/Edit
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {selectedOrder && (
        <Card className="amazonOrderEditor">
          <div className="amazonHeader">
            <div>
              <h2>Order Detail/Edit</h2>
              <p className="text-sm leading-6 text-muted-foreground">
                {selectedOrder.vendorOrderId ?? `Order #${selectedOrder.id}`} · {selectedOrder.orderDate ?? selectedOrder.shipmentDate ?? 'No date'}
              </p>
            </div>
            <Button
              type="button"
              onClick={() => void runAiCategorization(selectedOrder.id)}
              disabled={aiCategorizing || (aiStatusLoaded && !aiEnabled)}
              title={
                aiStatusLoaded && !aiEnabled
                  ? AI_DISABLED_TITLE
                  : 'Categorize this order with AI'
              }
              aria-disabled={aiStatusLoaded && !aiEnabled ? true : undefined}
            >
              <Sparkles aria-hidden="true" />
              {aiCategorizing ? 'Categorizing...' : 'AI categorize order'}
            </Button>
          </div>
          <Table>
            <TableHeader>
              <TableRow><TableHead>Title</TableHead><TableHead>Category</TableHead><TableHead>Business %</TableHead><TableHead>Amount</TableHead><TableHead>Confidence</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {(selectedOrder.items ?? []).map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <Input
                      aria-label="Item title"
                      value={item.title}
                      onChange={(event) => void updateItem(item, { title: event.target.value })}
                    />
                  </TableCell>
                  <TableCell>
                    <NativeSelect
                      aria-label="Item category"
                      value={item.inferredCategory ?? 'Uncategorized'}
                      onChange={(event) => void updateItem(item, { inferredCategory: event.target.value })}
                    >
                      {categories.map((cat) => (
                        <NativeSelectOption key={cat} value={cat}>{cat}</NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </TableCell>
                  <TableCell>
                    <Input
                      aria-label="Business use percent"
                      type="number"
                      min="0"
                      max="100"
                      value={item.businessUsePercent ?? ''}
                      onChange={(event) => void updateItem(item, { businessUsePercent: event.target.value })}
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      aria-label="Item total price"
                      type="number"
                      min="0"
                      step="0.01"
                      value={item.totalPrice ?? ''}
                      aria-invalid={itemPriceErrors[item.id] ? true : undefined}
                      aria-describedby={itemPriceErrors[item.id] ? `item-price-error-${item.id}` : undefined}
                      onChange={(event) => void updateItem(item, { totalPrice: event.target.value })}
                    />
                    {itemPriceErrors[item.id] && (
                      <span
                        id={`item-price-error-${item.id}`}
                        className="text-danger"
                        role="alert"
                      >
                        {itemPriceErrors[item.id]}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    {(() => {
                      if (item.confidence == null || item.confidence === '') return '—'
                      const pct = Math.round(Number(item.confidence))
                      if (!Number.isFinite(pct)) return '—'
                      return (
                        <span style={{ color: confidenceColor(pct) }}>
                          {pct}% ({confidenceLabel(pct)})
                        </span>
                      )
                    })()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  )
}
