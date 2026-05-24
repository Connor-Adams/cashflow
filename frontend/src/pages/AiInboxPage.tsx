import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { SeverityBadge, type InsightSeverity } from '@/components/ai/SeverityBadge'
import { getJson, postJson } from '@/lib/api'

type InboxItem = {
  id: number
  kind: 'transaction_audit' | 'financial_insight' | 'rule_proposal'
  createdAt: string
  transactionId: number | null
  summary: string
  severity: InsightSeverity | null
  confidence: 'high' | 'medium' | 'low' | null
  output: unknown
}

type InsightDetail = {
  title?: string
  severity?: InsightSeverity
  comparison?: string
  supportingTransactionIds?: number[]
}

type InboxResponse = { items: InboxItem[] }

type Tab = 'all' | 'transaction_audit' | 'financial_insight' | 'rule_proposal'

const TAB_ORDER: Tab[] = ['all', 'transaction_audit', 'financial_insight', 'rule_proposal']

const TAB_LABEL: Record<Tab, string> = {
  all: 'All',
  transaction_audit: 'Audit',
  financial_insight: 'Insights',
  rule_proposal: 'Rules',
}

const SEVERITY_RANK: Record<InsightSeverity | 'null', number> = {
  action: 0,
  watch: 1,
  info: 2,
  null: 3,
}

function severityRank(s: InsightSeverity | null): number {
  return SEVERITY_RANK[s ?? 'null']
}

function compareItems(a: InboxItem, b: InboxItem): number {
  const diff = severityRank(a.severity) - severityRank(b.severity)
  if (diff !== 0) return diff
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1
  return b.id - a.id
}

export function AiInboxPage() {
  const [items, setItems] = useState<InboxItem[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('all')
  const [errorById, setErrorById] = useState<Record<number, string | null>>({})
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

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

  const sortedItems = useMemo(() => [...items].sort(compareItems), [items])

  const counts = useMemo(() => {
    const c: Record<Tab, number> = {
      all: items.length,
      transaction_audit: 0,
      financial_insight: 0,
      rule_proposal: 0,
    }
    for (const item of items) c[item.kind] += 1
    return c
  }, [items])

  const visible = tab === 'all' ? sortedItems : sortedItems.filter((i) => i.kind === tab)

  function toggleExpanded(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

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

  function insightDetailsFor(item: InboxItem): InsightDetail[] {
    if (item.kind !== 'financial_insight') return []
    return Array.isArray(item.output) ? (item.output as InsightDetail[]) : []
  }

  function txnIdsFor(item: InboxItem): string {
    if (item.kind === 'transaction_audit') {
      const issues = (item.output as { issues?: Array<{ id?: number }> } | null)?.issues || []
      return issues.map((i) => i.id).filter((n): n is number => typeof n === 'number').join(',')
    }
    if (item.kind === 'financial_insight') {
      const ids = insightDetailsFor(item).flatMap((i) => i.supportingTransactionIds || [])
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
        {TAB_ORDER.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            aria-pressed={tab === t}
            className={tab === t ? 'isActive' : ''}
          >
            {TAB_LABEL[t]} <span className="aiInboxTabCount">({counts[t]})</span>
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
          const details = insightDetailsFor(item)
          const canExpand = item.kind === 'financial_insight' && details.length > 1
          const isExpanded = expanded.has(item.id)
          return (
            <li key={`${item.kind}:${item.id}`} className="aiInboxItem">
              <div className="aiInboxItemSummary">
                {item.severity ? (
                  <>
                    <SeverityBadge severity={item.severity} />{' '}
                  </>
                ) : null}
                <strong>{item.summary}</strong>
                <span className="muted"> · {item.kind.replace('_', ' ')}</span>
                {canExpand ? (
                  <button
                    type="button"
                    className="aiInboxExpandToggle"
                    onClick={() => toggleExpanded(item.id)}
                    aria-expanded={isExpanded}
                  >
                    {isExpanded ? 'Hide details' : `Show ${details.length} insights`}
                  </button>
                ) : null}
              </div>
              {canExpand && isExpanded ? (
                <ul className="aiInboxItemDetails">
                  {details.map((d, idx) => {
                    const detailIds = (d.supportingTransactionIds || []).join(',')
                    return (
                      <li key={idx} className="aiInboxItemDetail">
                        {d.severity ? (
                          <>
                            <SeverityBadge severity={d.severity} />{' '}
                          </>
                        ) : null}
                        <strong>{d.title || 'Insight'}</strong>
                        {d.comparison ? <span className="muted"> · {d.comparison}</span> : null}
                        {detailIds ? (
                          <Link
                            to={`/transactions?ids=${detailIds}`}
                            className="aiInboxItemDetailLink"
                          >
                            {(d.supportingTransactionIds || []).length} txns
                          </Link>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              ) : null}
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
