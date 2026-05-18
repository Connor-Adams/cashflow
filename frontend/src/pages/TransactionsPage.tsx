import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Alert, type AlertVariant } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select'
import { PageHeader } from '@/components/ui/page-header'
import { StatCard } from '@/components/ui/stat-card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { CategoryCloudPicker } from '../components/CategoryCloudPicker'
import {
  getJson,
  patchJson,
  postFormData,
  postJson,
} from '../lib/api'
import { toDateInputValue } from '../lib/dateInput'
import { formatMoney } from '../lib/formatMoney'
import { formatParseErrorLines } from '../lib/formatParseErrors'
import type { Account, Contact, Paginated, StatementPreview, Transaction } from '../types/api'
import { useSessionState } from '../lib/useSessionState'

type UploadResult = {
  file: string
  batchLabel?: string
  inserted?: number
  skippedDuplicates?: number
  rowErrors?: number
  parseErrors?: { rowIndex: number; message: string }[]
  skipped?: boolean
  reason?: string
  message?: string
  warning?: string
  usedProfileId?: string
  profileInferred?: boolean
  insertedTransactions?: number
  insertedInvestmentActivities?: number
  insertedHoldings?: number
  warnings?: string[]
}

type FolderImportResponse = {
  results: UploadResult[]
  uploadDir: string
}

type MultiUploadResponse = {
  results: UploadResult[]
}

type ImportHistoryRow = {
  id: number
  fileName: string
  batchLabel: string
  status: string
  rowCount: number | null
  errorMessage: string | null
  startedAt: string
  finishedAt: string | null
}

type CsvProfileOption = { id: string; label: string; hint: string }

type PreviewResponse = StatementPreview

type CategoryHint = {
  label: string
  usageCount: number
}

function classifyUploadMessage(message: string): 'warning' | 'success' {
  if (
    message.includes('No rows') ||
    message.includes('duplicate') ||
    message.includes('Skipped')
  ) {
    return 'warning'
  }
  return 'success'
}

function summarizeUploadResult(result: UploadResult): string {
  if (result.skipped) {
    return [
      `Skipped (${result.reason ?? 'unknown'}): ${result.file}`,
      result.message,
    ]
      .filter(Boolean)
      .join(' — ')
  }
  const profileNote =
    result.usedProfileId != null
      ? `Profile: ${result.usedProfileId}${result.profileInferred ? ' (auto-detected)' : ''}`
      : ''
  return [
    result.insertedInvestmentActivities != null || result.insertedHoldings != null
      ? `Imported ${result.inserted ?? 0} record(s): ${result.insertedTransactions ?? 0} transactions, ${result.insertedInvestmentActivities ?? 0} activities, ${result.insertedHoldings ?? 0} holdings · batch “${result.batchLabel ?? ''}” · dupes skipped: ${result.skippedDuplicates ?? 0}`
      : `Imported ${result.inserted ?? 0} row(s) · batch “${result.batchLabel ?? ''}” · dupes skipped: ${result.skippedDuplicates ?? 0}`,
    profileNote,
    (result.rowErrors ?? 0) > 0
      ? `${result.rowErrors} row(s) could not be parsed`
      : '',
    result.warning,
    result.warnings?.length ? `${result.warnings.length} warning(s)` : '',
  ]
    .filter(Boolean)
    .join(' — ')
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

type ImportCleanup = {
  batch: string | null
  total: number
  readyToConfirmCount: number
  needsCategoryCount: number
  alreadyReviewedCount: number
  topReady: Array<{
    id: number
    date: string
    merchant: string
    amount: number
    currency: string
    category: string | null
    source: 'rule' | 'merchant_memory'
  }>
  batches: Array<{ importBatch: string; count: number }>
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

function getRelativeDateRange(days: number): { from: string; to: string } {
  const to = new Date()
  const from = new Date(to)
  from.setDate(from.getDate() - days)
  return { from: toDateInputValue(from), to: toDateInputValue(to) }
}

function getYearToDateRange(): { from: string; to: string } {
  const to = new Date()
  const from = new Date(to.getFullYear(), 0, 1)
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
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set())
  const [bulkCat, setBulkCat] = useState('')
  const [bulkBiz, setBulkBiz] = useState('')
  const [bulkSplit, setBulkSplit] = useState('')
  const [bulkPctMe, setBulkPctMe] = useState('')
  const [bulkPctPartner, setBulkPctPartner] = useState('')
  const [bulkMarkReviewed, setBulkMarkReviewed] = useState(false)
  const [bulkApplying, setBulkApplying] = useState(false)
  const [importHistory, setImportHistory] = useState<ImportHistoryRow[]>([])
  const [res, setRes] = useState<Paginated<Transaction> | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [contacts, setContacts] = useState<Contact[]>([])
  const [uploadAccountId, setUploadAccountId] = useState('')
  const [batchLabel, setBatchLabel] = useState('')
  const [csvProfileOptions, setCsvProfileOptions] = useState<CsvProfileOption[]>(
    []
  )
  const [profileId, setProfileId] = useState('auto')
  // Unified upload feedback — replaces the prior trio (uploadMsg, uploadParseLines,
  // previewErr) so error/warning/info/success states render through one Alert.
  const [uploadFeedback, setUploadFeedback] = useState<{
    variant: AlertVariant
    title: string
    lines?: string[]
  } | null>(null)
  const [uploading, setUploading] = useState(false)
  const [runningFolderImport, setRunningFolderImport] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [previewData, setPreviewData] = useState<PreviewResponse | null>(null)
  const [aiEnabled, setAiEnabled] = useState(false)
  const [categoryHints, setCategoryHints] = useState<CategoryHint[]>([])
  const [attachForTxnId, setAttachForTxnId] = useState<number | null>(null)
  const [bulkAiBusy, setBulkAiBusy] = useState(false)
  const [bulkAiResults, setBulkAiResults] = useState<BulkAiResult[]>([])
  const [aiAuditBusy, setAiAuditBusy] = useState(false)
  const [aiAuditResults, setAiAuditResults] = useState<AiAuditResult[]>([])
  const [aiAuditMessage, setAiAuditMessage] = useState<string | null>(null)
  const [importCleanup, setImportCleanup] = useState<ImportCleanup | null>(null)
  const [sortBy, setSortBy] = useState<
    'date' | 'merchant' | 'amount' | 'category' | 'review'
  >('date')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const fileRef = useRef<HTMLInputElement>(null)
  const receiptFileRef = useRef<HTMLInputElement>(null)
  const loadRequestRef = useRef(0)

  useEffect(() => {
    void getJson<Account[]>('/api/accounts')
      .then(setAccounts)
      .catch(() => {})
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
    void getJson<CsvProfileOption[]>('/api/import/profiles')
      .then((list) => {
        setCsvProfileOptions(list)
        setProfileId((prev) =>
          list.some((p) => p.id === prev) ? prev : list[0]?.id ?? 'auto'
        )
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    void getJson<{ categories: CategoryHint[] }>('/api/transactions/category-hints')
      .then((data) => setCategoryHints(data.categories))
      .catch(() => setCategoryHints([]))
  }, [])

  const refreshImportHistory = useCallback(() => {
    void getJson<ImportHistoryRow[]>('/api/import/history')
      .then(setImportHistory)
      .catch(() => {})
  }, [])

  useEffect(() => {
    refreshImportHistory()
  }, [refreshImportHistory])

  const load = useCallback(async () => {
    const requestId = ++loadRequestRef.current
    setLoading(true)
    setErr(null)
    try {
      const qs = new URLSearchParams({
        page: String(page),
        pageSize: '25',
      })
      if (reviewOnly) qs.set('reviewFlag', 'true')
      if (currency) qs.set('currency', currency)
      if (categoryFilter.trim()) qs.set('category', categoryFilter.trim())
      if (dateFrom.trim()) qs.set('dateFrom', dateFrom.trim())
      if (dateTo.trim()) qs.set('dateTo', dateTo.trim())
      if (batchFilter.trim()) qs.set('importBatch', batchFilter.trim())
      const cleanupQs = new URLSearchParams()
      if (batchFilter.trim()) cleanupQs.set('batch', batchFilter.trim())
      if (currency) cleanupQs.set('currency', currency)
      const [data, cleanup] = await Promise.all([
        getJson<Paginated<Transaction>>(`/api/transactions?${qs.toString()}`),
        getJson<ImportCleanup>(`/api/ai/import-cleanup?${cleanupQs.toString()}`),
      ])
      if (loadRequestRef.current === requestId) {
        setRes(data)
        setImportCleanup(cleanup)
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
  }, [page, reviewOnly, currency, categoryFilter, dateFrom, dateTo, batchFilter])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    setPage(1)
  }, [reviewOnly, currency, categoryFilter, dateFrom, dateTo, batchFilter])

  useEffect(() => {
    setSelectedIds(new Set())
    setBulkAiResults([])
    setAiAuditResults([])
    setAiAuditMessage(null)
  }, [page, reviewOnly, currency, categoryFilter, dateFrom, dateTo, batchFilter])

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
            }
          : null,
      ].filter(Boolean) as Array<{ key: string; label: string; clear: () => void }>,
    [
      reviewOnly,
      hasCustomCurrency,
      currency,
      categoryFilter,
      filteredSummaryLabel,
      dateFrom,
      dateTo,
      batchFilter,
      setReviewOnly,
      setCurrency,
      setCategoryFilter,
      setDateFrom,
      setDateTo,
      setBatchFilter,
    ]
  )

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

  async function onPreview() {
    const input = fileRef.current
    const files = Array.from(input?.files ?? [])
    const file = files[0]
    if (!file) {
      setUploadFeedback({ variant: 'error', title: 'Choose a .csv file first.' })
      setPreviewData(null)
      return
    }
    if (files.length > 1) {
      setUploadFeedback({
        variant: 'error',
        title:
          'Preview supports one file at a time. Select one CSV to preview, or import all selected files.',
      })
      setPreviewData(null)
      return
    }
    if (!uploadAccountId) {
      setUploadFeedback({ variant: 'error', title: 'Select an account.' })
      setPreviewData(null)
      return
    }
    setPreviewing(true)
    setUploadFeedback(null)
    setPreviewData(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('accountId', uploadAccountId)
      fd.append('profileId', profileId)
      const r = await postFormData<PreviewResponse>('/api/import/preview', fd)
      setPreviewData(r)
    } catch (e) {
      setUploadFeedback({
        variant: 'error',
        title: e instanceof Error ? e.message : 'Preview failed',
      })
    } finally {
      setPreviewing(false)
    }
  }

  async function onUpload(e: FormEvent) {
    e.preventDefault()
    if (previewData?.previewToken) {
      setUploading(true)
      setUploadFeedback(null)
      setErr(null)
      try {
        const result = await postJson<UploadResult>('/api/import/commit', {
          previewToken: previewData.previewToken,
        })
        const title = summarizeUploadResult(result)
        setUploadFeedback({
          variant: classifyUploadMessage(title),
          title,
          lines: result.parseErrors?.length
            ? formatParseErrorLines(result.parseErrors)
            : undefined,
        })
        setPreviewData(null)
        const input = fileRef.current
        if (input) input.value = ''
        await load()
        refreshImportHistory()
      } catch (e) {
        setUploadFeedback({
          variant: 'error',
          title: e instanceof Error ? e.message : 'Import failed',
        })
      } finally {
        setUploading(false)
      }
      return
    }
    const input = fileRef.current
    const files = Array.from(input?.files ?? [])
    if (files.length === 0) {
      setUploadFeedback({
        variant: 'error',
        title: 'Choose at least one statement file first.',
      })
      return
    }
    if (!uploadAccountId) {
      setUploadFeedback({ variant: 'error', title: 'Select an account.' })
      return
    }
    setUploading(true)
    setUploadFeedback(null)
    setErr(null)
    try {
      const fd = new FormData()
      fd.append('accountId', uploadAccountId)
      if (batchLabel.trim()) fd.append('batchLabel', batchLabel.trim())
      fd.append('profileId', profileId)
      if (files.length === 1) {
        fd.append('file', files[0])
        const result = await postFormData<UploadResult>('/api/import/upload', fd)
        const title = summarizeUploadResult(result)
        setUploadFeedback({
          variant: classifyUploadMessage(title),
          title,
          lines: result.parseErrors?.length
            ? formatParseErrorLines(result.parseErrors)
            : undefined,
        })
      } else {
        files.forEach((file) => fd.append('files', file))
        const out = await postFormData<MultiUploadResponse>('/api/import/upload-many', fd)
        const imported = out.results.filter((r) => !r.skipped).length
        const inserted = out.results.reduce((sum, r) => sum + (r.inserted ?? 0), 0)
        const skipped = out.results.length - imported
        const failedRows = out.results.reduce((sum, r) => sum + (r.rowErrors ?? 0), 0)
        const lines = out.results.slice(0, 6).map((r) => `${r.file}: ${summarizeUploadResult(r)}`)
        const title = `Multi-file import complete — ${inserted} row(s), ${imported} file(s) imported, ${skipped} skipped${failedRows ? `, ${failedRows} row error(s)` : ''}. ${lines.join(' | ')}${out.results.length > 6 ? ' | …' : ''}`
        const parseLines = out.results.flatMap((result) =>
          result.parseErrors?.length
            ? formatParseErrorLines(result.parseErrors).map(
                (line) => `${result.file}: ${line}`,
              )
            : [],
        )
        setUploadFeedback({
          variant:
            failedRows > 0 ? 'warning' : classifyUploadMessage(title),
          title,
          lines: parseLines.length > 0 ? parseLines : undefined,
        })
      }
      if (input) input.value = ''
      await load()
      refreshImportHistory()
    } catch (e) {
      setUploadFeedback({
        variant: 'error',
        title: e instanceof Error ? e.message : 'Upload failed',
      })
    } finally {
      setUploading(false)
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

      {importCleanup && importCleanup.total > 0 && (
        <section className="card aiVisibilityPanel" aria-label="Import cleanup assistant">
          <div className="aiVisibilityHeader">
            <strong>Import cleanup</strong>
            <span className="muted">
              {importCleanup.readyToConfirmCount} auto-categorized ·{' '}
              {importCleanup.needsCategoryCount} need categories ·{' '}
              {importCleanup.alreadyReviewedCount} reviewed
            </span>
          </div>
          {importCleanup.readyToConfirmCount > 0 ? (
            <div className="aiVisibilityList">
              {importCleanup.topReady.slice(0, 6).map((row) => (
                <article key={row.id} className="aiVisibilityItem">
                  <div className="aiVisibilityItemHeader">
                    <strong>{row.merchant}</strong>
                    <span className="muted">#{row.id}</span>
                  </div>
                  <p>
                    {row.category ?? 'Uncategorized'} ·{' '}
                    {formatMoney(Math.abs(row.amount), row.currency)}
                  </p>
                  <p className="muted">
                    Source: {row.source === 'rule' ? 'rule' : 'merchant memory'}
                  </p>
                </article>
              ))}
            </div>
          ) : (
            <p className="muted">
              Nothing is ready to confirm for the current filters.
            </p>
          )}
          <div className="row">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setReviewOnly(true)
                if (importCleanup.batch) setBatchFilter(importCleanup.batch)
              }}
            >
              Review cleanup queue
            </Button>
            {importCleanup.batches.length > 0 && !batchFilter && (
              <Button
                type="button"
                variant="secondary"
                onClick={() => setBatchFilter(importCleanup.batches[0].importBatch)}
              >
                Focus latest batch
              </Button>
            )}
          </div>
        </section>
      )}

      <div className="transactionsTopGrid">
        <form className="card uploadCard transactionsPanel" onSubmit={onUpload}>
          <div className="transactionsPanelHeader">
            <div>
              <h2>Upload CSV</h2>
              <p className="muted">
                Pick the account, then drop in CSV, OFX, or QFX files. With{' '}
                <strong>Automatic</strong>, the app detects the column layout from
                CSV files; OFX/QFX files use their embedded statement data.
              </p>
            </div>
            <span className="transactionsPanelBadge">
              {csvProfileOptions.length || 3} profiles
            </span>
          </div>
          {accounts.length === 0 && (
            <p className="error">
              No accounts yet — <Link to="/accounts">create one under Accounts</Link>.
            </p>
          )}
          <div className="formGrid transactionsFilterGrid">
            <Label>
              Account
              <NativeSelect
                value={uploadAccountId}
                onChange={(e) => setUploadAccountId(e.target.value)}
                required
              >
                <NativeSelectOption value="">— select —</NativeSelectOption>
                {accounts.map((a) => (
                  <NativeSelectOption key={a.id} value={a.id}>
                    {a.name}
                    {a.shortCode ? ` (${a.shortCode})` : ''}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Label>
            <Label>
              Batch label (optional)
              <Input
                value={batchLabel}
                onChange={(e) => setBatchLabel(e.target.value)}
                placeholder="defaults to YYYY-MM + account code"
              />
            </Label>
            <Label>
              CSV profile
              <NativeSelect value={profileId} onChange={(e) => setProfileId(e.target.value)}>
                {csvProfileOptions.length > 0 ? (
                  csvProfileOptions.map((p) => (
                    <NativeSelectOption key={p.id} value={p.id} title={p.hint}>
                      {p.label}
                      {p.hint ? ` — ${p.hint}` : ''}
                    </NativeSelectOption>
                  ))
                ) : (
                  <Fragment>
                    <NativeSelectOption value="auto">Automatic</NativeSelectOption>
                    <NativeSelectOption value="generic_simple">generic_simple (ISO dates)</NativeSelectOption>
                    <NativeSelectOption value="generic_amex">generic_amex (Amex)</NativeSelectOption>
                  </Fragment>
                )}
              </NativeSelect>
            </Label>
            <Label className="filePick">
              Statement files
              <Input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv,.ofx,.qfx"
                multiple
                onChange={() => {
                  setPreviewData(null)
                  setUploadFeedback(null)
                }}
              />
            </Label>
          </div>
          <div className="row transactionsActionRow">
            <Button
              type="button"
              variant="secondary"
              disabled={
                uploading ||
                previewing ||
                !uploadAccountId ||
                accounts.length === 0
              }
              onClick={() => void onPreview()}
            >
              {previewing ? 'Previewing…' : 'Preview statement'}
            </Button>
            <Button type="submit" disabled={uploading}>
              {uploading ? 'Importing…' : previewData?.previewToken ? 'Commit preview' : 'Import CSV file(s)'}
            </Button>
          </div>
          {uploadFeedback && (
            <Alert
              className="mt-3"
              variant={uploadFeedback.variant}
              title={uploadFeedback.title}
            >
              {uploadFeedback.lines && uploadFeedback.lines.length > 0 ? (
                <ul
                  className="parseErrorList m-0 pl-5"
                  aria-label="Rows that failed to parse"
                >
                  {uploadFeedback.lines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              ) : null}
            </Alert>
          )}
          {previewData && (
            <div className="previewBlock">
              <p className="muted">
                Parser: <strong>{previewData.usedParser}</strong>
                {previewData.headers?.length ? (
                  <>
                    {' · '}Parsed columns: <code>{previewData.headers.join(', ')}</code>
                  </>
                ) : null}
                {' · '}
                Showing up to {previewData.previewRowLimit} data rows (not imported).
              </p>
              {previewData.usedProfileId != null && (
                <p className="muted">
                  Profile used: <strong>{previewData.usedProfileId}</strong>
                  {previewData.profileInferred ? ' (auto-detected)' : ''}
                </p>
              )}
              <p className="muted">
                Preview contains {previewData.transactions.length} transaction(s),{' '}
                {previewData.investmentActivities.length} investment activit{previewData.investmentActivities.length === 1 ? 'y' : 'ies'}, and{' '}
                {previewData.holdings.length} holding(s). Duplicates detected:{' '}
                {previewData.duplicateCounts.transactions + previewData.duplicateCounts.investmentActivities + previewData.duplicateCounts.holdings}.
              </p>
              {previewData.warnings.length > 0 && (
                <ul className="parseErrorList" aria-label="Statement import warnings">
                  {previewData.warnings.slice(0, 8).map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              )}
              <div className="tableWrap">
                <Table className="table">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Row</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Merchant</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Cur</TableHead>
                      <TableHead>Parse note</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(previewData.rows ?? []).map((row) => (
                      <TableRow key={row.rowIndex}>
                        <TableCell>{row.rowIndex}</TableCell>
                        <TableCell>{row.ok ? 'OK' : 'Error'}</TableCell>
                        <TableCell>{row.ok ? row.mapped.date : '—'}</TableCell>
                        <TableCell>{row.ok ? row.mapped.merchantClean : '—'}</TableCell>
                        <TableCell>{row.ok ? String(row.mapped.amount) : '—'}</TableCell>
                        <TableCell>{row.ok ? row.mapped.currency : '—'}</TableCell>
                        <TableCell className={row.ok ? '' : 'error'}>
                          {row.ok ? '—' : row.error}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </form>

        <section
          className="card transactionsPanel transactionsHistoryCard"
          aria-labelledby="import-history-heading"
        >
          <div className="transactionsPanelHeader">
            <div>
              <h2 id="import-history-heading">Recent imports</h2>
              <p className="muted">
                Last 50 runs. Filter transactions by batch directly from here.
              </p>
            </div>
            <Button
              type="button"
              variant="secondary"
              onClick={async () => {
                try {
                  setRunningFolderImport(true)
                  setErr(null)
                  setUploadFeedback(null)
                  const out = await postJson<FolderImportResponse>('/api/import/run', {})
                  const imported = out.results.filter((r) => !r.skipped).length
                  const skipped = out.results.length - imported
                  const lines = out.results.slice(0, 6).map((r) => {
                    if (r.skipped) {
                      return `${r.file}: skipped (${r.reason})${r.message ? ` — ${r.message}` : ''}`
                    }
                    return `${r.file}: ${r.inserted ?? 0} rows${r.warning ? ` — ${r.warning}` : ''}`
                  })
                  const title = lines.length
                    ? `Folder import complete — ${imported} imported, ${skipped} skipped. ${lines.join(' | ')}${out.results.length > 6 ? ' | …' : ''}`
                    : `No .csv files in upload folder: ${out.uploadDir}`
                  setUploadFeedback({
                    variant: classifyUploadMessage(title),
                    title,
                  })
                  await load()
                  refreshImportHistory()
                } catch (e) {
                  setErr(e instanceof Error ? e.message : 'Import failed')
                } finally {
                  setRunningFolderImport(false)
                }
              }}
              disabled={runningFolderImport}
            >
              {runningFolderImport ? 'Running import…' : 'Run folder import'}
            </Button>
          </div>
          <div className="tableWrap">
            <Table className="table">
              <TableHeader>
                <TableRow>
                  <TableHead>Started</TableHead>
                  <TableHead>File</TableHead>
                  <TableHead>Batch</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Rows</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {importHistory.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="muted pad">
                      No import history yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  importHistory.map((h) => (
                    <TableRow key={h.id}>
                      <TableCell>{h.startedAt.slice(0, 19).replace('T', ' ')}</TableCell>
                      <TableCell title={h.fileName}>{h.fileName}</TableCell>
                      <TableCell>{h.batchLabel}</TableCell>
                      <TableCell>
                        {h.status}
                        {h.errorMessage ? (
                          <span className="muted" title={h.errorMessage}>
                            {' '}
                            ({h.errorMessage.slice(0, 40)}
                            {h.errorMessage.length > 40 ? '…' : ''})
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell>{h.rowCount ?? '—'}</TableCell>
                      <TableCell>
                        <Button
                          type="button"
                          variant="link"
                          size="sm"
                          onClick={() => {
                            setPage(1)
                            setBatchFilter(h.batchLabel)
                          }}
                        >
                          Filter by batch
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </section>
      </div>

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
              onChange={(e) => {
                setPage(1)
                setDateTo(e.target.value)
              }}
            />
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
            {activeFilters.map((filter) => (
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
            ))}
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
      {selectedIds.size > 0 && (
        <div className="card bulkBar transactionsBulkCard">
          <div className="transactionsBulkHeader">
            <strong>{selectedIds.size} selected</strong>
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
              bulkApplying || !buildBulkPatch() || selectedIds.size === 0
            }
            onClick={() => void applyBulk()}
          >
            {bulkApplying ? 'Applying…' : 'Apply to selected'}
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => setSelectedIds(new Set())}
          >
            Clear selection
          </Button>
        </div>
      )}
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
                <TableRow>
                  <TableCell colSpan={9} className="muted pad">
                    Loading…
                  </TableCell>
                </TableRow>
              ) : !sortedRows.length ? (
                <TableRow>
                  <TableCell colSpan={9} className="emptyStateCell">
                    <p>No transactions yet — or none match your filters.</p>
                    <p className="muted">
                      Upload a CSV above (pick an account first), or use <strong>Run import</strong> if you
                      placed files in the configured upload folder. Create accounts under{' '}
                      <Link to="/accounts">Accounts</Link> if needed.
                    </p>
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
                    onError={(msg) => setErr(msg)}
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
  onError,
}: {
  t: Transaction
  categoryOptions: string[]
  contacts: Contact[]
  selected: boolean
  onToggleSelected: () => void
  onSave: (id: number, patch: Record<string, unknown>) => Promise<void>
  aiEnabled: boolean
  onAttachReceipt: (transactionId: number) => void
  onError: (message: string) => void
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
    setAiSuggestion(null)
    setAiSuggestionId(null)
  }, [t])

  useEffect(() => {
    resetDraft()
  }, [resetDraft])

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
          {t.receiptWarnings?.length ? (
            <span className="txnBadge txnBadge--review" title={t.receiptWarnings.join(', ')}>
              Receipt check
            </span>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="transactionsActionsCol">
        <div className="txnActionGroup">
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
      </TableCell>
    </TableRow>
  )
}
