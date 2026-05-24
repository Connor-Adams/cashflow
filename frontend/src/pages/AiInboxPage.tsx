import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { getJson, postJson } from '@/lib/api'

type InboxItem = {
  id: number
  kind: 'transaction_audit' | 'financial_insight' | 'rule_proposal'
  createdAt: string
  transactionId: number | null
  summary: string
  severity: 'action' | 'watch' | 'info' | null
  confidence: 'high' | 'medium' | 'low' | null
  output: unknown
}

type InboxResponse = { items: InboxItem[] }

type Tab = 'all' | 'transaction_audit' | 'financial_insight' | 'rule_proposal'

export function AiInboxPage() {
  const [items, setItems] = useState<InboxItem[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('all')
  const [errorById, setErrorById] = useState<Record<number, string | null>>({})

  const fetchItems = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const r = await getJson<InboxResponse>('/api/ai/inbox')
      setItems(r.items)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load inbox')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchItems()
  }, [fetchItems])

  const visible = tab === 'all' ? items : items.filter((i) => i.kind === tab)

  async function dismissPersisted(item: InboxItem) {
    const original = items
    setItems((prev) => prev.filter((i) => i !== item))
    try {
      await postJson(`/api/ai/suggestions/${item.id}/reject`)
    } catch (e) {
      setItems(original)
      setErrorById((prev) => ({ ...prev, [item.id]: e instanceof Error ? e.message : 'Failed' }))
    }
  }

  async function dismissProposal(item: InboxItem) {
    const output = item.output as { merchantPattern?: string } | null
    const pattern = output?.merchantPattern || ''
    if (!pattern) return
    const original = items
    setItems((prev) => prev.filter((i) => i !== item))
    try {
      await postJson(`/api/ai/rule-proposals/${encodeURIComponent(pattern)}/dismiss`)
    } catch (e) {
      setItems(original)
      setErrorById((prev) => ({ ...prev, [item.id]: e instanceof Error ? e.message : 'Failed' }))
    }
  }

  async function approveProposal(item: InboxItem) {
    const output = item.output as {
      merchantPattern?: string
      category?: string | null
      isBusiness?: boolean
      splitType?: string
      pctMe?: string | null
      pctPartner?: string | null
    } | null
    const pattern = output?.merchantPattern || ''
    if (!pattern) return
    const original = items
    setItems((prev) => prev.filter((i) => i !== item))
    try {
      await postJson(`/api/ai/rule-proposals/${encodeURIComponent(pattern)}/approve`, {
        category: output?.category ?? null,
        isBusiness: output?.isBusiness ?? false,
        splitType: output?.splitType ?? 'me',
        pctMe: output?.pctMe ?? null,
        pctPartner: output?.pctPartner ?? null,
      })
    } catch (e) {
      setItems(original)
      setErrorById((prev) => ({ ...prev, [item.id]: e instanceof Error ? e.message : 'Failed' }))
    }
  }

  function txnIdsFor(item: InboxItem): string {
    if (item.kind === 'transaction_audit') {
      const issues = (item.output as { issues?: Array<{ id?: number }> } | null)?.issues || []
      return issues.map((i) => i.id).filter((n): n is number => typeof n === 'number').join(',')
    }
    if (item.kind === 'financial_insight') {
      const arr = Array.isArray(item.output) ? (item.output as Array<{ supportingTransactionIds?: number[] }>) : []
      const ids = arr.flatMap((i) => i.supportingTransactionIds || [])
      return ids.join(',')
    }
    if (item.kind === 'rule_proposal') {
      const out = item.output as { exampleTransactionIds?: number[] } | null
      return (out?.exampleTransactionIds || []).join(',')
    }
    return ''
  }

  return (
    <main className="aiInboxPage">
      <header>
        <h1>AI Inbox</h1>
        <p className="muted">{items.length} pending</p>
      </header>
      <nav className="aiInboxTabs" aria-label="Filter by kind">
        {(['all', 'transaction_audit', 'financial_insight', 'rule_proposal'] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            aria-pressed={tab === t}
            className={tab === t ? 'isActive' : ''}
          >
            {t === 'all' ? 'All' : t.replace('_', ' ')}
          </button>
        ))}
      </nav>
      {err ? <p className="error">{err}</p> : null}
      {loading ? <p className="muted">Loading…</p> : null}
      {!loading && visible.length === 0 ? (
        <p className="emptyState">
          Nothing here. <Link to="/">Back to Dashboard</Link>
        </p>
      ) : null}
      <ul className="aiInboxList">
        {visible.map((item) => {
          const ids = txnIdsFor(item)
          const itemErr = errorById[item.id]
          return (
            <li key={`${item.kind}:${item.id}`} className="aiInboxItem">
              <div className="aiInboxItemSummary">
                <strong>{item.summary}</strong>
                <span className="muted"> · {item.kind.replace('_', ' ')}</span>
              </div>
              <div className="aiInboxItemActions">
                {item.kind === 'rule_proposal' ? (
                  <>
                    <Button type="button" onClick={() => void approveProposal(item)}>
                      Approve
                    </Button>
                    <Button type="button" variant="secondary" onClick={() => void dismissProposal(item)}>
                      Dismiss
                    </Button>
                  </>
                ) : (
                  <>
                    {ids ? (
                      <Link to={`/transactions?ids=${ids}`} className="buttonLikeLink">
                        Open transactions
                      </Link>
                    ) : null}
                    <Button type="button" variant="secondary" onClick={() => void dismissPersisted(item)}>
                      Dismiss
                    </Button>
                  </>
                )}
              </div>
              {itemErr ? <p className="error">{itemErr}</p> : null}
            </li>
          )
        })}
      </ul>
    </main>
  )
}
