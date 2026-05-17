import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Check,
  ListChecks,
  RefreshCw,
  Search,
  ShieldCheck,
  Wand2,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyTableRow } from '@/components/ui/empty-state'
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
import { getJson, postJson } from '../lib/api'
import { formatMoney } from '../lib/formatMoney'
import {
  buildReviewBulkPatch,
  getReviewInboxSummary,
  getSelectedReviewSummary,
} from '../lib/reviewInbox'
import type { Paginated, Transaction } from '../types/api'

type CategoryHint = {
  label: string
  usageCount: number
}

type RuleResponse = {
  id: number
}

const PAGE_SIZE = 100

export function ReviewInboxPage() {
  const [rows, setRows] = useState<Transaction[]>([])
  const [total, setTotal] = useState(0)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set())
  const [categoryHints, setCategoryHints] = useState<CategoryHint[]>([])
  const [category, setCategory] = useState('')
  const [business, setBusiness] = useState('')
  const [splitType, setSplitType] = useState('')
  const [merchantFilter, setMerchantFilter] = useState('')
  const [batchFilter, setBatchFilter] = useState('')
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const qs = new URLSearchParams({
        reviewFlag: 'true',
        pageSize: String(PAGE_SIZE),
      })
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
  }, [])

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
        markReviewed: true,
      }),
    [business, category, splitType]
  )

  const canApply = selectedIds.size > 0 && Object.keys(patch).length > 0
  const canCreateRule =
    selectedSummary.commonMerchant != null && category.trim().length > 0

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

  async function applyDecision() {
    if (!canApply) return
    setApplying(true)
    setErr(null)
    setMessage(null)
    try {
      await postJson('/api/transactions/bulk-patch', {
        ids: selectedIdsList,
        patch,
      })
      setMessage(`Reviewed ${selectedIds.size} transaction(s).`)
      setCategory('')
      setBusiness('')
      setSplitType('')
      await load()
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
      await load()
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'Could not create rule')
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="page reviewInboxPage">
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

      <section className="reviewInboxStats" aria-label="Review progress">
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
      </section>

      <section className="reviewInboxLayout">
        <Card className="reviewInboxTableCard">
          <div className="reviewInboxToolbar">
            <Label>
              <Search aria-hidden="true" />
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
              >
                <NativeSelectOption value="">All batches</NativeSelectOption>
                {uniqueBatches.map((batch) => (
                  <NativeSelectOption key={batch} value={batch}>
                    {batch}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Label>
            <div className="reviewInboxBatchPills">
              {summary.batches.slice(0, 4).map((batch) => (
                <Badge key={batch.name} variant="outline">
                  {batch.name}: {batch.unreviewed}
                </Badge>
              ))}
            </div>
          </div>

          {err && <span className="error">{err}</span>}
          {message && <span className="reviewInboxMessage">{message}</span>}

          <div className="reviewInboxTableWrap">
            <Table className="reviewInboxTable">
              <TableHeader>
                <TableRow>
                  <TableHead className="narrowCol">
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
                {visibleRows.map((row) => (
                  <TableRow
                    key={row.id}
                    data-state={selectedIds.has(row.id) ? 'selected' : undefined}
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
                          <span className="reviewInboxHint">Rule #{row.appliedRuleId}</span>
                        ) : (
                          <span className="reviewInboxHint">No rule</span>
                        )}
                      </span>
                    </TableCell>
                    <TableCell>{formatMoney(row.amount, row.currency)}</TableCell>
                    <TableCell>{row.finalCategory ?? 'Uncategorized'}</TableCell>
                    <TableCell>{row.finalSplitType}</TableCell>
                    <TableCell>{row.finalBusiness ? 'Yes' : 'No'}</TableCell>
                    <TableCell>{row.importBatch}</TableCell>
                  </TableRow>
                ))}
                {!loading && visibleRows.length === 0 && (
                  <EmptyTableRow
                    colSpan={8}
                    title="No transactions need review."
                    description="Adjust filters or import a new statement to populate the inbox."
                  />
                )}
                {loading && (
                  <EmptyTableRow colSpan={8} title="Loading review inbox..." />
                )}
              </TableBody>
            </Table>
          </div>
        </Card>

        <Card className="reviewInboxDecisionCard">
          <div className="transactionsPanelHeader">
            <div>
              <h2>Decision</h2>
              <p className="muted">
                {selectedSummary.commonMerchant
                  ? selectedSummary.commonMerchant
                  : 'Select matching rows to create a rule.'}
              </p>
            </div>
            <Badge variant={selectedSummary.count ? 'default' : 'outline'}>
              <ListChecks aria-hidden="true" />
              {selectedSummary.count}
            </Badge>
          </div>

          <div className="reviewInboxDecisionFields">
            <Label>
              Category
              <Input
                list="review-category-hints"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="Dining, Transport..."
              />
              <datalist id="review-category-hints">
                {categoryHints.map((hint) => (
                  <option key={hint.label} value={hint.label} />
                ))}
              </datalist>
            </Label>
            <Label>
              Split
              <NativeSelect value={splitType} onChange={(e) => setSplitType(e.target.value)}>
                <NativeSelectOption value="">Keep current</NativeSelectOption>
                <NativeSelectOption value="me">Me</NativeSelectOption>
                <NativeSelectOption value="partner">Partner</NativeSelectOption>
                <NativeSelectOption value="shared">Shared</NativeSelectOption>
              </NativeSelect>
            </Label>
            <Label>
              Business
              <NativeSelect value={business} onChange={(e) => setBusiness(e.target.value)}>
                <NativeSelectOption value="">Keep current</NativeSelectOption>
                <NativeSelectOption value="false">Personal</NativeSelectOption>
                <NativeSelectOption value="true">Business</NativeSelectOption>
              </NativeSelect>
            </Label>
          </div>

          <div className="reviewInboxPreview">
            <div>
              <strong>{selectedSummary.count}</strong>
              <span>selected</span>
            </div>
            <div>
              <strong>
                {formatMoney(
                  selectedSummary.absoluteSpend,
                  selectedSummary.currency ?? 'CAD'
                )}
              </strong>
              <span>absolute spend</span>
            </div>
            <div>
              <strong>{selectedRows.filter((row) => !row.appliedRuleId).length}</strong>
              <span>without rules</span>
            </div>
          </div>

          <div className="reviewInboxActions">
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

          <div className="reviewInboxGuardrail">
            <ShieldCheck aria-hidden="true" />
            <span>
              This only updates selected rows. Rule creation is available when all
              selected rows share one merchant.
            </span>
          </div>
        </Card>
      </section>
    </div>
  )
}
