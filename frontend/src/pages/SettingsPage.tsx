import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { PageHeader } from '@/components/ui/page-header'
import { useToast } from '@/components/ui/toast'
import { deleteReq, getJson, patchJson, postJson } from '../lib/api'
import { formatMoney } from '../lib/formatMoney'
import {
  listCaptureTokens,
  mintCaptureToken,
  revokeCaptureToken,
  type CaptureTokenRow,
} from '../lib/captureTokens'
import { layoutWidthOptions, useLayoutWidth } from '../lib/layoutWidth'
import { useAuth } from '../lib/useAuth'
import type { Budget, BudgetInput, BudgetsResponse, Contact } from '../types/api'

const BUDGET_CATEGORY_OVERALL = ''
const DEFAULT_BUDGET_CURRENCY = 'CAD'

type CategoryHint = { label: string; usageCount: number }

type BudgetFormState = {
  category: string
  currency: string
  amount: string
}

const emptyBudgetForm: BudgetFormState = {
  category: BUDGET_CATEGORY_OVERALL,
  currency: DEFAULT_BUDGET_CURRENCY,
  amount: '',
}

/**
 * Wrapper for `fetch` PUT against /api/budgets/:id. The shared `lib/api.ts`
 * helper set exposes POST/PATCH/DELETE but not PUT, and the budgets route
 * uses PUT for full replacement semantics. Mirrors the credential and
 * error-handling contract of the shared helpers.
 */
async function putBudget(id: number, body: BudgetInput): Promise<Budget> {
  const base = import.meta.env.VITE_API_BASE ?? ''
  const res = await fetch(`${base}/api/budgets/${id}`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    let message = res.statusText
    const raw = await res.text()
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { error?: string }
        message = parsed.error ?? raw
      } catch {
        message = raw
      }
    }
    throw new Error(message)
  }
  return (await res.json()) as Budget
}

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

export function SettingsPage() {
  const auth = useAuth()
  const { showToast } = useToast()
  const [layoutWidth, setLayoutWidth] = useLayoutWidth()
  const [contacts, setContacts] = useState<Contact[]>([])
  const [invite, setInvite] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [renameTarget, setRenameTarget] = useState<Contact | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renameSaving, setRenameSaving] = useState(false)
  const [budgets, setBudgets] = useState<Budget[]>([])
  const [budgetCategoryHints, setBudgetCategoryHints] = useState<string[]>([])
  const [budgetForm, setBudgetForm] = useState<BudgetFormState>(emptyBudgetForm)
  const [budgetSubmitting, setBudgetSubmitting] = useState(false)
  const [budgetEditId, setBudgetEditId] = useState<number | null>(null)
  const [budgetEditForm, setBudgetEditForm] = useState<BudgetFormState>(emptyBudgetForm)
  const [budgetEditSaving, setBudgetEditSaving] = useState(false)
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
  const [receiptBusy, setReceiptBusy] = useState<'text' | 'image' | 'csv' | 'pdf' | null>(null)
  const [receiptError, setReceiptError] = useState<string | null>(null)
  const [receiptResult, setReceiptResult] = useState<ReceiptImportResult | null>(null)
  const [csvVendor, setCsvVendor] = useState<'apple' | 'google' | 'amazon' | 'other'>('apple')
  const [csvResult, setCsvResult] = useState<PurchaseHistoryCsvResult | null>(null)
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

  const [captureToken, setCaptureToken] = useState<CaptureTokenRow | null>(null)
  const [captureTokenPlaintext, setCaptureTokenPlaintext] = useState<string | null>(null)
  const [captureBookmarklets, setCaptureBookmarklets] = useState<{
    amazon: string
    apple: string
  } | null>(null)
  const [captureLoading, setCaptureLoading] = useState(false)
  const [captureError, setCaptureError] = useState<string | null>(null)
  const mountedRef = useRef(true)
  useEffect(() => {
    return () => {
      mountedRef.current = false
    }
  }, [])

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

  async function runGmailScan(maxMessages: number, sinceDays?: number) {
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
      const res = await fetch(`${base}/api/email/scan/google?stream=1`, {
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

  const loadBudgets = useCallback(async () => {
    try {
      const resp = await getJson<BudgetsResponse>('/api/budgets')
      setBudgets(resp.data)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load budgets')
    }
  }, [])

  useEffect(() => {
    void loadContacts()
    void loadBudgets()
    // Category-hints is the same source the Rules and Review pages use. It
    // returns each known final category with its usage count; we only need
    // the labels here, sorted alphabetically for the dropdown.
    void getJson<{ categories: CategoryHint[] }>('/api/transactions/category-hints')
      .then((data) => {
        const labels = data.categories
          .map((c) => c.label)
          .filter((label) => label.length > 0)
        labels.sort((a, b) => a.localeCompare(b))
        setBudgetCategoryHints(labels)
      })
      .catch(() => setBudgetCategoryHints([]))
  }, [loadContacts, loadBudgets])

  /**
   * Normalize a budget form into the POST/PUT body the route expects.
   * Returns `null` if validation fails — caller surfaces a toast.
   *
   * Category is `null` when the user leaves it on "Overall" (sentinel value
   * is the empty string in form state). Amount must parse as a positive
   * number; currency is uppercased and length-checked. The backend repeats
   * these checks so we do not need to be exhaustive — we just want to avoid
   * obviously-invalid requests round-tripping.
   */
  function buildBudgetInput(form: BudgetFormState): BudgetInput | null {
    const currency = form.currency.trim().toUpperCase()
    if (currency.length !== 3) return null
    const amount = Number(form.amount)
    if (!Number.isFinite(amount) || amount <= 0) return null
    const category = form.category.trim() ? form.category.trim() : null
    return { category, currency, amount, period: 'monthly' }
  }

  async function createBudget(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setErr(null)
    const input = buildBudgetInput(budgetForm)
    if (!input) {
      showToast({
        title: 'Could not add budget',
        description: 'Pick a currency and a positive amount.',
        variant: 'destructive',
      })
      return
    }
    setBudgetSubmitting(true)
    try {
      await postJson<Budget>('/api/budgets', input)
      setBudgetForm(emptyBudgetForm)
      await loadBudgets()
      showToast({
        title: `Added budget for ${input.category ?? 'Overall'}`,
        description: `${formatMoney(input.amount, input.currency)} per month`,
        variant: 'success',
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not add budget'
      setErr(message)
      showToast({
        title: 'Could not add budget',
        description: message,
        variant: 'destructive',
      })
    } finally {
      setBudgetSubmitting(false)
    }
  }

  function openBudgetEdit(budget: Budget) {
    setBudgetEditId(budget.id)
    setBudgetEditForm({
      category: budget.category ?? BUDGET_CATEGORY_OVERALL,
      currency: budget.currency,
      amount: String(Number(budget.amount)),
    })
  }

  function cancelBudgetEdit() {
    setBudgetEditId(null)
    setBudgetEditForm(emptyBudgetForm)
    setBudgetEditSaving(false)
  }

  async function saveBudgetEdit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (budgetEditId == null) return
    setErr(null)
    const input = buildBudgetInput(budgetEditForm)
    if (!input) {
      showToast({
        title: 'Could not save budget',
        description: 'Pick a currency and a positive amount.',
        variant: 'destructive',
      })
      return
    }
    setBudgetEditSaving(true)
    try {
      await putBudget(budgetEditId, input)
      cancelBudgetEdit()
      await loadBudgets()
      showToast({
        title: 'Budget updated',
        variant: 'success',
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not save budget'
      setErr(message)
      showToast({
        title: 'Could not save budget',
        description: message,
        variant: 'destructive',
      })
      setBudgetEditSaving(false)
    }
  }

  async function deleteBudget(budget: Budget) {
    const label = budget.category ?? 'Overall'
    const ok = await confirm({
      title: 'Delete budget?',
      description: `${label} (${budget.currency}) will stop appearing on the dashboard.`,
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    try {
      await deleteReq(`/api/budgets/${budget.id}`)
      await loadBudgets()
      showToast({ title: 'Budget removed', variant: 'success' })
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not delete budget'
      setErr(message)
      showToast({
        title: 'Could not delete budget',
        description: message,
        variant: 'destructive',
      })
    }
  }

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

  // Stable display ordering for budgets — currency first, then category
  // (with "Overall" floated to the top of each currency group). The route
  // already orders this way, but UI updates can interleave optimistic
  // changes, so sort defensively.
  const sortedBudgets = useMemo(() => {
    return [...budgets].sort((a, b) => {
      if (a.currency !== b.currency) return a.currency.localeCompare(b.currency)
      if (a.category == null && b.category != null) return -1
      if (a.category != null && b.category == null) return 1
      return (a.category ?? '').localeCompare(b.category ?? '')
    })
  }, [budgets])

  const budgetCategoryDatalistId = 'settings-budget-category-options'

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
                            <span style={{ color: 'var(--success, green)' }}>
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
                          <button
                            type="button"
                            onClick={() => void deleteAllowlistRow(row.id)}
                            style={{
                              background: 'none',
                              border: 'none',
                              color: 'var(--destructive, #c00)',
                              cursor: 'pointer',
                              fontSize: '0.85rem',
                            }}
                          >
                            Remove
                          </button>
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
          </div>
        )}
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
              <Sparkles aria-hidden="true" />
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
              {receiptResult.extracted.tenders && receiptResult.extracted.tenders.length > 1 && (
                <div className="muted" style={{ marginTop: '0.25rem', fontSize: '0.85rem' }}>
                  Split tender:{' '}
                  {receiptResult.extracted.tenders
                    .map((t) => `${t.network ?? 'card'}${t.paymentLast4 ? ` ••${t.paymentLast4}` : ''} ${t.amount}`)
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
          </p>
        )}
        {captureBookmarklets && (
          <div className="row" style={{ gap: '0.5rem', marginTop: '0.75rem' }}>
            <a
              className="inline-flex h-10 items-center justify-center whitespace-nowrap rounded-lg border px-4 font-semibold transition-colors hover:opacity-90"
              style={{
                backgroundColor: 'var(--bg2)',
                color: 'var(--fg)',
                borderColor: 'var(--border)',
              }}
              href={captureBookmarklets.amazon}
              draggable
              onClick={(e) => e.preventDefault()}
            >
              ↗ Capture Amazon orders
            </a>
            <a
              className="inline-flex h-10 items-center justify-center whitespace-nowrap rounded-lg border px-4 font-semibold transition-colors hover:opacity-90"
              style={{
                backgroundColor: 'var(--bg2)',
                color: 'var(--fg)',
                borderColor: 'var(--border)',
              }}
              href={captureBookmarklets.apple}
              draggable
              onClick={(e) => e.preventDefault()}
            >
              ↗ Capture Apple purchases
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

      <Card className="accountsFormCard">
        <div className="accountsCardHeader">
          <div>
            <h2>Monthly budgets</h2>
            <p className="muted">
              Set a per-currency target for a single category or an overall
              cap. Progress appears on the dashboard.
            </p>
          </div>
        </div>
        {sortedBudgets.length === 0 ? (
          <EmptyState
            title="No budgets yet."
            description="Add one to track monthly progress."
          />
        ) : (
          <div className="tableWrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Category</th>
                  <th>Currency</th>
                  <th>Amount</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {sortedBudgets.map((budget) => {
                  const isEditing = budgetEditId === budget.id
                  if (isEditing) {
                    return (
                      <tr key={budget.id}>
                        <td colSpan={4}>
                          <form onSubmit={saveBudgetEdit}>
                            <div className="formGrid">
                              <Label htmlFor={`settings-budget-edit-category-${budget.id}`}>
                                Category
                                <Input
                                  id={`settings-budget-edit-category-${budget.id}`}
                                  list={budgetCategoryDatalistId}
                                  value={budgetEditForm.category}
                                  onChange={(e) =>
                                    setBudgetEditForm((prev) => ({
                                      ...prev,
                                      category: e.target.value,
                                    }))
                                  }
                                  placeholder="Overall"
                                  autoComplete="off"
                                />
                              </Label>
                              <Label htmlFor={`settings-budget-edit-currency-${budget.id}`}>
                                Currency
                                <Input
                                  id={`settings-budget-edit-currency-${budget.id}`}
                                  value={budgetEditForm.currency}
                                  onChange={(e) =>
                                    setBudgetEditForm((prev) => ({
                                      ...prev,
                                      currency: e.target.value.toUpperCase().slice(0, 3),
                                    }))
                                  }
                                  required
                                  maxLength={3}
                                  autoComplete="off"
                                />
                              </Label>
                              <Label htmlFor={`settings-budget-edit-amount-${budget.id}`}>
                                Amount
                                <Input
                                  id={`settings-budget-edit-amount-${budget.id}`}
                                  type="number"
                                  step="0.01"
                                  min="0.01"
                                  value={budgetEditForm.amount}
                                  onChange={(e) =>
                                    setBudgetEditForm((prev) => ({
                                      ...prev,
                                      amount: e.target.value,
                                    }))
                                  }
                                  required
                                />
                              </Label>
                            </div>
                            <div className="row">
                              <Button
                                type="submit"
                                size="sm"
                                disabled={budgetEditSaving}
                              >
                                Save
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={cancelBudgetEdit}
                                disabled={budgetEditSaving}
                              >
                                Cancel
                              </Button>
                            </div>
                          </form>
                        </td>
                      </tr>
                    )
                  }
                  return (
                    <tr key={budget.id}>
                      <td>{budget.category ?? 'Overall'}</td>
                      <td>{budget.currency}</td>
                      <td>{formatMoney(Number(budget.amount), budget.currency)}</td>
                      <td>
                        <div className="row">
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            onClick={() => openBudgetEdit(budget)}
                          >
                            <Edit3 aria-hidden="true" />
                            Edit
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="destructive"
                            onClick={() => void deleteBudget(budget)}
                          >
                            <Trash2 aria-hidden="true" />
                            Delete
                          </Button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <form onSubmit={createBudget}>
          <div className="formGrid">
            <Label htmlFor="settings-budget-category">
              Category
              <NativeSelect
                id="settings-budget-category"
                value={budgetForm.category}
                onChange={(e) =>
                  setBudgetForm((prev) => ({ ...prev, category: e.target.value }))
                }
              >
                <option value={BUDGET_CATEGORY_OVERALL}>Overall (all categories)</option>
                {budgetCategoryHints.map((label) => (
                  <option key={label} value={label}>
                    {label}
                  </option>
                ))}
              </NativeSelect>
            </Label>
            <Label htmlFor="settings-budget-currency">
              Currency
              <Input
                id="settings-budget-currency"
                value={budgetForm.currency}
                onChange={(e) =>
                  setBudgetForm((prev) => ({
                    ...prev,
                    currency: e.target.value.toUpperCase().slice(0, 3),
                  }))
                }
                required
                maxLength={3}
                autoComplete="off"
                placeholder="CAD"
              />
            </Label>
            <Label htmlFor="settings-budget-amount">
              Amount
              <Input
                id="settings-budget-amount"
                type="number"
                step="0.01"
                min="0.01"
                value={budgetForm.amount}
                onChange={(e) =>
                  setBudgetForm((prev) => ({ ...prev, amount: e.target.value }))
                }
                required
                placeholder="500.00"
              />
            </Label>
          </div>
          <Button type="submit" disabled={budgetSubmitting}>
            <Plus aria-hidden="true" />
            Add budget
          </Button>
        </form>
        {/* Datalist powers the inline edit category Input — the create form
            uses a NativeSelect with the same labels so the dropdown stays
            keyboard-friendly. Both share one option set. */}
        <datalist id={budgetCategoryDatalistId}>
          {budgetCategoryHints.map((label) => (
            <option key={label} value={label} />
          ))}
        </datalist>
      </Card>
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
