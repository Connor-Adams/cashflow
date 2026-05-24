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
import { Button } from '@/components/ui/button'
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

export function AmazonPage() {
  const fileRef = useRef<HTMLInputElement>(null)
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

  const refresh = useCallback(async () => {
    const [orderRows, txnRows, categoryRows] = await Promise.all([
      getJson<AmazonOrder[]>('/api/amazon/orders?limit=50'),
      getJson<AmazonTransaction[]>('/api/amazon/review-transactions'),
      getJson<{ categories: string[] }>('/api/amazon/categories'),
    ])
    setOrders(orderRows)
    setTxns(txnRows)
    setCategories(categoryRows.categories)
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
    <div className="page amazonPage">
      <div className="amazonHeader">
        <div>
          <h1>Amazon Enrichment</h1>
          <p className="muted">Import Amazon order reports, match them to card charges, and review item-level categories.</p>
        </div>
        <div className="amazonActionRow">
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

      {message && <p className="error">{message}</p>}

      <form className="card amazonImportPanel" onSubmit={onUpload}>
        <div>
          <h2>Amazon Import</h2>
          <p className="muted">Upload an Amazon report CSV. Re-uploading the same rows is safe.</p>
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

      {summary && (
        <section className="amazonSummaryGrid mb-4">
          <article className="card"><strong>{summary.created}</strong><span>Orders created</span></article>
          <article className="card"><strong>{summary.skipped}</strong><span>Skipped</span></article>
          <article className="card"><strong>{summary.importedItems}</strong><span>Items imported</span></article>
          <article className="card"><strong>{summary.failed}</strong><span>Failed rows</span></article>
        </section>
      )}

      <section className="card">
        <h2>Amazon Review</h2>
        <div className="amazonReviewList">
          {txns.map((txn) => (
            <article key={txn.id} className="amazonReviewRow">
              <div>
                <strong>{txn.merchantClean}</strong>
                <div className="muted">{txn.date} · {formatMoney(Number(txn.amount), txn.currency)}</div>
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
                      <span className="muted">{link.status} · {link.matchReason}</span>
                      <span>{itemPreview(link.order)}</span>
                      <span className="muted">{categoryPreview(link.order)}</span>
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
          {txns.length === 0 && (
            <EmptyState title="No Amazon-like transactions found." />
          )}
        </div>
      </section>

      <section className="card">
        <h2>Recent Imported Orders</h2>
        <div className="tableWrap">
          <Table className="table">
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
        </div>
      </section>

      {selectedOrder && (
        <section className="card amazonOrderEditor">
          <div className="amazonHeader">
            <div>
              <h2>Order Detail/Edit</h2>
              <p className="muted">
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
          <div className="tableWrap">
            <Table className="table">
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
                        step="0.01"
                        value={item.totalPrice ?? ''}
                        onChange={(event) => void updateItem(item, { totalPrice: event.target.value })}
                      />
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
          </div>
        </section>
      )}
    </div>
  )
}
