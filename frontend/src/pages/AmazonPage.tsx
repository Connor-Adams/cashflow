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

const confidenceLabel = (confidence: string) => {
  const n = Number(confidence)
  if (n >= 90) return 'High'
  if (n >= 70) return 'Medium'
  return 'Low'
}

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
    setMessage(orderId ? 'AI categorizing this Amazon order...' : 'AI categorizing recent Amazon items...')
    try {
      const result = await postJson<AiCategorizeResult>('/api/amazon/categorize/run', {
        orderId,
        limit: orderId ? undefined : 50,
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
          <button type="button" onClick={runMatching} disabled={loading}>
            <RefreshCw aria-hidden="true" />
            Run matching
          </button>
          <button
            type="button"
            onClick={() => void runAiCategorization()}
            disabled={aiCategorizing}
            title={aiEnabled ? 'Categorize imported Amazon items with AI' : 'Click to see why AI is unavailable'}
          >
            <Sparkles aria-hidden="true" />
            {aiCategorizing ? 'Categorizing...' : 'AI categorize'}
          </button>
        </div>
      </div>

      {message && <p className="error">{message}</p>}

      <form className="card amazonImportPanel" onSubmit={onUpload}>
        <div>
          <h2>Amazon Import</h2>
          <p className="muted">Upload an Amazon report CSV. Re-uploading the same rows is safe.</p>
        </div>
        <input ref={fileRef} type="file" accept=".csv,text/csv" />
        <button type="submit" disabled={loading}>
          <Upload aria-hidden="true" />
          Upload CSV
        </button>
      </form>

      {summary && (
        <section className="amazonSummaryGrid">
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
                      <strong>{confidenceLabel(link.confidence)} · {Number(link.confidence).toFixed(0)}</strong>
                      <span className="muted">{link.status} · {link.matchReason}</span>
                      <span>{itemPreview(link.order)}</span>
                      <span className="muted">{categoryPreview(link.order)}</span>
                    </div>
                    <div className="amazonActionRow">
                      <button type="button" onClick={() => void linkAction(`/api/amazon/links/${link.id}/accept`)} disabled={loading}>
                        <Check aria-hidden="true" />
                        Accept
                      </button>
                      <button type="button" onClick={() => void linkAction(`/api/amazon/links/${link.id}/reject`)} disabled={loading}>
                        <X aria-hidden="true" />
                        Reject
                      </button>
                      <button type="button" onClick={() => link.order && setSelectedOrderId(link.order.id)}>
                        <Search aria-hidden="true" />
                        View/Edit
                      </button>
                      <button type="button" className="btnDanger" onClick={() => void unlink(link.id)} disabled={loading}>
                        <Trash2 aria-hidden="true" />
                        Unlink
                      </button>
                    </div>
                  </div>
                ))}
                <div className="amazonManualLink">
                  <select
                    value={manualOrderByTxn[txn.id] ?? ''}
                    onChange={(event) => setManualOrderByTxn((prev) => ({ ...prev, [txn.id]: event.target.value }))}
                  >
                    <option value="">Manually link order...</option>
                    {orders.map((order) => (
                      <option key={order.id} value={order.id}>
                        #{order.id} {order.orderDate ?? order.shipmentDate ?? 'No date'} {order.total ? formatMoney(Number(order.total), order.currency) : ''}
                      </option>
                    ))}
                  </select>
                  <button type="button" onClick={() => void manualLink(txn.id)} disabled={loading || !manualOrderByTxn[txn.id]}>
                    <LinkIcon aria-hidden="true" />
                    Link
                  </button>
                </div>
              </div>
            </article>
          ))}
          {txns.length === 0 && <p className="muted">No Amazon-like transactions found.</p>}
        </div>
      </section>

      <section className="card">
        <h2>Recent Imported Orders</h2>
        <div className="tableWrap">
          <table className="table">
            <thead>
              <tr><th>Order</th><th>Date</th><th>Total</th><th>Categories</th><th>Items</th><th></th></tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.id}>
                  <td>{order.vendorOrderId ?? `#${order.id}`}</td>
                  <td>{order.orderDate ?? order.shipmentDate ?? '—'}</td>
                  <td>{order.total ? formatMoney(Number(order.total), order.currency) : '—'}</td>
                  <td>{categoryPreview(order)}</td>
                  <td>{itemPreview(order)}</td>
                  <td><button type="button" onClick={() => setSelectedOrderId(order.id)}>View/Edit</button></td>
                </tr>
              ))}
            </tbody>
          </table>
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
            <button
              type="button"
              onClick={() => void runAiCategorization(selectedOrder.id)}
              disabled={aiCategorizing}
              title={aiEnabled ? 'Categorize this order with AI' : 'Click to see why AI is unavailable'}
            >
              <Sparkles aria-hidden="true" />
              {aiCategorizing ? 'Categorizing...' : 'AI categorize order'}
            </button>
          </div>
          <div className="tableWrap">
            <table className="table">
              <thead>
                <tr><th>Title</th><th>Category</th><th>Business %</th><th>Amount</th><th>Confidence</th></tr>
              </thead>
              <tbody>
                {(selectedOrder.items ?? []).map((item) => (
                  <tr key={item.id}>
                    <td>
                      <input value={item.title} onChange={(event) => void updateItem(item, { title: event.target.value })} />
                    </td>
                    <td>
                      <select value={item.inferredCategory ?? 'Uncategorized'} onChange={(event) => void updateItem(item, { inferredCategory: event.target.value })}>
                        {categories.map((cat) => <option key={cat} value={cat}>{cat}</option>)}
                      </select>
                    </td>
                    <td>
                      <input
                        type="number"
                        min="0"
                        max="100"
                        value={item.businessUsePercent ?? ''}
                        onChange={(event) => void updateItem(item, { businessUsePercent: event.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        step="0.01"
                        value={item.totalPrice ?? ''}
                        onChange={(event) => void updateItem(item, { totalPrice: event.target.value })}
                      />
                    </td>
                    <td>{item.confidence ? `${Number(item.confidence).toFixed(0)}%` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}
