import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Check,
  Keyboard,
  ListChecks,
  RefreshCw,
  Search,
  ShieldCheck,
  Wand2,
} from 'lucide-react'
import type { ImportConfidenceFlagToken } from '@cashflow/shared'
import { IMPORT_CONFIDENCE_FLAG_TOKENS } from '@cashflow/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyTableRow } from '@/components/ui/empty-state'
import { EnrichmentSignalsDialog } from '@/components/EnrichmentSignalsDialog'
import { Alert } from '@/components/ui/alert'
import { Grid } from '@/components/ui/grid'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select'
import { PageHeader } from '@/components/ui/page-header'
import { SectionHeader } from '@/components/ui/section-header'
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
import { ItemRow } from '../components/items/ItemRow'
import { getJson, patchJson, postJson } from '../lib/api'
import { resolveCategoryPath } from '../lib/categoriesApi'
import { useAttachAndAnalyzeReceipt } from '../lib/useAttachAndAnalyzeReceipt'
import { formatMoney } from '../lib/formatMoney'
import {
  buildReviewBulkPatch,
  getReviewInboxSummary,
  getSelectedReviewSummary,
} from '../lib/reviewInbox'
import { useCategoryPaths } from '../lib/useCategoryPaths'
import { TAX_TREATMENTS } from '../lib/taxTreatment'
import { TaxTreatmentSelect } from '../components/TaxTreatmentSelect'
import type { TaxTreatment } from '../lib/taxTreatment'
import type { ExternalOrderItemView } from '../../../shared/api-types'
import type { Paginated, Transaction } from '../types/api'

type CategoryHint = {
  label: string
  usageCount: number
}

type RuleResponse = {
  id: number
}

const PAGE_SIZE = 100

const SHORTCUT_HELP: Array<{ keys: string; action: string }> = [
  { keys: 'j', action: 'Move cursor down' },
  { keys: 'k', action: 'Move cursor up' },
  { keys: 'x or Space', action: 'Toggle selection of cursor row' },
  { keys: 'a', action: 'Select all visible rows' },
  { keys: 'n', action: 'Clear selection' },
  { keys: 'c', action: 'Focus category picker (selects cursor row if empty)' },
  { keys: 'Enter', action: 'Apply current decision when valid' },
  { keys: '?', action: 'Show this shortcuts list' },
]

const SHORTCUT_HELP_TEXT = SHORTCUT_HELP.map(
  (s) => `${s.keys}: ${s.action}`
).join(' • ')

// Returns true when the active element is a typing surface (an input,
// textarea, select, or any contenteditable element) where single-key shortcuts
// would interfere with normal typing.
function isTypingContext(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (target.isContentEditable) return true
  return false
}

function buildRevertPatch(
  row: Transaction,
  patchKeys: string[]
): Record<string, unknown> {
  const revert: Record<string, unknown> = {}
  for (const key of patchKeys) {
    switch (key) {
      case 'categoryOverride':
        revert.categoryOverride = row.categoryOverride
        break
      case 'businessOverride':
        revert.businessOverride = row.businessOverride
        break
      case 'taxTreatmentOverride':
        revert.taxTreatmentOverride = row.taxTreatmentOverride
        break
      case 'splitOverride':
        revert.splitOverride = row.splitOverride
        break
      case 'reviewFlag':
        revert.reviewFlag = row.reviewFlag
        break
      default:
        break
    }
  }
  return revert
}

// Filter chips for the import-confidence flag tokens (#214). Excludes
// 'needs_review' because that's the inbox default — every loaded row already
// has reviewFlag=true. The remaining tokens narrow the queue by the reason
// the row landed here.
const CONFIDENCE_FLAG_CHIPS: Array<{
  token: ImportConfidenceFlagToken
  label: string
}> = IMPORT_CONFIDENCE_FLAG_TOKENS.filter((t) => t !== 'needs_review').map(
  (t) => ({
    token: t,
    label:
      t === 'missing_category'
        ? 'Missing category'
        : t === 'missing_split'
          ? 'Missing split'
          : t === 'likely_duplicate'
            ? 'Likely duplicate'
            : t === 'possible_refund_pair'
              ? 'Refund pair'
              : 'Missing receipt',
  }),
)

/** Keyboard shortcut key badge — styled kbd element used in the shortcuts hint bar. */
function KbdKey({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex min-w-5 items-center justify-center rounded border border-[var(--border)] bg-[var(--muted)] px-1 py-0.5 font-mono text-[0.7rem] text-[var(--foreground)]">
      {children}
    </kbd>
  )
}

/** An item is a straggler (needs review) when no category has been resolved at sufficient confidence.
 * Mirrors the backend ENRICHMENT_ITEM_CLEAR_CONFIDENCE threshold (>=80). */
function isItemStraggler(item: ExternalOrderItemView): boolean {
  if (item.categoryOverride != null && item.categoryOverride !== '') return false;
  const conf = item.confidence != null ? Number(item.confidence) : NaN;
  return !(item.inferredCategory != null && item.inferredCategory !== '' && Number.isFinite(conf) && conf >= 80);
}

export function ReviewInboxPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [rows, setRows] = useState<Transaction[]>([])
  const [total, setTotal] = useState(0)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set())
  const [expandedIds, setExpandedIds] = useState<Set<number>>(() => new Set())
  const [itemsByTxn, setItemsByTxn] = useState<Map<number, ExternalOrderItemView[]>>(
    () => new Map()
  )
  const [categoryHints, setCategoryHints] = useState<CategoryHint[]>([])
  const [category, setCategory] = useState('')
  const [business, setBusiness] = useState('')
  const [splitType, setSplitType] = useState('')
  const [taxTreatment, setTaxTreatment] = useState<TaxTreatment | ''>('')
  const { paths: categoryPaths } = useCategoryPaths()
  const [merchantFilter, setMerchantFilter] = useState('')
  const [batchFilter, setBatchFilter] = useState('')
  const confidenceFlag =
    (searchParams.get('confidenceFlag') as ImportConfidenceFlagToken | null) ?? null
  const setConfidenceFlag = useCallback(
    (next: ImportConfidenceFlagToken | null) => {
      const params = new URLSearchParams(searchParams)
      if (next) params.set('confidenceFlag', next)
      else params.delete('confidenceFlag')
      setSearchParams(params, { replace: true })
    },
    [searchParams, setSearchParams],
  )
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [cursorRowId, setCursorRowId] = useState<number | null>(null)
  const [signalsDialogTxnId, setSignalsDialogTxnId] = useState<number | null>(null)
  const [showShortcutHint, setShowShortcutHint] = useState(() => {
    try {
      return localStorage.getItem('seenReviewInboxShortcuts') !== 'true'
    } catch {
      return false
    }
  })
  const { showToast } = useToast()
  const categoryPickerRef = useRef<HTMLDivElement>(null)
  const tableWrapRef = useRef<HTMLDivElement>(null)
  const receiptInputRef = useRef<HTMLInputElement>(null)
  const [receiptTargetTxnId, setReceiptTargetTxnId] = useState<number | null>(null)
  const [lastAnalyzedTxnId, setLastAnalyzedTxnId] = useState<number | null>(null)
  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const qs = new URLSearchParams({
        reviewFlag: 'true',
        pageSize: String(PAGE_SIZE),
      })
      if (confidenceFlag) qs.set('confidenceFlag', confidenceFlag)
      const data = await getJson<Paginated<Transaction>>(
        `/api/transactions?${qs.toString()}`
      )
      setRows(data.data)
      setTotal(data.total)
      setSelectedIds(new Set())
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'Could not load review inbox')
    } finally {
      setLoading(false)
    }
  }, [confidenceFlag])

  const onReceiptDone = useCallback(async () => { await load() }, [load])
  const { attachAndAnalyze, busyTxnId, lastItemCount, error: attachErr } =
    useAttachAndAnalyzeReceipt(onReceiptDone)

  const toggleExpanded = useCallback(
    async (id: number) => {
      const isCurrentlyExpanded = expandedIds.has(id)
      setExpandedIds((prev) => {
        const next = new Set(prev)
        if (next.has(id)) {
          next.delete(id)
        } else {
          next.add(id)
        }
        return next
      })
      // Lazy-load items on first expand only
      if (!isCurrentlyExpanded && !itemsByTxn.has(id)) {
        try {
          const receipts = await getJson<Array<{ items: ExternalOrderItemView[] }>>(
            `/api/transactions/${id}/receipts`
          )
          const allItems = receipts.flatMap((r) => r.items)
          setItemsByTxn((prev) => new Map(prev).set(id, allItems))
        } catch {
          // Silently ignore load errors; items will just be empty
        }
      }
    },
    [expandedIds, itemsByTxn]
  )

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    void getJson<{ categories: CategoryHint[] }>('/api/transactions/category-hints')
      .then((data) => setCategoryHints(data.categories))
      .catch(() => setCategoryHints([]))
  }, [])

  useEffect(() => {
    setSelectedIds(new Set())
  }, [batchFilter, merchantFilter])

  const visibleRows = useMemo(() => {
    const merchant = merchantFilter.trim().toLowerCase()
    const batch = batchFilter.trim()
    return rows.filter((row) => {
      if (merchant && !row.merchantClean.toLowerCase().includes(merchant)) {
        return false
      }
      if (batch && row.importBatch !== batch) return false
      return true
    })
  }, [batchFilter, merchantFilter, rows])

  const summary = useMemo(() => getReviewInboxSummary(rows), [rows])
  const selectedSummary = useMemo(
    () => getSelectedReviewSummary(visibleRows, selectedIds),
    [selectedIds, visibleRows]
  )
  const selectedRows = useMemo(
    () => visibleRows.filter((row) => selectedIds.has(row.id)),
    [selectedIds, visibleRows]
  )
  const selectedIdsList = useMemo(() => [...selectedIds], [selectedIds])
  const uniqueBatches = useMemo(
    () => Array.from(new Set(rows.map((row) => row.importBatch))).filter(Boolean),
    [rows]
  )

  const patch = useMemo(
    () =>
      buildReviewBulkPatch({
        category,
        business,
        splitType,
        taxTreatment,
        markReviewed: true,
      }),
    [business, category, splitType, taxTreatment]
  )

  const canApply = selectedIds.size > 0 && Object.keys(patch).length > 0
  const canCreateRule =
    selectedSummary.commonMerchant != null && category.trim().length > 0

  // Keep cursorRowId valid: clamp to a visible row, or clear if the table is
  // empty. Default to the first visible row when no cursor exists yet.
  useEffect(() => {
    if (visibleRows.length === 0) {
      if (cursorRowId !== null) setCursorRowId(null)
      return
    }
    if (cursorRowId == null || !visibleRows.some((row) => row.id === cursorRowId)) {
      setCursorRowId(visibleRows[0].id)
    }
  }, [cursorRowId, visibleRows])

  function toggleSelected(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAllVisible() {
    setSelectedIds((prev) => {
      const visibleIds = visibleRows.map((row) => row.id)
      const allSelected =
        visibleIds.length > 0 && visibleIds.every((id) => prev.has(id))
      if (allSelected) return new Set()
      return new Set(visibleIds)
    })
  }

  const showShortcutsHelp = useCallback(() => {
    showToast({
      title: 'Keyboard shortcuts',
      description: SHORTCUT_HELP_TEXT,
      durationMs: 8000,
    })
  }, [showToast])

  const focusCategoryPicker = useCallback(() => {
    const input = categoryPickerRef.current?.querySelector('input')
    if (input instanceof HTMLInputElement) {
      input.focus()
      input.select()
    }
  }, [])

  // Use refs so the global keydown listener can read the latest state without
  // re-attaching on every render. The listener is mounted once.
  const stateRef = useRef({
    visibleRows,
    cursorRowId,
    canApply,
    applying,
    selectedIds,
  })
  useEffect(() => {
    stateRef.current = {
      visibleRows,
      cursorRowId,
      canApply,
      applying,
      selectedIds,
    }
  })

  const applyDecisionRef = useRef<() => void>(() => {})
  const focusCategoryPickerRef = useRef(focusCategoryPicker)
  const showShortcutsHelpRef = useRef(showShortcutsHelp)
  useEffect(() => {
    focusCategoryPickerRef.current = focusCategoryPicker
  }, [focusCategoryPicker])
  useEffect(() => {
    showShortcutsHelpRef.current = showShortcutsHelp
  }, [showShortcutsHelp])

  useEffect(() => {
    function moveCursor(delta: number) {
      const { visibleRows: rows, cursorRowId: current } = stateRef.current
      if (rows.length === 0) return
      const currentIdx = rows.findIndex((row) => row.id === current)
      const nextIdx =
        currentIdx === -1
          ? 0
          : Math.min(Math.max(currentIdx + delta, 0), rows.length - 1)
      const nextId = rows[nextIdx].id
      setCursorRowId(nextId)
      // Scroll into view inside the table wrap.
      const wrap = tableWrapRef.current
      if (wrap) {
        const target = wrap.querySelector<HTMLElement>(
          `[data-row-id="${nextId}"]`
        )
        target?.scrollIntoView({ block: 'nearest' })
      }
    }

    function toggleCursorRowSelection() {
      const { cursorRowId: current } = stateRef.current
      if (current == null) return
      toggleSelected(current)
    }

    function selectAllVisible() {
      const { visibleRows: rows } = stateRef.current
      if (rows.length === 0) return
      setSelectedIds(new Set(rows.map((row) => row.id)))
    }

    function clearSelection() {
      setSelectedIds(new Set())
    }

    function openCategoryPicker() {
      const {
        cursorRowId: current,
        selectedIds: ids,
      } = stateRef.current
      if (ids.size === 0 && current != null) {
        setSelectedIds(new Set([current]))
      }
      focusCategoryPickerRef.current()
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (isTypingContext(event.target)) return

      const key = event.key

      if (key === 'j' || key === 'J') {
        event.preventDefault()
        moveCursor(1)
        return
      }
      if (key === 'k' || key === 'K') {
        event.preventDefault()
        moveCursor(-1)
        return
      }
      if (key === ' ' || key === 'x' || key === 'X') {
        event.preventDefault()
        toggleCursorRowSelection()
        return
      }
      if (key === 'a' || key === 'A') {
        event.preventDefault()
        selectAllVisible()
        return
      }
      if (key === 'n' || key === 'N') {
        event.preventDefault()
        clearSelection()
        return
      }
      if (key === 'c' || key === 'C') {
        event.preventDefault()
        openCategoryPicker()
        return
      }
      if (key === 'Enter') {
        const { canApply: ok, applying: busy } = stateRef.current
        if (!ok || busy) return
        event.preventDefault()
        applyDecisionRef.current()
        return
      }
      if (key === '?' || (event.shiftKey && key === '/')) {
        event.preventDefault()
        showShortcutsHelpRef.current()
        return
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  // Keep the keydown listener's applyDecision ref pointed at the latest closure.
  useEffect(() => {
    applyDecisionRef.current = () => {
      void applyDecision()
    }
  })

  async function applyDecision() {
    if (!canApply) return
    setApplying(true)
    setErr(null)
    setMessage(null)
    // Snapshot prior values for every selected row BEFORE the patch lands so we
    // can revert if the user clicks Undo on the success toast.
    const patchKeys = Object.keys(patch)
    const affectedRows = selectedRows.map((row) => ({
      id: row.id,
      revert: buildRevertPatch(row, patchKeys),
    }))
    const appliedCount = selectedIds.size
    try {
      // Resolve the chosen category path → id so the patch uses categoryOverrideId
      // (id-authoritative write path from C1). Fall back to null when no category set.
      let categoryOverrideId: number | null = null
      const trimmedCategory = category.trim()
      if (trimmedCategory) {
        const resolved = await resolveCategoryPath(trimmedCategory)
        categoryOverrideId = resolved.id
      }
      const actualPatch = buildReviewBulkPatch({
        category,
        categoryOverrideId,
        business,
        splitType,
        taxTreatment,
        markReviewed: true,
      })
      await postJson('/api/transactions/bulk-patch', {
        ids: selectedIdsList,
        patch: actualPatch,
      })
      setMessage(`Reviewed ${appliedCount} transaction(s).`)
      setCategory('')
      setBusiness('')
      setSplitType('')
      setTaxTreatment('')
      await load()

      // Per-row PATCH reverts are required: bulk-patch applies one patch to
      // every id, but each row needs its own prior values restored.
      const revert = async () => {
        try {
          await Promise.all(
            affectedRows.map((row) =>
              patchJson(`/api/transactions/${row.id}`, row.revert)
            )
          )
          await load()
          showToast({ title: 'Reverted', durationMs: 4000 })
        } catch (revertError) {
          setErr(
            revertError instanceof Error
              ? revertError.message
              : 'Could not revert review decision'
          )
        }
      }

      showToast({
        title: `Marked ${appliedCount} reviewed`,
        variant: 'success',
        durationMs: 10000,
        action: { label: 'Undo', onClick: () => void revert() },
      })
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'Could not apply review decision')
    } finally {
      setApplying(false)
    }
  }

  async function createRuleAndApply() {
    if (!canCreateRule) return
    setApplying(true)
    setErr(null)
    setMessage(null)
    try {
      const created = await postJson<RuleResponse>('/api/rules', {
        merchantPattern: selectedSummary.commonMerchant,
        matchKind: 'substring',
        priority: 50,
        category: category.trim(),
        isBusiness: business === 'true',
        splitType: splitType || 'me',
      })
      await postJson('/api/transactions/bulk-patch', {
        ids: selectedIdsList,
        patch,
      })
      setMessage(
        `Created rule #${created.id} and reviewed ${selectedIds.size} transaction(s).`
      )
      setCategory('')
      setBusiness('')
      setSplitType('')
      setTaxTreatment('')
      await load()
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'Could not create rule')
    } finally {
      setApplying(false)
    }
  }

  async function handleReceiptFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || receiptTargetTxnId == null) return
    // Reset the input so the same file can be re-picked if needed
    e.target.value = ''
    const txnId = receiptTargetTxnId
    setLastAnalyzedTxnId(txnId)
    await attachAndAnalyze(file, txnId)
  }

  return (
    <div className="page reviewInboxPage">
      {/* Hidden file input shared across all rows for camera/photo capture */}
      <input
        ref={receiptInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        className="hidden"
        data-testid="receipt-file-input"
        onChange={(e) => void handleReceiptFileChange(e)}
      />
      <PageHeader
        title="Review Inbox"
        description="Clear imported transactions by selecting similar rows and applying one decision."
        actions={
          <Button type="button" variant="secondary" onClick={() => void load()}>
            <RefreshCw aria-hidden="true" />
            Refresh
          </Button>
        }
      />

      <Grid
        aria-label="Review progress"
        role="group"
        minItemWidth={160}
        gap="md"
        className="mb-4"
      >
        <StatCard
          label="Unreviewed"
          value={summary.unreviewed}
          hint={`${total} open in the full inbox`}
        />
        <StatCard
          label="Loaded"
          value={summary.total}
          hint={`Showing first ${PAGE_SIZE}`}
        />
        <StatCard
          label="Selected"
          value={selectedSummary.count}
          hint={formatMoney(
            selectedSummary.absoluteSpend,
            selectedSummary.currency ?? 'CAD'
          )}
        />
      </Grid>

      <section className="grid gap-4 [grid-template-columns:minmax(0,_1fr)_minmax(280px,_360px)] max-[720px]:[grid-template-columns:1fr]">
        <Card className="mb-0">
          <div className="mb-3 flex flex-wrap items-end gap-3">
            <Label className="min-w-[220px]">
              <Search aria-hidden="true" className="mr-1 inline size-4" />
              Merchant
              <Input
                value={merchantFilter}
                onChange={(e) => setMerchantFilter(e.target.value)}
                placeholder="Filter merchants"
              />
            </Label>
            <Label>
              Batch
              <NativeSelect
                value={batchFilter}
                onChange={(e) => setBatchFilter(e.target.value)}
                style={{
                  borderColor: 'color-mix(in srgb, var(--border) 86%, var(--zinc-50) 6%)',
                  background: 'color-mix(in srgb, var(--card) 94%, transparent)',
                }}
              >
                <NativeSelectOption value="">All batches</NativeSelectOption>
                {uniqueBatches.map((batch) => (
                  <NativeSelectOption key={batch} value={batch}>
                    {batch}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Label>
            <div className="flex flex-wrap gap-2">
              {summary.batches.slice(0, 4).map((batch) => (
                <Badge key={batch.name} variant="outline">
                  {batch.name}: {batch.unreviewed}
                </Badge>
              ))}
            </div>
            <div className="relative">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  showShortcutsHelp()
                  if (showShortcutHint) {
                    setShowShortcutHint(false)
                    try { localStorage.setItem('seenReviewInboxShortcuts', 'true') } catch { /* ignore */ }
                  }
                }}
                aria-label="Show keyboard shortcuts"
                title="Keyboard shortcuts (press ?)"
              >
                <Keyboard aria-hidden="true" />
                Shortcuts
              </Button>
              {showShortcutHint && (
                <span className="pointer-events-none absolute -top-7 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-foreground px-2 py-0.5 text-xs text-background">
                  Press ? anytime for keyboard shortcuts
                </span>
              )}
            </div>
          </div>

          {/* Import-confidence flag chips (#214). Selecting a chip narrows the
              inbox to rows whose import_confidence_flags include that token.
              Clicking the active chip clears the filter. URL-bound so deep
              links from the dashboard survive a refresh. */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-semibold text-muted-foreground">
              Filter:
            </span>
            {CONFIDENCE_FLAG_CHIPS.map((chip) => {
              const active = confidenceFlag === chip.token
              return (
                <Button
                  key={chip.token}
                  type="button"
                  variant={active ? 'default' : 'outline'}
                  size="sm"
                  onClick={() =>
                    setConfidenceFlag(active ? null : chip.token)
                  }
                  className={
                    active
                      ? 'rounded-full px-2.5 py-0.5 text-xs font-semibold'
                      : 'rounded-full px-2.5 py-0.5 text-xs font-medium text-muted-foreground hover:text-foreground'
                  }
                  aria-pressed={active}
                  data-testid={`confidence-chip-${chip.token}`}
                >
                  {chip.label}
                </Button>
              )
            })}
            {confidenceFlag ? (
              <Button
                type="button"
                variant="link"
                size="sm"
                onClick={() => setConfidenceFlag(null)}
                className="text-xs text-muted-foreground"
              >
                Clear
              </Button>
            ) : null}
          </div>

          <p className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--muted-foreground)]" aria-hidden="true">
            <KbdKey>j</KbdKey>/<KbdKey>k</KbdKey> navigate · <KbdKey>space</KbdKey> select ·{' '}
            <KbdKey>c</KbdKey> category · <KbdKey>Enter</KbdKey> apply · <KbdKey>?</KbdKey> help
          </p>

          {err && <Alert variant="error">{err}</Alert>}
          {message && (
            <span
              className="mb-3 inline-flex rounded-lg border px-3 py-2 text-sm font-semibold"
              style={{
                borderColor: 'color-mix(in srgb, var(--positive) 45%, var(--border))',
                background: 'color-mix(in srgb, var(--positive) 10%, transparent)',
                color: 'var(--positive)',
              }}
            >
              {message}
            </span>
          )}

          <div
            className="overflow-auto rounded-lg border"
            style={{
              maxHeight: '70vh',
              borderColor: 'color-mix(in srgb, var(--border) 86%, var(--zinc-50) 6%)',
            }}
            ref={tableWrapRef}
          >
            <Table
              stickyHeader
              className="[&_thead_th]:bg-[color-mix(in_srgb,var(--muted)_88%,transparent)] [&_tr[data-cursor='true']]:shadow-[inset_4px_0_0_0_var(--primary)] [&_tr[data-cursor='true']]:bg-[color-mix(in_oklch,var(--primary)_10%,transparent)]"
            >
              <TableHeader>
                <TableRow>
                  <TableHead className="w-9 text-center">
                    <input
                      type="checkbox"
                      checked={
                        visibleRows.length > 0 &&
                        visibleRows.every((row) => selectedIds.has(row.id))
                      }
                      onChange={toggleAllVisible}
                      aria-label="Select all visible transactions"
                    />
                  </TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Merchant</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Split</TableHead>
                  <TableHead>Business</TableHead>
                  <TableHead>Batch</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleRows.map((row) => {
                  const isCursor = row.id === cursorRowId
                  const isExpanded = expandedIds.has(row.id)
                  const txnItems = itemsByTxn.get(row.id)
                  const sortedItems = txnItems
                    ? [
                        ...txnItems.filter(isItemStraggler),
                        ...txnItems.filter((it) => !isItemStraggler(it)),
                      ]
                    : null
                  return (
                  <React.Fragment key={row.id}>
                  <TableRow
                    data-row-id={row.id}
                    data-cursor={isCursor ? 'true' : undefined}
                    data-state={selectedIds.has(row.id) ? 'selected' : undefined}
                    aria-current={isCursor ? 'true' : undefined}
                  >
                    <TableCell>
                      <input
                        type="checkbox"
                        checked={selectedIds.has(row.id)}
                        onChange={() => toggleSelected(row.id)}
                        aria-label={`Select ${row.merchantClean}`}
                      />
                    </TableCell>
                    <TableCell>{row.date}</TableCell>
                    <TableCell>
                      <span className="txnMerchantCell">
                        <span className="txnMerchantName">{row.merchantClean}</span>
                        {row.appliedRuleId ? (
                          <span className="text-xs text-[var(--muted-foreground)]">Rule #{row.appliedRuleId}</span>
                        ) : (
                          <span className="text-xs text-[var(--muted-foreground)]">No rule</span>
                        )}
                        <Button
                          type="button"
                          variant="link"
                          size="sm"
                          className="p-0 text-xs text-[var(--muted-foreground)] underline hover:text-[var(--primary)] focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:outline-offset-2"
                          onClick={() => setSignalsDialogTxnId(row.id)}
                        >
                          Why?
                        </Button>
                        {row.itemized != null ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            aria-label={`${row.itemized.itemCount} items${row.itemized.stragglerCount > 0 ? `, ${row.itemized.stragglerCount} need review` : ''}`}
                            aria-expanded={isExpanded}
                            onClick={() => void toggleExpanded(row.id)}
                            className="text-xs font-medium text-muted-foreground hover:text-foreground"
                          >
                            <span>🧾 {row.itemized.itemCount} items</span>
                            {row.itemized.stragglerCount > 0 && (
                              <span className="text-warning">
                                {' · '}
                                {row.itemized.stragglerCount} need review
                              </span>
                            )}
                          </Button>
                        ) : busyTxnId === row.id ? (
                          <span className="text-xs text-muted-foreground italic">Analyzing…</span>
                        ) : (
                          <>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              aria-label="Add receipt"
                              onClick={() => {
                                setReceiptTargetTxnId(row.id)
                                receiptInputRef.current?.click()
                              }}
                              className="text-xs font-medium text-muted-foreground hover:text-foreground"
                            >
                              📷 Add receipt
                            </Button>
                            {lastAnalyzedTxnId === row.id && lastItemCount === 0 && attachErr == null && (
                              <span className="text-xs text-warning">
                                {"Couldn't read items — try another photo."}
                              </span>
                            )}
                          </>
                        )}
                      </span>
                    </TableCell>
                    <TableCell>{formatMoney(row.amount, row.currency)}</TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1.5">
                        <CategoryIcon name={row.finalCategory} />
                        {row.finalCategory ?? 'Uncategorized'}
                      </span>
                    </TableCell>
                    <TableCell>{row.finalSplitType}</TableCell>
                    <TableCell>{row.finalBusiness ? 'Yes' : 'No'}</TableCell>
                    <TableCell>{row.importBatch}</TableCell>
                  </TableRow>
                  {isExpanded && (
                    <TableRow>
                      <TableCell colSpan={8} className="p-0">
                        <div className="px-4 py-2">
                          {sortedItems == null ? (
                            <p className="text-xs text-muted-foreground">Loading items…</p>
                          ) : sortedItems.length === 0 ? (
                            <p className="text-xs text-muted-foreground">No items found.</p>
                          ) : (
                            <Table>
                              <TableHeader>
                                <TableRow className="text-xs text-muted-foreground">
                                  <TableHead className="h-auto px-0 pb-1 font-medium normal-case">Item</TableHead>
                                  <TableHead className="h-auto px-0 pb-1 font-medium normal-case">Qty</TableHead>
                                  <TableHead className="h-auto px-0 pb-1 font-medium normal-case">Total</TableHead>
                                  <TableHead className="h-auto px-0 pb-1 font-medium normal-case">Category</TableHead>
                                  <TableHead className="h-auto px-0 pb-1 font-medium normal-case">Business %</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {sortedItems.map((item) => (
                                  <ItemRow
                                    key={item.id}
                                    item={item}
                                    categoryHints={categoryHints.map((h) => h.label)}
                                    currency={row.currency}
                                    onSaved={() => void load()}
                                  />
                                ))}
                              </TableBody>
                            </Table>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                  </React.Fragment>
                  )
                })}
                {!loading && visibleRows.length === 0 && (
                  <EmptyTableRow
                    colSpan={8}
                    title="No transactions need review."
                    description="Adjust filters or import a new statement to populate the inbox."
                  />
                )}
                {loading &&
                  visibleRows.length === 0 &&
                  Array.from({ length: 6 }).map((_, i) => (
                    <SkeletonRow key={`review-skeleton-${i}`} cols={8} />
                  ))}
              </TableBody>
            </Table>
          </div>
        </Card>

        <Card className="mb-0 bg-[var(--card)] max-[720px]:order-[-1]">
          <SectionHeader
            title="Decision"
            description={
              selectedSummary.commonMerchant
                ? selectedSummary.commonMerchant
                : 'Select matching rows to create a rule.'
            }
            actions={
              <Badge variant={selectedSummary.count ? 'default' : 'outline'}>
                <ListChecks aria-hidden="true" />
                {selectedSummary.count}
              </Badge>
            }
          />

          <div className="grid gap-3">
            <Label>
              Category
              <div ref={categoryPickerRef}>
                <CategoryCloudPicker
                  value={category}
                  onChange={(value) => setCategory(value)}
                  options={categoryPaths.length > 0 ? categoryPaths : categoryHints.map((hint) => hint.label)}
                  placeholder="Dining, Transport..."
                />
              </div>
            </Label>
            <Label>
              Split
              <NativeSelect
                value={splitType}
                onChange={(e) => setSplitType(e.target.value)}
                style={{
                  borderColor: 'color-mix(in srgb, var(--border) 86%, var(--zinc-50) 6%)',
                  background: 'color-mix(in srgb, var(--card) 94%, transparent)',
                }}
              >
                <NativeSelectOption value="">Keep current</NativeSelectOption>
                <NativeSelectOption value="me">Me</NativeSelectOption>
                <NativeSelectOption value="partner">Partner</NativeSelectOption>
                <NativeSelectOption value="shared">Shared</NativeSelectOption>
              </NativeSelect>
            </Label>
            <Label>
              Business
              <NativeSelect
                value={business}
                onChange={(e) => setBusiness(e.target.value)}
                style={{
                  borderColor: 'color-mix(in srgb, var(--border) 86%, var(--zinc-50) 6%)',
                  background: 'color-mix(in srgb, var(--card) 94%, transparent)',
                }}
              >
                <NativeSelectOption value="">Keep current</NativeSelectOption>
                <NativeSelectOption value="false">Personal</NativeSelectOption>
                <NativeSelectOption value="true">Business</NativeSelectOption>
              </NativeSelect>
            </Label>
            <Label>
              Tax treatment
              <TaxTreatmentSelect
                value={taxTreatment || null}
                options={TAX_TREATMENTS.filter((tt) => tt !== 'none')}
                emptyLabel="Keep current"
                onChange={(t) => setTaxTreatment(t ?? '')}
                className="min-h-9 rounded-md border px-3 text-sm"
                style={{
                  borderColor: 'color-mix(in srgb, var(--border) 86%, var(--zinc-50) 6%)',
                  background: 'color-mix(in srgb, var(--card) 94%, transparent)',
                  color: 'var(--foreground)',
                }}
              />
            </Label>
          </div>

          <div
            className="my-4 grid gap-3"
            style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))' }}
          >
            {([
              { value: selectedSummary.count, label: 'selected' },
              { value: formatMoney(selectedSummary.absoluteSpend, selectedSummary.currency ?? 'CAD'), label: 'absolute spend' },
              { value: selectedRows.filter((row) => !row.appliedRuleId).length, label: 'without rules' },
            ] as { value: React.ReactNode; label: string }[]).map(({ value: val, label }) => (
              <div
                key={label}
                className="rounded-lg border p-3"
                style={{
                  borderColor: 'color-mix(in srgb, var(--border) 86%, var(--zinc-50) 6%)',
                  background: 'color-mix(in srgb, var(--muted) 46%, transparent)',
                }}
              >
                <strong className="block">{val}</strong>
                <span className="mt-1 block text-xs text-[var(--muted-foreground)]">{label}</span>
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-2">
            <Button
              type="button"
              disabled={!canApply || applying}
              onClick={() => void applyDecision()}
            >
              <Check aria-hidden="true" />
              Apply and mark reviewed
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={!canCreateRule || !canApply || applying}
              onClick={() => void createRuleAndApply()}
            >
              <Wand2 aria-hidden="true" />
              Create rule and apply
            </Button>
          </div>

          <div
            className="mt-4 flex gap-2 rounded-lg border px-3 py-2 text-xs leading-5 text-[var(--muted-foreground)]"
            style={{
              borderColor: 'color-mix(in srgb, var(--primary) 18%, var(--border))',
              background: 'color-mix(in srgb, var(--muted) 42%, transparent)',
            }}
          >
            <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>
              This only updates selected rows. Rule creation is available when all
              selected rows share one merchant.
            </span>
          </div>
        </Card>
      </section>
      <EnrichmentSignalsDialog
        transactionId={signalsDialogTxnId}
        transactionSummary={
          signalsDialogTxnId == null
            ? null
            : (() => {
                const row = rows.find((r) => r.id === signalsDialogTxnId)
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
          setRows((prev) => prev.map((r) => (r.id === updated.id ? { ...r, ...updated } : r)))
        }}
      />
    </div>
  )
}
