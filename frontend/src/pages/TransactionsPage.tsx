import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ChangeEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { useConfirm } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select'
import { PageHeader } from '@/components/ui/page-header'
import { SkeletonRow } from '@/components/ui/skeleton'
import { StatCard } from '@/components/ui/stat-card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useToast } from '@/components/ui/toast'
import { CategoryCloudPicker } from '../components/CategoryCloudPicker'
import { CategoryIcon } from '../components/CategoryIcon'
import { EnrichmentSignalsDialog } from '../components/EnrichmentSignalsDialog'
import { TransactionRevisionsDialog } from '../components/TransactionRevisionsDialog'
import ReceiptItemsDrawer from '../components/ReceiptItemsDrawer'
import { RefundBadge } from '../components/RefundBadge'
import type { ReceiptWithItems } from '../../../shared/api-types'
import {
  getJson,
  patchJson,
  postFormData,
  postJson,
} from '../lib/api'
import {
  fromDateInputValue,
  toDateInputValue,
  todayDateInputValue,
} from '../lib/dateInput'
import { formatMoney } from '../lib/formatMoney'
import type {
  BulkPatchFilterResponse,
  Contact,
  Paginated,
  Transaction,
  TransactionStatus,
  TransactionBulkPatch,
  TransactionFilterPayload,
} from '../types/api'
import { useSessionState } from '../lib/useSessionState'
import { notifyReceiptsChanged } from '@/hooks/useReceiptCompleteness'

type CategoryHint = {
  label: string
  usageCount: number
}

type AiSuggestion = {
  category: string | null
  business: boolean | null
  splitType: 'me' | 'partner' | 'shared' | null
  pctMe: number | null
  pctPartner: number | null
  notes: string | null
  rationale: string | null
  confidence?: 'high' | 'medium' | 'low'
  evidence?: string[]
  needsReview?: boolean
}

type BulkAiResult = {
  id: number
  suggestionId: number
  merchant: string
  suggestion: AiSuggestion
  appliedFields: string[]
  status: 'suggested' | 'applied' | 'rejected'
}

type AiAuditIssue = {
  id: number
  issueType:
    | 'category_mismatch'
    | 'business_flag_mismatch'
    | 'both'
    | 'uncertain'
  currentCategory: string | null
  suggestedCategory: string | null
  currentBusiness: boolean | null
  suggestedBusiness: boolean | null
  confidence: 'high' | 'medium' | 'low'
  evidence: string[]
  rationale: string | null
}

type AiAuditResult = AiAuditIssue & {
  merchant: string
  amount: number
  currency: string
  status: 'open' | 'applied' | 'dismissed'
}

function formatAiSuggestion(suggestion: AiSuggestion): string {
  const parts = [
    suggestion.category ? `Category: ${suggestion.category}` : null,
    suggestion.business !== null ? `Business: ${suggestion.business ? 'yes' : 'no'}` : null,
    suggestion.splitType ? `Split: ${suggestion.splitType}` : null,
    suggestion.pctMe !== null ? `Me: ${suggestion.pctMe}` : null,
    suggestion.pctPartner !== null ? `Partner: ${suggestion.pctPartner}` : null,
    suggestion.notes ? `Notes: ${suggestion.notes}` : null,
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'No fields suggested'
}

const DEFAULT_TRANSACTION_CURRENCY = 'CAD'
const TRANSACTION_STATUS_FILTERS: Array<{ value: '' | TransactionStatus; label: string }> = [
  { value: '', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'posted', label: 'Posted' },
  { value: 'cleared', label: 'Cleared' },
]

/**
 * Anchor for default-range calculations: UTC midnight of the user's local
 * calendar day. Keeps the derived YYYY-MM-DD strings stable across timezones
 * (issue #280).
 */
function localTodayUtcMidnight(): Date {
  return fromDateInputValue(todayDateInputValue())!
}

function getRelativeDateRange(days: number): { from: string; to: string } {
  const to = localTodayUtcMidnight()
  const from = new Date(to)
  from.setUTCDate(from.getUTCDate() - days)
  return { from: toDateInputValue(from), to: toDateInputValue(to) }
}

function getYearToDateRange(): { from: string; to: string } {
  const to = localTodayUtcMidnight()
  const from = new Date(Date.UTC(to.getUTCFullYear(), 0, 1))
  return { from: toDateInputValue(from), to: toDateInputValue(to) }
}

export function TransactionsPage() {
  const [page, setPage] = useState(1)
  const [reviewOnly, setReviewOnly] = useSessionState(
    'transactions.reviewOnly',
    false
  )
  const [currency, setCurrency] = useSessionState(
    'transactions.currency',
    DEFAULT_TRANSACTION_CURRENCY
  )
  const [dateFrom, setDateFrom] = useSessionState('transactions.dateFrom', '')
  const [dateTo, setDateTo] = useSessionState('transactions.dateTo', '')
  const [categoryFilter, setCategoryFilter] = useSessionState(
    'transactions.category',
    ''
  )
  const [batchFilter, setBatchFilter] = useSessionState(
    'transactions.batchFilter',
    ''
  )
  const [statusFilter, setStatusFilter] = useSessionState<'' | TransactionStatus>(
    'transactions.status',
    ''
  )
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set())
  const [bulkCat, setBulkCat] = useState('')
  const [bulkBiz, setBulkBiz] = useState('')
  const [bulkSplit, setBulkSplit] = useState('')
  const [bulkPctMe, setBulkPctMe] = useState('')
  const [bulkPctPartner, setBulkPctPartner] = useState('')
  // intentionally plain useState — ids filter is one-shot from URL, not session-persisted
  const [idsFilter, setIdsFilter] = useState('')
  const [bulkMarkReviewed, setBulkMarkReviewed] = useState(false)
  const [bulkApplying, setBulkApplying] = useState(false)
  const [bulkAllApplying, setBulkAllApplying] = useState(false)
  const confirmAction = useConfirm()
  const { showToast } = useToast()
  const [res, setRes] = useState<Paginated<Transaction> | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [contacts, setContacts] = useState<Contact[]>([])
  const [aiEnabled, setAiEnabled] = useState(false)
  const [signalsDialogTxnId, setSignalsDialogTxnId] = useState<number | null>(null)
  // Issue #229: per-transaction edit history viewer + restore.
  const [revisionsDialogTxnId, setRevisionsDialogTxnId] = useState<number | null>(null)
  const [categoryHints, setCategoryHints] = useState<CategoryHint[]>([])
  const [attachForTxnId, setAttachForTxnId] = useState<number | null>(null)
  const [itemsDrawer, setItemsDrawer] = useState<{ txnId: number; receipts: ReceiptWithItems[] } | null>(null)
  const [bulkAiBusy, setBulkAiBusy] = useState(false)
  const [bulkAiResults, setBulkAiResults] = useState<BulkAiResult[]>([])
  const [aiAuditBusy, setAiAuditBusy] = useState(false)
  const [aiAuditResults, setAiAuditResults] = useState<AiAuditResult[]>([])
  const [aiAuditMessage, setAiAuditMessage] = useState<string | null>(null)
  const [sortBy, setSortBy] = useState<
    'date' | 'merchant' | 'amount' | 'category' | 'review'
  >('date')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const receiptFileRef = useRef<HTMLInputElement>(null)
  const loadRequestRef = useRef(0)
  const [searchParams, setSearchParams] = useSearchParams()

  // Consume URL query params on navigation (e.g. when arriving from the
  // Dashboard category chart drill-down, or from the /import batch detail
  // page's "View transactions →" link). Filters from the URL take precedence
  // over session state. After applying, we clear the params so manual filter
  // edits do not fight the URL on subsequent renders.
  useEffect(() => {
    const urlCategory = searchParams.get('category')
    const urlCurrency = searchParams.get('currency')
    const urlDateFrom = searchParams.get('dateFrom')
    const urlDateTo = searchParams.get('dateTo')
    const urlImportBatch = searchParams.get('importBatch')
    const urlReviewFlag = searchParams.get('reviewFlag')
    const urlIds = searchParams.get('ids')
    const urlStatus = searchParams.get('status')
    const hasAny =
      urlCategory != null ||
      urlCurrency != null ||
      urlDateFrom != null ||
      urlDateTo != null ||
      urlImportBatch != null ||
      urlReviewFlag != null ||
      urlIds != null ||
      urlStatus != null
    if (!hasAny) return
    if (urlCategory != null) setCategoryFilter(urlCategory)
    if (urlCurrency != null) setCurrency(urlCurrency.toUpperCase().slice(0, 3))
    if (urlDateFrom != null) setDateFrom(urlDateFrom)
    if (urlDateTo != null) setDateTo(urlDateTo)
    if (urlImportBatch != null) setBatchFilter(urlImportBatch)
    if (urlReviewFlag != null) setReviewOnly(urlReviewFlag === 'true')
    if (urlIds != null) setIdsFilter(urlIds.trim())
    if (urlStatus === 'pending' || urlStatus === 'posted' || urlStatus === 'cleared') {
      setStatusFilter(urlStatus)
    }
    setPage(1)
    setSearchParams({}, { replace: true })
  }, [
    searchParams,
    setSearchParams,
    setCategoryFilter,
    setCurrency,
    setDateFrom,
    setDateTo,
    setBatchFilter,
    setReviewOnly,
    setIdsFilter,
    setStatusFilter,
  ])

  useEffect(() => {
    void getJson<Contact[]>('/api/contacts')
      .then(setContacts)
      .catch(() => {})
  }, [])

  useEffect(() => {
    void getJson<{ openai: boolean }>('/api/ai/status')
      .then((s) => setAiEnabled(s.openai))
      .catch(() => setAiEnabled(false))
  }, [])

  useEffect(() => {
    void getJson<{ categories: CategoryHint[] }>('/api/transactions/category-hints')
      .then((data) => setCategoryHints(data.categories))
      .catch(() => setCategoryHints([]))
  }, [])

  // Per-issue-262: detect an impossible date range and surface inline guidance.
  // Apply-style actions are gated on this so users don't chase missing data
  // caused by a bad filter.
  const dateRangeInvalid = useMemo(() => {
    const from = dateFrom.trim()
    const to = dateTo.trim()
    if (!from || !to) return false
    return from > to
  }, [dateFrom, dateTo])

  const load = useCallback(async () => {
    const requestId = ++loadRequestRef.current
    setLoading(true)
    setErr(null)
    // Skip the load when the date range is impossible — return zero results
    // would just confuse the user. The inline error under the To input tells
    // them what to fix.
    if (dateRangeInvalid) {
      setRes({ data: [], page, pageSize: 25, total: 0 })
      setLoading(false)
      return
    }
    try {
      const qs = new URLSearchParams({
        page: String(page),
        pageSize: '25',
      })
      if (idsFilter && idsFilter.trim()) qs.set('ids', idsFilter.trim())
      if (reviewOnly) qs.set('reviewFlag', 'true')
      if (currency) qs.set('currency', currency)
      if (categoryFilter.trim()) qs.set('category', categoryFilter.trim())
      if (dateFrom.trim()) qs.set('dateFrom', dateFrom.trim())
      if (dateTo.trim()) qs.set('dateTo', dateTo.trim())
      if (batchFilter.trim()) qs.set('importBatch', batchFilter.trim())
      if (statusFilter) qs.set('status', statusFilter)
      const data = await getJson<Paginated<Transaction>>(
        `/api/transactions?${qs.toString()}`,
      )
      if (loadRequestRef.current === requestId) {
        setRes(data)
      }
    } catch (e) {
      if (loadRequestRef.current === requestId) {
        setErr(e instanceof Error ? e.message : 'Error')
      }
    } finally {
      if (loadRequestRef.current === requestId) {
        setLoading(false)
      }
    }
  }, [page, reviewOnly, currency, categoryFilter, dateFrom, dateTo, batchFilter, idsFilter, statusFilter, dateRangeInvalid])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    setPage(1)
  }, [reviewOnly, currency, categoryFilter, dateFrom, dateTo, batchFilter, idsFilter, statusFilter])

  useEffect(() => {
    setSelectedIds(new Set())
    setBulkAiResults([])
    setAiAuditResults([])
    setAiAuditMessage(null)
  }, [page, reviewOnly, currency, categoryFilter, dateFrom, dateTo, batchFilter, idsFilter, statusFilter])

  async function saveRow(id: number, patch: Record<string, unknown>) {
    await patchJson<Transaction>(`/api/transactions/${id}`, patch)
    await load()
  }

  function toggleSelected(id: number) {
    setSelectedIds((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }

  function selectAllOnPage() {
    const rows = sortedRows
    const ids = rows.map((t) => t.id)
    setSelectedIds((prev) => {
      const allOnPage = ids.length > 0 && ids.every((id) => prev.has(id))
      if (allOnPage) return new Set()
      return new Set(ids)
    })
  }

  const sortedRows = useMemo(() => {
    const rows = [...(res?.data ?? [])]
    const dir = sortDir === 'asc' ? 1 : -1
    rows.sort((a, b) => {
      if (sortBy === 'date') {
        return a.date.localeCompare(b.date) * dir
      }
      if (sortBy === 'merchant') {
        return a.merchantClean.localeCompare(b.merchantClean) * dir
      }
      if (sortBy === 'amount') {
        return (Number(a.amount) - Number(b.amount)) * dir
      }
      if (sortBy === 'category') {
        return (a.finalCategory ?? '').localeCompare(b.finalCategory ?? '') * dir
      }
      if (sortBy === 'review') {
        return (Number(a.reviewFlag) - Number(b.reviewFlag)) * dir
      }
      return 0
    })
    return rows
  }, [res?.data, sortBy, sortDir])

  function buildBulkPatch(): Record<string, unknown> | null {
    const patch: Record<string, unknown> = {}
    if (bulkCat.trim()) patch.categoryOverride = bulkCat.trim()
    if (bulkBiz === 'true' || bulkBiz === 'false')
      patch.businessOverride = bulkBiz === 'true'
    if (bulkSplit === 'me' || bulkSplit === 'partner' || bulkSplit === 'shared')
      patch.splitOverride = bulkSplit
    if (bulkPctMe.trim()) {
      const n = Number(bulkPctMe)
      if (!Number.isFinite(n)) return null
      patch.pctMeOverride = n
    }
    if (bulkPctPartner.trim()) {
      const n = Number(bulkPctPartner)
      if (!Number.isFinite(n)) return null
      patch.pctPartnerOverride = n
    }
    if (bulkMarkReviewed) patch.reviewFlag = false
    return Object.keys(patch).length ? patch : null
  }

  const quickRanges = useMemo(
    () => [
      { key: '30d', label: '30 days', ...getRelativeDateRange(30) },
      { key: '90d', label: '90 days', ...getRelativeDateRange(90) },
      { key: 'ytd', label: 'YTD', ...getYearToDateRange() },
      { key: 'all', label: 'All time', from: '', to: '' },
    ],
    []
  )

  const activeQuickRange = useMemo(
    () =>
      quickRanges.find((range) => range.from === dateFrom && range.to === dateTo)?.key ??
      null,
    [quickRanges, dateFrom, dateTo]
  )

  const pageCount = sortedRows.length
  const totalCount = res?.total ?? 0
  const totalPages = res ? Math.max(1, Math.ceil(res.total / res.pageSize)) : 1
  const reviewCountOnPage = sortedRows.filter((t) => t.reviewFlag).length
  const receiptCountOnPage = sortedRows.reduce(
    (sum, row) => sum + (row.receiptCount ?? 0),
    0
  )
  const filteredSummaryLabel =
    dateFrom && dateTo
      ? `${dateFrom} to ${dateTo}`
      : dateFrom
        ? `From ${dateFrom}`
        : dateTo
          ? `Up to ${dateTo}`
          : 'All dates'
  const categoryLabels = useMemo(
    () => categoryHints.map((hint) => hint.label),
    [categoryHints]
  )
  const hasCustomCurrency = currency !== DEFAULT_TRANSACTION_CURRENCY
  const activeFilters = useMemo(
    () =>
      [
        reviewOnly
          ? {
              key: 'review',
              label: 'Review only',
              clear: () => {
                setPage(1)
                setReviewOnly(false)
              },
            }
          : null,
        hasCustomCurrency
          ? {
              key: 'currency',
              label: currency,
              clear: () => {
                setPage(1)
                setCurrency(DEFAULT_TRANSACTION_CURRENCY)
              },
            }
          : null,
        categoryFilter.trim()
          ? {
              key: 'category',
              label: `Category: ${categoryFilter.trim()}`,
              clear: () => {
                setPage(1)
                setCategoryFilter('')
              },
            }
          : null,
        dateFrom || dateTo
          ? {
              key: 'date',
              label: filteredSummaryLabel,
              clear: () => {
                setPage(1)
                setDateFrom('')
                setDateTo('')
              },
            }
          : null,
        batchFilter.trim()
          ? {
              key: 'batch',
              label: `Batch: ${batchFilter.trim()}`,
              clear: () => {
                setPage(1)
                setBatchFilter('')
              },
              // Drill-back: clicking the label navigates to the batch
              // detail. The × clear button stays on the chip for clearing
              // the filter without leaving the page.
              href: `/import/${encodeURIComponent(batchFilter.trim())}`,
            }
          : null,
        idsFilter.trim()
          ? {
              key: 'ids',
              label: `IDs: ${idsFilter.trim().length > 40 ? idsFilter.trim().slice(0, 40) + '…' : idsFilter.trim()}`,
              clear: () => {
                setPage(1)
                setIdsFilter('')
              },
            }
          : null,
        statusFilter
          ? {
              key: 'status',
              label: `Status: ${TRANSACTION_STATUS_FILTERS.find((option) => option.value === statusFilter)?.label ?? statusFilter}`,
              clear: () => {
                setPage(1)
                setStatusFilter('')
              },
            }
          : null,
      ].filter(Boolean) as Array<{
        key: string
        label: string
        clear: () => void
        href?: string
      }>,
    [
      reviewOnly,
      hasCustomCurrency,
      currency,
      categoryFilter,
      filteredSummaryLabel,
      dateFrom,
      dateTo,
      batchFilter,
      idsFilter,
      statusFilter,
      setReviewOnly,
      setCurrency,
      setCategoryFilter,
      setDateFrom,
      setDateTo,
      setBatchFilter,
      setIdsFilter,
      setStatusFilter,
    ]
  )

  function clearAllFilters() {
    setPage(1)
    setReviewOnly(false)
    setCurrency(DEFAULT_TRANSACTION_CURRENCY)
    setCategoryFilter('')
    setDateFrom('')
    setDateTo('')
    setBatchFilter('')
    setIdsFilter('')
    setStatusFilter('')
  }

  async function openItemsDrawer(txnId: number) {
    setErr(null)
    try {
      const receipts = await getJson<ReceiptWithItems[]>(`/api/transactions/${txnId}/receipts`)
      setItemsDrawer({ txnId, receipts })
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load receipt items')
    }
  }

  async function reloadItemsDrawer() {
    if (!itemsDrawer) return
    const txnId = itemsDrawer.txnId
    const receipts = await getJson<ReceiptWithItems[]>(`/api/transactions/${txnId}/receipts`)
    setItemsDrawer(current => current ? { txnId, receipts } : null)
  }

  async function onExtractReceipt(receiptId: number) {
    await postJson(`/api/receipts/${receiptId}/analyze`, {})
    await reloadItemsDrawer()
  }

  async function onReceiptPicked(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    const tid = attachForTxnId
    setAttachForTxnId(null)
    e.target.value = ''
    if (!file || tid == null) return
    setErr(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      await postFormData<{ id: number }>(`/api/transactions/${tid}/receipts`, fd)
      notifyReceiptsChanged()
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Receipt upload failed')
    }
  }

  async function applyBulkAi() {
    if (selectedIds.size === 0) return
    setBulkAiBusy(true)
    setErr(null)
    setBulkAiResults([])
    try {
      const out = await postJson<{
        results: Array<{ id: number; suggestionId: number; suggestion: AiSuggestion }>
      }>('/api/ai/transactions/suggest', { ids: [...selectedIds] })
      const nextBulkAiResults: BulkAiResult[] = []
      for (const { id, suggestionId, suggestion } of out.results) {
        const appliedFields: string[] = []
        if (suggestion.category != null) {
          appliedFields.push('category')
        }
        if (suggestion.business !== null && suggestion.business !== undefined) {
          appliedFields.push('business')
        }
        if (suggestion.splitType != null) {
          appliedFields.push('split')
        }
        if (suggestion.pctMe != null) {
          appliedFields.push('my share')
        }
        if (suggestion.pctPartner != null) {
          appliedFields.push('partner share')
        }
        if (suggestion.notes != null) {
          appliedFields.push('notes')
        }
        const txn = res?.data.find((row) => row.id === id)
        nextBulkAiResults.push({
          id,
          suggestionId,
          merchant: txn?.merchantClean ?? `Transaction ${id}`,
          suggestion,
          appliedFields,
          status: 'suggested',
        })
      }
      setBulkAiResults(nextBulkAiResults)
      setSelectedIds(new Set())
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'AI suggest failed')
    } finally {
      setBulkAiBusy(false)
    }
  }

  async function applyAiSuggestion(result: BulkAiResult) {
    setErr(null)
    try {
      await postJson(`/api/ai/suggestions/${result.suggestionId}/apply`)
      setBulkAiResults((prev) =>
        prev.map((row) =>
          row.suggestionId === result.suggestionId ? { ...row, status: 'applied' } : row
        )
      )
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not apply AI suggestion')
    }
  }

  async function runAiAudit() {
    if (selectedIds.size === 0) return
    setAiAuditBusy(true)
    setErr(null)
    setAiAuditResults([])
    setAiAuditMessage(null)
    try {
      const out = await postJson<{ auditId: number; issues: AiAuditIssue[] }>(
        '/api/ai/transactions/audit',
        { ids: [...selectedIds] }
      )
      const byId = new Map((res?.data ?? []).map((row) => [row.id, row]))
      setAiAuditResults(
        out.issues.map((issue) => {
          const txn = byId.get(issue.id)
          return {
            ...issue,
            merchant: txn?.merchantClean ?? `Transaction ${issue.id}`,
            amount: Number(txn?.amount ?? 0),
            currency: txn?.currency ?? currency,
            status: 'open',
          }
        })
      )
      if (out.issues.length === 0) {
        setAiAuditMessage('AI audit found no likely category or business flag issues.')
      }
      setSelectedIds(new Set())
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'AI audit failed')
    } finally {
      setAiAuditBusy(false)
    }
  }

  async function applyAiAuditIssue(result: AiAuditResult) {
    const patch: Record<string, unknown> = { reviewFlag: false }
    if (
      result.suggestedCategory != null &&
      result.suggestedCategory !== result.currentCategory
    ) {
      patch.categoryOverride = result.suggestedCategory
    }
    if (
      result.suggestedBusiness != null &&
      result.suggestedBusiness !== result.currentBusiness
    ) {
      patch.businessOverride = result.suggestedBusiness
    }
    if (Object.keys(patch).length === 1) {
      setAiAuditResults((prev) =>
        prev.map((row) =>
          row.id === result.id ? { ...row, status: 'dismissed' } : row
        )
      )
      return
    }
    setErr(null)
    try {
      await patchJson<Transaction>(`/api/transactions/${result.id}`, patch)
      setAiAuditResults((prev) =>
        prev.map((row) =>
          row.id === result.id ? { ...row, status: 'applied' } : row
        )
      )
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not apply audit correction')
    }
  }

  function dismissAiAuditIssue(result: AiAuditResult) {
    setAiAuditResults((prev) =>
      prev.map((row) =>
        row.id === result.id ? { ...row, status: 'dismissed' } : row
      )
    )
  }

  async function rejectAiSuggestion(result: BulkAiResult) {
    setErr(null)
    try {
      await postJson(`/api/ai/suggestions/${result.suggestionId}/reject`)
      setBulkAiResults((prev) =>
        prev.map((row) =>
          row.suggestionId === result.suggestionId ? { ...row, status: 'rejected' } : row
        )
      )
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not reject AI suggestion')
    }
  }

  async function applyBulk() {
    const patch = buildBulkPatch()
    if (!patch || selectedIds.size === 0) return
    setBulkApplying(true)
    setErr(null)
    try {
      await postJson<{ updated: number }>('/api/transactions/bulk-patch', {
        ids: [...selectedIds],
        patch,
      })
      setBulkCat('')
      setBulkBiz('')
      setBulkSplit('')
      setBulkPctMe('')
      setBulkPctPartner('')
      setBulkMarkReviewed(false)
      setSelectedIds(new Set())
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Bulk update failed')
    } finally {
      setBulkApplying(false)
    }
  }

  /**
   * Snapshot of the active filter set, in a shape the backend's
   * /api/transactions/bulk-patch-filter route accepts. Mirrors the fields the
   * GET list endpoint receives in {@link load}, so "Apply to all matching"
   * targets exactly the rows the user is currently looking at.
   */
  function buildActiveFilterPayload(): TransactionFilterPayload {
    const payload: TransactionFilterPayload = {}
    if (reviewOnly) payload.reviewFlag = true
    if (currency) payload.currency = currency
    if (categoryFilter.trim()) payload.category = categoryFilter.trim()
    if (dateFrom.trim()) payload.dateFrom = dateFrom.trim()
    if (dateTo.trim()) payload.dateTo = dateTo.trim()
    if (batchFilter.trim()) payload.importBatch = batchFilter.trim()
    if (statusFilter) payload.status = statusFilter
    return payload
  }

  function describePatch(patch: Record<string, unknown>): string {
    const parts: string[] = []
    if (typeof patch.categoryOverride === 'string') parts.push(`category=${patch.categoryOverride}`)
    if (typeof patch.businessOverride === 'boolean')
      parts.push(`business=${patch.businessOverride ? 'yes' : 'no'}`)
    if (typeof patch.splitOverride === 'string') parts.push(`split=${patch.splitOverride}`)
    if (typeof patch.pctMeOverride === 'number') parts.push(`pct me=${patch.pctMeOverride}`)
    if (typeof patch.pctPartnerOverride === 'number')
      parts.push(`pct partner=${patch.pctPartnerOverride}`)
    if (patch.reviewFlag === false) parts.push('mark reviewed')
    return parts.length ? parts.join(', ') : 'no fields'
  }

  /**
   * Applies the current bulk-bar patch to every transaction matching the
   * active filter — not just the rows the user has manually selected on this
   * page. The user is shown a destructive-style prompt with the row count
   * before any write happens; the server independently enforces a cap and
   * rejects oversize selections with 422.
   */
  async function applyBulkToAllMatching() {
    const patch = buildBulkPatch()
    if (!patch) return
    if (totalCount === 0) {
      showToast({
        title: 'Nothing to update',
        description: 'The current filter has no matching transactions.',
        variant: 'warning',
      })
      return
    }
    const summary = describePatch(patch)
    const ok = await confirmAction({
      title: `Apply to all ${totalCount} matching transactions?`,
      description: `Patch [${summary}] will be written to every transaction matching the active filter across all pages.`,
      confirmLabel: `Apply to ${totalCount}`,
      cancelLabel: 'Back',
      destructive: true,
    })
    if (!ok) return
    setBulkAllApplying(true)
    setErr(null)
    try {
      const filter = buildActiveFilterPayload()
      const result = await postJson<BulkPatchFilterResponse>(
        '/api/transactions/bulk-patch-filter',
        { filter, patch: patch as TransactionBulkPatch }
      )
      setBulkCat('')
      setBulkBiz('')
      setBulkSplit('')
      setBulkPctMe('')
      setBulkPctPartner('')
      setBulkMarkReviewed(false)
      setSelectedIds(new Set())
      await load()
      showToast({
        title: `Updated ${result.updated} transactions`,
        variant: 'success',
      })
    } catch (e) {
      const status = (e as { status?: number } | null | undefined)?.status
      const message = e instanceof Error ? e.message : 'Bulk update across filter failed'
      if (status === 422) {
        showToast({
          title: 'Too many matching transactions',
          description: message,
          variant: 'warning',
          durationMs: 8000,
        })
      } else {
        setErr(message)
      }
    } finally {
      setBulkAllApplying(false)
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Transactions"
        description="Import statements, review classifications, and clean up overrides in one place."
      />
      <input
        ref={receiptFileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        style={{ display: 'none' }}
        aria-hidden
        onChange={onReceiptPicked}
      />

      <section className="transactionsStats">
        <StatCard label="Filtered rows" value={totalCount} hint={filteredSummaryLabel} />
        <StatCard label="This page" value={pageCount} hint={`Page ${page} of ${totalPages}`} />
        <StatCard label="Needs review" value={reviewCountOnPage} hint="Rows flagged on the current page" />
        <StatCard label="Selected" value={selectedIds.size} hint="Rows in the current bulk selection" />
        <StatCard label="Receipts" value={receiptCountOnPage} hint="Attachments on the current page" />
      </section>


      <section className="card transactionsToolbar">
        <div className="transactionsPanelHeader">
          <div>
            <h2>Browse and review</h2>
            <p className="muted">
              Filter the ledger, sort the current page, and jump straight into bulk
              updates when you need them.
            </p>
          </div>
          <div className="transactionsToolbarMeta">
            <span className="transactionsPanelBadge">
              {reviewOnly ? 'Review queue' : 'All transactions'}
            </span>
            <span className="transactionsPanelBadge">
              {currency || 'All currencies'}
            </span>
          </div>
        </div>
        <div className="quickFilters" aria-label="Quick transaction date ranges">
          {quickRanges.map((range) => (
            <Button
              key={range.key}
              type="button"
              variant="secondary"
              size="sm"
              className="quickFilterButton"
              aria-pressed={activeQuickRange === range.key}
              onClick={() => {
                setDateFrom(range.from)
                setDateTo(range.to)
              }}
            >
              {range.label}
            </Button>
          ))}
        </div>
        <div className="quickFilters" aria-label="Transaction status filters">
          {TRANSACTION_STATUS_FILTERS.map((option) => (
            <Button
              key={option.value || 'all'}
              type="button"
              variant="secondary"
              size="sm"
              className="quickFilterButton"
              aria-pressed={statusFilter === option.value}
              onClick={() => {
                setPage(1)
                setStatusFilter(option.value)
              }}
            >
              {option.label}
            </Button>
          ))}
        </div>
        <div className="formGrid transactionsFilterGrid">
          <Label className="transactionsCheckTile">
            <span>Review only</span>
            <Input
              className="size-4 w-auto shadow-none"
              type="checkbox"
              checked={reviewOnly}
              onChange={(e) => {
                setPage(1)
                setReviewOnly(e.target.checked)
              }}
            />
          </Label>
          <Label>
            Currency
            <Input
              value={currency}
              onChange={(e) => {
                setPage(1)
                setCurrency(e.target.value.toUpperCase())
              }}
              placeholder="e.g. CAD"
              maxLength={3}
            />
          </Label>
          <Label className="transactionsCategoryField">
            Category
            <CategoryCloudPicker
              className="transactionsCategoryPicker"
              cloudClassName="transactionsCategoryPickerCloud"
              itemClassName="transactionsCategoryPickerItem"
              value={categoryFilter}
              onChange={(value) => {
                setPage(1)
                setCategoryFilter(value)
              }}
              options={categoryLabels}
              placeholder="e.g. Groceries"
            />
          </Label>
          <Label>
            From
            <Input
              type="date"
              value={dateFrom}
              onChange={(e) => {
                setPage(1)
                setDateFrom(e.target.value)
              }}
            />
          </Label>
          <Label>
            To
            <Input
              type="date"
              value={dateTo}
              aria-invalid={dateRangeInvalid ? true : undefined}
              aria-describedby={dateRangeInvalid ? 'transactions-date-range-error' : undefined}
              onChange={(e) => {
                setPage(1)
                setDateTo(e.target.value)
              }}
            />
            {dateRangeInvalid && (
              <span
                id="transactions-date-range-error"
                className="error"
                role="alert"
              >
                End date must be on or after start date.
              </span>
            )}
          </Label>
          <Label>
            Import batch
            <Input
              value={batchFilter}
              onChange={(e) => {
                setPage(1)
                setBatchFilter(e.target.value)
              }}
              placeholder="exact batch label"
            />
          </Label>
          <Label>
            Sort by
            <NativeSelect
              value={sortBy}
              onChange={(e) =>
                setSortBy(
                  e.target.value as
                    | 'date'
                    | 'merchant'
                    | 'amount'
                    | 'category'
                    | 'review'
                  )
              }
            >
              <NativeSelectOption value="date">Date</NativeSelectOption>
              <NativeSelectOption value="merchant">Merchant</NativeSelectOption>
              <NativeSelectOption value="amount">Amount</NativeSelectOption>
              <NativeSelectOption value="category">Category</NativeSelectOption>
              <NativeSelectOption value="review">Review flag</NativeSelectOption>
            </NativeSelect>
          </Label>
          <Label>
            Direction
            <NativeSelect
              value={sortDir}
              onChange={(e) => setSortDir(e.target.value as 'asc' | 'desc')}
            >
              <NativeSelectOption value="desc">Descending</NativeSelectOption>
              <NativeSelectOption value="asc">Ascending</NativeSelectOption>
            </NativeSelect>
          </Label>
        </div>
          <div className="row transactionsActionRow">
          {activeFilters.length > 0 && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setPage(1)
                setReviewOnly(false)
                setCurrency(DEFAULT_TRANSACTION_CURRENCY)
                setCategoryFilter('')
                setDateFrom('')
                setDateTo('')
                setBatchFilter('')
                setIdsFilter('')
                setStatusFilter('')
              }}
            >
              Clear filters
            </Button>
          )}
          <Button type="button" variant="secondary" onClick={() => void load()} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
        {activeFilters.length > 0 ? (
          <div className="transactionsFilterPills" aria-label="Active filters">
            {activeFilters.map((filter) =>
              filter.href ? (
                <span
                  key={filter.key}
                  className="transactionsFilterPill transactionsFilterPill--link"
                >
                  <Link
                    to={filter.href}
                    className="transactionsFilterPill__label"
                    title={`Open ${filter.label.toLowerCase()}`}
                  >
                    {filter.label}
                  </Link>
                  <button
                    type="button"
                    onClick={filter.clear}
                    className="transactionsFilterPill__clear"
                    aria-label={`Clear ${filter.label}`}
                  >
                    ×
                  </button>
                </span>
              ) : (
                <Button
                  key={filter.key}
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="transactionsFilterPill"
                  onClick={filter.clear}
                >
                  <span>{filter.label}</span>
                  <span aria-hidden>×</span>
                </Button>
              )
            )}
          </div>
        ) : (
          <p className="muted transactionsHelperCopy">
            Showing the default view: {DEFAULT_TRANSACTION_CURRENCY}, all categories,
            all dates.
          </p>
        )}
        {aiEnabled ? (
          <p className="muted transactionsHelperCopy">
            OpenAI is configured. Use <strong>AI</strong> on a row or{' '}
            <strong>AI fill selected</strong> when you want the page to help with
            categorization; use <strong>AI audit selected</strong> to look for
            mislabeled categories or business flags.
          </p>
        ) : (
          <p className="muted transactionsHelperCopy">
            Set <code>OPENAI_API_KEY</code> in <code>backend/.env</code> to enable
            AI suggestions and receipt vision.
          </p>
        )}
      </section>
      {err && <span className="error">{err}</span>}
      {aiAuditMessage && <p className="uploadMsg">{aiAuditMessage}</p>}
      {bulkAiResults.length > 0 && (
        <section className="card aiVisibilityPanel" aria-label="Latest bulk AI results">
          <div className="aiVisibilityHeader">
            <strong>Latest AI fill</strong>
            <span className="muted">
              Review {bulkAiResults.length} suggestion
              {bulkAiResults.length === 1 ? '' : 's'} before applying.
            </span>
          </div>
          <div className="aiVisibilityList">
            {bulkAiResults.slice(0, 6).map((result) => (
              <article key={result.id} className="aiVisibilityItem">
                <div className="aiVisibilityItemHeader">
                  <strong>{result.merchant}</strong>
                  <span className="muted">#{result.id}</span>
                </div>
                <p>{formatAiSuggestion(result.suggestion)}</p>
                <p className="muted">
                  Fields:{' '}
                  {result.appliedFields.length
                    ? result.appliedFields.join(', ')
                    : 'nothing'}
                </p>
                <p className="muted">
                  Confidence: {result.suggestion.confidence ?? 'medium'}
                  {result.suggestion.needsReview ? ' · needs review' : ''}
                </p>
                {result.suggestion.evidence?.length ? (
                  <p className="muted">Evidence: {result.suggestion.evidence.join(', ')}</p>
                ) : null}
                {result.suggestion.rationale ? (
                  <p className="muted">{result.suggestion.rationale}</p>
                ) : null}
                <div className="row">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={result.status !== 'suggested'}
                    onClick={() => void applyAiSuggestion(result)}
                  >
                    {result.status === 'applied' ? 'Applied' : 'Apply'}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={result.status !== 'suggested'}
                    onClick={() => void rejectAiSuggestion(result)}
                  >
                    {result.status === 'rejected' ? 'Rejected' : 'Reject'}
                  </Button>
                </div>
              </article>
            ))}
          </div>
          {bulkAiResults.length > 6 ? (
            <p className="muted aiVisibilityMore">
              {bulkAiResults.length - 6} more result
              {bulkAiResults.length - 6 === 1 ? '' : 's'} applied.
            </p>
          ) : null}
        </section>
      )}
      {aiAuditResults.length > 0 && (
        <section className="card aiVisibilityPanel" aria-label="Latest AI audit results">
          <div className="aiVisibilityHeader">
            <strong>AI audit findings</strong>
            <span className="muted">
              {aiAuditResults.filter((row) => row.status === 'open').length} open ·{' '}
              {aiAuditResults.length} total
            </span>
          </div>
          <div className="aiVisibilityList">
            {aiAuditResults.slice(0, 8).map((result) => (
              <article key={result.id} className="aiVisibilityItem">
                <div className="aiVisibilityItemHeader">
                  <strong>{result.merchant}</strong>
                  <span className="muted">#{result.id}</span>
                </div>
                <p>
                  {result.issueType.replaceAll('_', ' ')} ·{' '}
                  {formatMoney(Math.abs(result.amount), result.currency)}
                </p>
                <p className="muted">
                  Category:{' '}
                  {result.currentCategory ?? 'Uncategorized'}
                  {result.suggestedCategory &&
                  result.suggestedCategory !== result.currentCategory
                    ? ` → ${result.suggestedCategory}`
                    : ''}
                </p>
                <p className="muted">
                  Business:{' '}
                  {result.currentBusiness == null
                    ? 'unknown'
                    : result.currentBusiness
                      ? 'yes'
                      : 'no'}
                  {result.suggestedBusiness != null &&
                  result.suggestedBusiness !== result.currentBusiness
                    ? ` → ${result.suggestedBusiness ? 'yes' : 'no'}`
                    : ''}
                </p>
                <p className="muted">Confidence: {result.confidence}</p>
                {result.evidence.length ? (
                  <p className="muted">Evidence: {result.evidence.join(', ')}</p>
                ) : null}
                {result.rationale ? <p className="muted">{result.rationale}</p> : null}
                <div className="row">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={result.status !== 'open'}
                    onClick={() => void applyAiAuditIssue(result)}
                  >
                    {result.status === 'applied' ? 'Applied' : 'Apply correction'}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={result.status !== 'open'}
                    onClick={() => dismissAiAuditIssue(result)}
                  >
                    {result.status === 'dismissed' ? 'Dismissed' : 'Dismiss'}
                  </Button>
                </div>
              </article>
            ))}
          </div>
          {aiAuditResults.length > 8 ? (
            <p className="muted aiVisibilityMore">
              {aiAuditResults.length - 8} more finding
              {aiAuditResults.length - 8 === 1 ? '' : 's'} hidden.
            </p>
          ) : null}
        </section>
      )}
      {(selectedIds.size > 0 || totalCount > 0) && (
        <div className="card bulkBar transactionsBulkCard">
          <div className="transactionsBulkHeader">
            <strong>
              {selectedIds.size > 0
                ? `${selectedIds.size} selected`
                : `${totalCount} matching`}
            </strong>
            <span className="muted">Apply a batch override without opening each row.</span>
          </div>
          {aiEnabled ? (
            <>
              <Button
                type="button"
                variant="secondary"
                disabled={bulkAiBusy || aiAuditBusy || selectedIds.size > 15}
                onClick={() => void applyBulkAi()}
                title={
                  selectedIds.size > 15
                    ? 'AI fill supports up to 15 selected rows'
                    : undefined
                }
              >
                {bulkAiBusy ? 'AI…' : 'AI fill selected'}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={bulkAiBusy || aiAuditBusy || selectedIds.size > 25}
                onClick={() => void runAiAudit()}
                title={
                  selectedIds.size > 25
                    ? 'AI audit supports up to 25 selected rows'
                    : undefined
                }
              >
                {aiAuditBusy ? 'Auditing…' : 'AI audit selected'}
              </Button>
            </>
          ) : null}
          <Label>
            Category
            <CategoryCloudPicker
              className="transactionsBulkCategoryPicker"
              cloudClassName="transactionsBulkCategoryCloud"
              itemClassName="transactionsBulkCategoryItem"
              value={bulkCat}
              onChange={setBulkCat}
              options={categoryLabels}
              placeholder="override"
            />
          </Label>
          <Label>
            Business
            <NativeSelect
              value={bulkBiz}
              onChange={(e) => setBulkBiz(e.target.value)}
            >
              <NativeSelectOption value="">(no change)</NativeSelectOption>
              <NativeSelectOption value="true">Yes</NativeSelectOption>
              <NativeSelectOption value="false">No</NativeSelectOption>
            </NativeSelect>
          </Label>
          <Label>
            Split
            <NativeSelect
              value={bulkSplit}
              onChange={(e) => setBulkSplit(e.target.value)}
            >
              <NativeSelectOption value="">(no change)</NativeSelectOption>
              <NativeSelectOption value="me">me</NativeSelectOption>
              <NativeSelectOption value="partner">partner</NativeSelectOption>
              <NativeSelectOption value="shared">shared</NativeSelectOption>
            </NativeSelect>
          </Label>
          <Label>
            % me
            <Input
              value={bulkPctMe}
              onChange={(e) => setBulkPctMe(e.target.value)}
              style={{ width: 64 }}
              placeholder="0.5"
            />
          </Label>
          <Label>
            % ptn
            <Input
              value={bulkPctPartner}
              onChange={(e) => setBulkPctPartner(e.target.value)}
              style={{ width: 64 }}
              placeholder="0.5"
            />
          </Label>
          <Label className="checkRow">
            <Input
              className="size-4 w-auto shadow-none"
              type="checkbox"
              checked={bulkMarkReviewed}
              onChange={(e) => setBulkMarkReviewed(e.target.checked)}
            />{' '}
            Mark reviewed
          </Label>
          <Button
            type="button"
            disabled={
              bulkApplying ||
              bulkAllApplying ||
              !buildBulkPatch() ||
              selectedIds.size === 0 ||
              dateRangeInvalid
            }
            onClick={() => void applyBulk()}
          >
            {bulkApplying ? 'Applying…' : 'Apply to selected'}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={
              bulkApplying ||
              bulkAllApplying ||
              !buildBulkPatch() ||
              totalCount === 0 ||
              dateRangeInvalid
            }
            onClick={() => void applyBulkToAllMatching()}
            title={
              dateRangeInvalid
                ? 'Fix the date range before applying'
                : totalCount === 0
                ? 'No transactions match the active filter'
                : `Apply the bulk patch to every transaction matching the current filter (${totalCount})`
            }
          >
            {bulkAllApplying
              ? 'Applying…'
              : `Apply to all ${totalCount} matching`}
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => setSelectedIds(new Set())}
            disabled={selectedIds.size === 0}
          >
            Clear selection
          </Button>
        </div>
      )}
      {confirmAction.dialog}
      <section className="card transactionsTableCard">
        <div className="transactionsPanelHeader">
          <div>
            <h2>Ledger</h2>
            <p className="muted">
              Showing {pageCount} row{pageCount === 1 ? '' : 's'} on this page out of{' '}
              {totalCount} matching the current filters.
            </p>
          </div>
          <div className="transactionsToolbarMeta">
            <span className="transactionsPanelBadge">
              {loading ? 'Refreshing' : 'Up to date'}
            </span>
            <span className="transactionsPanelBadge">Page {page}/{totalPages}</span>
          </div>
        </div>
        <div className="tableWrap transactionsTableWrap">
          <Table className="table transactionsTable">
            <TableHeader>
              <TableRow>
                <TableHead className="narrowCol">
                  <input
                    type="checkbox"
                    aria-label="Select all on this page"
                    checked={
                      sortedRows.length > 0 &&
                      sortedRows.every((t) => selectedIds.has(t.id))
                    }
                    ref={(el) => {
                      if (el) {
                        const some =
                          sortedRows.some((t) => selectedIds.has(t.id)) &&
                          !sortedRows.every((t) => selectedIds.has(t.id))
                        el.indeterminate = some
                      }
                    }}
                    onChange={() => selectAllOnPage()}
                  />
                </TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Merchant</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Business</TableHead>
                <TableHead>Split / share</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="transactionsActionsCol">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && sortedRows.length === 0 ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <SkeletonRow key={`txn-skeleton-${i}`} cols={9} />
                ))
              ) : !sortedRows.length ? (
                <TableRow>
                  <TableCell colSpan={9} className="emptyStateCell">
                    {activeFilters.length > 0 ? (
                      <>
                        <p>No transactions match this filter.</p>
                        <p>
                          <Button type="button" variant="outline" size="sm" onClick={clearAllFilters}>
                            Clear filters
                          </Button>
                        </p>
                      </>
                    ) : (
                      <>
                        <p>
                          {statusFilter === 'pending'
                            ? 'No pending transactions.'
                            : 'No transactions yet.'}
                        </p>
                        <p className="muted">
                          Upload a CSV above (pick an account first), or use <strong>Run import</strong> if you
                          placed files in the configured upload folder. Create accounts under{' '}
                          <Link to="/accounts">Accounts</Link> if needed.
                        </p>
                      </>
                    )}
                  </TableCell>
                </TableRow>
              ) : (
                sortedRows.map((t) => (
                <TransactionRow
                  key={t.id}
                  t={t}
                  categoryOptions={categoryLabels}
                  contacts={contacts}
                  selected={selectedIds.has(t.id)}
                  onToggleSelected={() => toggleSelected(t.id)}
                  onSave={saveRow}
                    aiEnabled={aiEnabled}
                    onAttachReceipt={(id) => {
                      setAttachForTxnId(id)
                      receiptFileRef.current?.click()
                    }}
                    onViewItems={(id) => void openItemsDrawer(id)}
                    onError={(msg) => setErr(msg)}
                    onOpenSignals={(id) => setSignalsDialogTxnId(id)}
                    onOpenRevisions={(id) => setRevisionsDialogTxnId(id)}
                  />
                ))
              )}
            </TableBody>
          </Table>
        </div>
        <div className="row transactionsPager">
          <Button
            type="button"
            variant="secondary"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Prev
          </Button>
          <span>
            Page {page} / {totalPages}
          </span>
          <Button
            type="button"
            variant="secondary"
            disabled={!res || page * res.pageSize >= res.total}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      </section>
      <ReceiptItemsDrawer
        open={itemsDrawer != null}
        onClose={() => setItemsDrawer(null)}
        receipts={itemsDrawer?.receipts ?? []}
        categoryHints={categoryLabels}
        onExtract={onExtractReceipt}
      />
      <EnrichmentSignalsDialog
        transactionId={signalsDialogTxnId}
        transactionSummary={
          signalsDialogTxnId == null
            ? null
            : (() => {
                const row = sortedRows.find((r) => r.id === signalsDialogTxnId)
                if (!row) return null
                return {
                  merchantRaw: row.merchantRaw,
                  merchantClean: row.merchantClean,
                  merchantCanonical: row.merchantCanonical,
                  autoSource: row.autoSource,
                  autoConfidence: row.autoConfidence,
                  autoCategory: row.autoCategory,
                  txnType: row.txnType,
                  reviewFlag: row.reviewFlag,
                  isRecurring: row.isRecurring,
                }
              })()
        }
        onClose={() => setSignalsDialogTxnId(null)}
        onReenriched={(updated) => {
          setRes((prev) =>
            prev
              ? {
                  ...prev,
                  data: prev.data.map((r) =>
                    r.id === updated.id ? ({ ...r, ...updated } as Transaction) : r,
                  ),
                }
              : prev,
          )
        }}
      />
      <TransactionRevisionsDialog
        transactionId={revisionsDialogTxnId}
        onClose={() => setRevisionsDialogTxnId(null)}
        onRestored={(updated) => {
          setRes((prev) =>
            prev
              ? {
                  ...prev,
                  data: prev.data.map((r) =>
                    r.id === updated.id ? ({ ...r, ...updated } as Transaction) : r,
                  ),
                }
              : prev,
          )
        }}
      />
    </div>
  )
}

function TransactionRow({
  t,
  categoryOptions,
  contacts,
  selected,
  onToggleSelected,
  onSave,
  aiEnabled,
  onAttachReceipt,
  onViewItems,
  onError,
  onOpenSignals,
  onOpenRevisions,
}: {
  t: Transaction
  categoryOptions: string[]
  contacts: Contact[]
  selected: boolean
  onToggleSelected: () => void
  onSave: (id: number, patch: Record<string, unknown>) => Promise<void>
  aiEnabled: boolean
  onAttachReceipt: (transactionId: number) => void
  onViewItems: (transactionId: number) => void
  onError: (message: string) => void
  onOpenSignals: (id: number) => void
  onOpenRevisions: (id: number) => void
}) {
  const [aiRowBusy, setAiRowBusy] = useState(false)
  const [aiSuggestion, setAiSuggestion] = useState<AiSuggestion | null>(null)
  const [aiSuggestionId, setAiSuggestionId] = useState<number | null>(null)
  const [cat, setCat] = useState(t.categoryOverride ?? '')
  const [biz, setBiz] = useState<string>(
    t.businessOverride === null || t.businessOverride === undefined
      ? ''
      : t.businessOverride
        ? 'true'
        : 'false'
  )
  const [split, setSplit] = useState(t.splitOverride ?? '')
  const [pctMe, setPctMe] = useState(
    t.pctMeOverride != null ? String(t.pctMeOverride) : ''
  )
  const [pctPartner, setPctPartner] = useState(
    t.pctPartnerOverride != null ? String(t.pctPartnerOverride) : ''
  )
  const [visibility, setVisibility] = useState<'private' | 'shared'>(
    t.visibility ?? 'private'
  )
  const [ownershipType, setOwnershipType] = useState<
    'me' | 'partner' | 'shared' | 'contact'
  >(t.ownershipType ?? 'me')
  const [ownershipContactId, setOwnershipContactId] = useState(
    t.ownershipContactId != null ? String(t.ownershipContactId) : ''
  )
  const [status, setStatus] = useState<TransactionStatus>(t.status)
  const [reimburseOpen, setReimburseOpen] = useState(false)
  const rowConfirmAction = useConfirm()
  const rowToast = useToast()
  const parsedPctMe = pctMe.trim() === '' ? null : Number(pctMe)
  const parsedPctPartner =
    pctPartner.trim() === '' ? null : Number(pctPartner)
  const hasInvalidShareOverride =
    (pctMe.trim() !== '' && !Number.isFinite(parsedPctMe)) ||
    (pctPartner.trim() !== '' && !Number.isFinite(parsedPctPartner))
  const isDirty =
    cat !== (t.categoryOverride ?? '') ||
    biz !==
      (t.businessOverride === null || t.businessOverride === undefined
        ? ''
        : t.businessOverride
          ? 'true'
          : 'false') ||
    split !== (t.splitOverride ?? '') ||
    pctMe !== (t.pctMeOverride != null ? String(t.pctMeOverride) : '') ||
    pctPartner !== (t.pctPartnerOverride != null ? String(t.pctPartnerOverride) : '') ||
    visibility !== (t.visibility ?? 'private') ||
    ownershipType !== (t.ownershipType ?? 'me') ||
    ownershipContactId !== (t.ownershipContactId != null ? String(t.ownershipContactId) : '')

  const resetDraft = useCallback(() => {
    setCat(t.categoryOverride ?? '')
    setBiz(
      t.businessOverride === null || t.businessOverride === undefined
        ? ''
        : t.businessOverride
          ? 'true'
          : 'false'
    )
    setSplit(t.splitOverride ?? '')
    setPctMe(t.pctMeOverride != null ? String(t.pctMeOverride) : '')
    setPctPartner(t.pctPartnerOverride != null ? String(t.pctPartnerOverride) : '')
    setVisibility(t.visibility ?? 'private')
    setOwnershipType(t.ownershipType ?? 'me')
    setOwnershipContactId(t.ownershipContactId != null ? String(t.ownershipContactId) : '')
    setStatus(t.status)
    setAiSuggestion(null)
    setAiSuggestionId(null)
  }, [t])

  useEffect(() => {
    resetDraft()
  }, [resetDraft])

  async function changeStatus(next: TransactionStatus) {
    if (next === status) return
    if (next === 'cleared') {
      const ok = await rowConfirmAction({
        title: 'Mark as cleared?',
        description: 'Cleared usually comes from statement reconciliation. Continue?',
        confirmLabel: 'Mark cleared',
        cancelLabel: 'Cancel',
      })
      if (!ok) return
    }
    const previous = status
    setStatus(next)
    try {
      await onSave(t.id, { status: next })
      rowToast.showToast({
        title: `Status updated to ${next[0].toUpperCase()}${next.slice(1)}`,
        variant: 'success',
      })
    } catch (e) {
      setStatus(previous)
      rowToast.showToast({
        title: "Couldn't update status. Try again.",
        variant: 'destructive',
      })
      onError(e instanceof Error ? e.message : "Couldn't update status. Try again.")
    }
  }

  return (
    <TableRow>
      <TableCell className="narrowCol">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelected}
          aria-label={`Select transaction ${t.id}`}
        />
      </TableCell>
      <TableCell>{t.date}</TableCell>
      <TableCell title={t.merchantRaw}>
        <div className="txnMerchantCell">
          <span className="txnMerchantName">{t.merchantClean}</span>
          <span className="txnMerchantMeta">
            {t.account?.shortCode ?? t.account?.name ?? 'Account'} · {t.importBatch}
          </span>
          {(t.counterpartyContactId != null || t.counterpartyRaw) && (
            <span className="txnCounterparty text-xs text-muted-foreground">
              {Number(t.amount) >= 0 ? 'from ' : 'to '}
              {(() => {
                if (t.counterpartyContactId != null) {
                  const c = contacts.find((x) => x.id === t.counterpartyContactId)
                  return c ? c.name : `contact #${t.counterpartyContactId}`
                }
                return t.counterpartyRaw
              })()}
            </span>
          )}
          {t.txnType === 'refund' && (
            <RefundBadge
              transactionId={t.id}
              linkedTransactionId={t.linkedTransactionId}
              currency={t.currency}
            />
          )}
        </div>
      </TableCell>
      <TableCell>
        <div className="txnAmountCell">
          <span
            className={
              Number(t.amount) < 0
                ? 'txnAmount txnAmount--expense'
                : 'txnAmount txnAmount--credit'
            }
          >
            {formatMoney(Number(t.amount), t.currency)}
          </span>
          <span className="txnAmountMeta">{t.currency}</span>
        </div>
      </TableCell>
      <TableCell>
        <span className="inline-flex items-center gap-1.5">
          <CategoryIcon name={t.finalCategory} />
          <CategoryCloudPicker
            className="txnCategoryCell"
            inputClassName="txnCategoryInput"
            cloudClassName="txnCategoryPickerCloud"
            itemClassName="txnCategoryPickerItem"
            value={cat}
            onChange={setCat}
            options={categoryOptions}
            placeholder={t.finalCategory ?? ''}
          />
        </span>
      </TableCell>
      <TableCell>
        <NativeSelect
          value={biz}
          onChange={(e) => setBiz(e.target.value)}
        >
          <NativeSelectOption value="">(auto)</NativeSelectOption>
          <NativeSelectOption value="true">Yes</NativeSelectOption>
          <NativeSelectOption value="false">No</NativeSelectOption>
        </NativeSelect>
      </TableCell>
      <TableCell>
        <div className="txnSplitCell">
          <NativeSelect value={split} onChange={(e) => setSplit(e.target.value)}>
            <NativeSelectOption value="">(auto)</NativeSelectOption>
            <NativeSelectOption value="me">me</NativeSelectOption>
            <NativeSelectOption value="partner">partner</NativeSelectOption>
            <NativeSelectOption value="shared">shared</NativeSelectOption>
          </NativeSelect>
          <div className="txnSplitPercents">
            <Input
              value={pctMe}
              onChange={(e) => setPctMe(e.target.value)}
              aria-invalid={hasInvalidShareOverride && pctMe.trim() !== ''}
              className="txnPercentInput"
              placeholder="me"
              aria-label={`My share override for transaction ${t.id}`}
            />
            <Input
              value={pctPartner}
              onChange={(e) => setPctPartner(e.target.value)}
              aria-invalid={hasInvalidShareOverride && pctPartner.trim() !== ''}
              className="txnPercentInput"
              placeholder="ptn"
              aria-label={`Partner share override for transaction ${t.id}`}
            />
          </div>
          <NativeSelect
            value={ownershipType}
            onChange={(e) => {
              const value = e.target.value as 'me' | 'partner' | 'shared' | 'contact'
              setOwnershipType(value)
              if (value !== 'contact') setOwnershipContactId('')
            }}
            aria-label={`Ownership for transaction ${t.id}`}
          >
            <NativeSelectOption value="me">owned by me</NativeSelectOption>
            <NativeSelectOption value="partner">owned by partner</NativeSelectOption>
            <NativeSelectOption value="shared">shared</NativeSelectOption>
            <NativeSelectOption value="contact">contact</NativeSelectOption>
          </NativeSelect>
          {ownershipType === 'contact' && (
            <NativeSelect
              value={ownershipContactId}
              onChange={(e) => setOwnershipContactId(e.target.value)}
              aria-label={`Contact owner for transaction ${t.id}`}
            >
              <NativeSelectOption value="">Pick contact</NativeSelectOption>
              {contacts.map((contact) => (
                <NativeSelectOption key={contact.id} value={contact.id}>
                  {contact.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          )}
          <NativeSelect
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as 'private' | 'shared')}
            aria-label={`Visibility for transaction ${t.id}`}
          >
            <NativeSelectOption value="private">private</NativeSelectOption>
            <NativeSelectOption value="shared">shared</NativeSelectOption>
          </NativeSelect>
        </div>
      </TableCell>
      <TableCell>
        <div className="txnStatusCell">
          {status === 'pending' ? (
            <Badge
              variant="secondary"
              className="rounded-full bg-amber-100 text-amber-800"
              title="Authorized but not yet posted by your bank."
            >
              Pending
            </Badge>
          ) : status === 'cleared' ? (
            <Badge
              variant="secondary"
              className="rounded-full bg-blue-100 text-blue-800"
              title="Reconciled against your statement."
            >
              Cleared
            </Badge>
          ) : null}
          <NativeSelect
            size="sm"
            value={status}
            aria-label={`Status for ${t.merchantClean}`}
            onChange={(e) => void changeStatus(e.target.value as TransactionStatus)}
          >
            <NativeSelectOption value="pending">Pending</NativeSelectOption>
            <NativeSelectOption value="posted">Posted</NativeSelectOption>
            <NativeSelectOption value="cleared">Cleared</NativeSelectOption>
          </NativeSelect>
          <span className={t.reviewFlag ? 'txnBadge txnBadge--review' : 'txnBadge'}>
            {t.reviewFlag
              ? t.autoCategory
                ? 'Auto categorized'
                : 'Needs review'
              : 'Reviewed'}
          </span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="txnReceiptAction"
            onClick={() => onAttachReceipt(t.id)}
            title="Attach receipt image"
          >
            <span className="txnReceiptCount">{t.receiptCount ?? 0}</span>
            <span>{(t.receiptCount ?? 0) > 0 ? 'Add receipt' : 'Attach receipt'}</span>
          </Button>
          {(t.receiptCount ?? 0) > 0 && (
            <button
              type="button"
              className="txnReceiptAction"
              onClick={() => onViewItems(t.id)}
              title="View receipt items"
            >
              View items
            </button>
          )}
          {t.receiptWarnings?.length ? (
            <span className="txnBadge txnBadge--review" title={t.receiptWarnings.join(', ')}>
              Receipt check
            </span>
          ) : null}
          {rowConfirmAction.dialog}
        </div>
      </TableCell>
      <TableCell className="transactionsActionsCol">
        <div className="txnActionGroup">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenSignals(t.id)}
            title="Show enrichment signals for this transaction"
          >
            Why?
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenRevisions(t.id)}
            title="Show edit history for this transaction"
          >
            History
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setReimburseOpen(true)}
            title="Track this as money you expect to be reimbursed"
          >
            Reimburse
          </Button>
          {aiEnabled ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={aiRowBusy}
              onClick={async () => {
                setAiRowBusy(true)
                try {
                  const out = await postJson<{
                    suggestion: AiSuggestion
                    suggestionId: number
                  }>(`/api/transactions/${t.id}/ai-suggest`)
                  const s = out.suggestion
                  setAiSuggestion(s)
                  setAiSuggestionId(out.suggestionId)
                  if (s.category) setCat(s.category)
                  if (s.business !== null && s.business !== undefined) {
                    setBiz(s.business ? 'true' : 'false')
                  }
                  if (s.splitType) setSplit(s.splitType)
                  if (s.pctMe != null) setPctMe(String(s.pctMe))
                  if (s.pctPartner != null) setPctPartner(String(s.pctPartner))
                } catch (e) {
                  onError(e instanceof Error ? e.message : 'AI suggestion failed')
                } finally {
                  setAiRowBusy(false)
                }
              }}
            >
              {aiRowBusy ? '…' : 'AI'}
            </Button>
          ) : null}
          {aiSuggestion ? (
            <div className="txnAiInsight" role="status">
              <strong>AI suggestion</strong>
              <span>{formatAiSuggestion(aiSuggestion)}</span>
              <span className="muted">
                Confidence: {aiSuggestion.confidence ?? 'medium'}
                {aiSuggestion.needsReview ? ' · needs review' : ''}
              </span>
              {aiSuggestion.evidence?.length ? (
                <span className="muted">Evidence: {aiSuggestion.evidence.join(', ')}</span>
              ) : null}
              {aiSuggestion.rationale ? (
                <span className="muted">{aiSuggestion.rationale}</span>
              ) : null}
            </div>
          ) : null}
          {isDirty ? (
            <Button type="button" variant="secondary" size="sm" className="txnResetButton" onClick={resetDraft}>
              Revert
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            className="txnSaveButton"
            disabled={!isDirty && !t.reviewFlag}
            onClick={() => {
              if (hasInvalidShareOverride) {
                onError('Percent overrides must be valid numbers.')
                return
              }
              if (ownershipType === 'contact' && !ownershipContactId) {
                onError('Pick a contact for contact-owned transactions.')
                return
              }
              void onSave(t.id, {
                categoryOverride: cat || null,
                businessOverride: biz === '' ? null : biz === 'true',
                splitOverride: split || null,
                pctMeOverride: parsedPctMe,
                pctPartnerOverride: parsedPctPartner,
                visibility,
                ownershipType,
                ownershipContactId:
                  ownershipType === 'contact' ? Number(ownershipContactId) : null,
                reviewFlag: false,
                aiSuggestionId,
              })
            }}
          >
            {!isDirty && t.reviewFlag ? 'Mark reviewed' : isDirty ? 'Save' : 'Saved'}
          </Button>
        </div>
        {reimburseOpen && (
          <MarkReimbursableDialog
            txn={t}
            contacts={contacts}
            onClose={() => setReimburseOpen(false)}
            onError={onError}
            onSaved={() => {
              setReimburseOpen(false)
              rowToast.showToast({
                title: 'Marked reimbursable',
                variant: 'success',
              })
            }}
          />
        )}
      </TableCell>
    </TableRow>
  )
}

/**
 * Quick "Mark reimbursable" dialog (issue #216) — creates a reimbursement
 * claim for this transaction via POST /api/transactions/:id/reimbursable.
 * Party is a Contact (dropdown) or free text; amount defaults to the
 * transaction's absolute amount.
 *
 * #374: when the source transaction already carries a
 * `counterpartyContactId` (a #372-linked Contact from statement import), the
 * dropdown is pre-filled with that contact — the most-common case is now
 * one keystroke away. When the txn has `counterpartyRaw` only (no Contact),
 * a single "Promote {name} and create" button hits
 * POST /api/transactions/:id/reimbursable/promote-counterparty to create the
 * Contact, link the txn, and create the claim in one round-trip.
 */
function MarkReimbursableDialog({
  txn,
  contacts,
  onClose,
  onError,
  onSaved,
}: {
  txn: Transaction
  contacts: Contact[]
  onClose: () => void
  onError: (message: string) => void
  onSaved: () => void
}) {
  // Pre-fill from counterpartyContactId (#374 AC#1). Falls back to the
  // legacy ownership-contact heuristic so an empty counterparty doesn't lose
  // the existing behaviour for transactions imported before #372 landed.
  const counterpartyPrefill = useMemo(() => {
    if (txn.counterpartyContactId == null) return ''
    const found = contacts.find((c) => c.id === txn.counterpartyContactId)
    return found ? String(found.id) : ''
  }, [txn.counterpartyContactId, contacts])
  const [contactId, setContactId] = useState<string>(counterpartyPrefill)
  const [partyName, setPartyName] = useState<string>('')
  const [amount, setAmount] = useState<string>(
    String(Math.abs(Number(txn.amount) || 0)),
  )
  const [dueDate, setDueDate] = useState<string>('')
  const [notes, setNotes] = useState<string>('')
  const [saving, setSaving] = useState(false)

  // #374 AC#2: enable Promote-and-use only when the txn has raw counterparty
  // text but no Contact link yet. (If a Contact is already linked, the
  // pre-fill above handles it.)
  const canPromote =
    txn.counterpartyContactId == null &&
    Boolean(txn.counterpartyRaw && txn.counterpartyRaw.trim() !== '')
  const promoteName = (txn.counterpartyRaw ?? '').trim()

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!contactId && partyName.trim() === '') {
      onError('Pick a contact or enter who owes you.')
      return
    }
    setSaving(true)
    try {
      const body: Record<string, unknown> = {}
      if (contactId) body.contactId = Number(contactId)
      else body.partyName = partyName.trim()
      if (amount.trim() !== '') body.amount = amount.trim()
      if (dueDate) body.dueDate = dueDate
      if (notes.trim() !== '') body.notes = notes.trim()
      await postJson(`/api/transactions/${txn.id}/reimbursable`, body)
      onSaved()
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not mark reimbursable.')
      setSaving(false)
    }
  }

  async function promoteAndUse() {
    if (!canPromote) return
    setSaving(true)
    try {
      const body: Record<string, unknown> = {}
      if (amount.trim() !== '') body.amount = amount.trim()
      if (dueDate) body.dueDate = dueDate
      if (notes.trim() !== '') body.notes = notes.trim()
      await postJson(
        `/api/transactions/${txn.id}/reimbursable/promote-counterparty`,
        body,
      )
      onSaved()
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not promote and create.')
      setSaving(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Mark transaction reimbursable"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <Card className="w-full max-w-md p-5">
        <h2 className="mb-1 text-lg font-semibold">Mark reimbursable</h2>
        <p className="muted text-sm mb-4">
          {txn.merchantClean} · {txn.date}
        </p>
        {canPromote && (
          // #374 AC#2 — one-click "Promote and use". Surfaced above the form
          // so the common case is a single button click; the manual flow
          // below still works for free-text or a different contact.
          <div className="mb-4 rounded-md border border-dashed border-border bg-muted/40 p-3 text-sm">
            <p className="muted mb-2">
              Statement counterparty:{' '}
              <strong className="text-foreground">{promoteName}</strong>
            </p>
            <Button
              type="button"
              variant="default"
              size="sm"
              disabled={saving}
              onClick={() => void promoteAndUse()}
              title="Create a Contact from this statement counterparty and use it"
            >
              {saving ? 'Working…' : `Promote "${promoteName}" and create claim`}
            </Button>
          </div>
        )}
        <form onSubmit={submit} className="flex flex-col gap-3">
          {contacts.length > 0 && (
            <label className="flex flex-col gap-1 text-sm">
              <span>Who owes you? (contact)</span>
              <NativeSelect
                value={contactId}
                onChange={(e) => setContactId(e.target.value)}
              >
                <option value="">— free text below —</option>
                {contacts.map((c) => (
                  <option key={c.id} value={String(c.id)}>
                    {c.name}
                  </option>
                ))}
              </NativeSelect>
            </label>
          )}
          {!contactId && (
            <label className="flex flex-col gap-1 text-sm">
              <span>Or type a name</span>
              <Input
                value={partyName}
                onChange={(e) => setPartyName(e.target.value)}
                placeholder="e.g. Acme Corp, Mom, BlueCross"
                maxLength={160}
              />
            </label>
          )}
          <label className="flex flex-col gap-1 text-sm">
            <span>Amount expected ({txn.currency})</span>
            <Input
              type="number"
              step="0.01"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span>Due date (optional)</span>
            <Input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span>Notes (optional)</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="rounded-md border border-input bg-background/70 px-3 py-1 text-sm"
              maxLength={4000}
            />
          </label>
          <div className="mt-2 flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Mark reimbursable'}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  )
}
