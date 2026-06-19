import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type {
  MerchantCluster,
  MerchantClustersResponse,
  MerchantBulkRecategorizeResponse,
  MerchantMergeResponse,
} from '@cashflow/shared'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/ui/page-header'
import { useConfirm } from '@/components/ui/dialog'
import { EmptyTableRow } from '@/components/ui/empty-state'
import { useToast } from '@/components/ui/toast'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { CategoryCloudPicker } from '../components/CategoryCloudPicker'
import { getJson, postJson } from '../lib/api'
import { formatCurrency } from '../lib/formatCurrency'

type CategoryHint = { label: string; usageCount: number }

const EMPTY_HEADLINE = 'No merchants to clean up yet'
const EMPTY_BODY =
  'Once you import transactions, your merchants will be grouped here so you can rename, merge, and categorize them in bulk.'
const ERROR_FALLBACK =
  "We couldn't load your merchants. Check your connection and try again."

type RowCallbacks = {
  selected: boolean
  renaming: boolean
  renameValue: string
  pendingCategory: string
  categoryLabels: string[]
  onToggleSelect: () => void
  onStartRename: () => void
  onRenameChange: (v: string) => void
  onSubmitRename: () => void
  onCancelRename: () => void
  onCategoryChange: (v: string) => void
  onApplyCategory: () => void
  onCreateRule: () => void
}

/** A single cluster row. Split out to keep the page component flat. */
function ClusterRow({
  cluster,
  cb,
}: {
  cluster: MerchantCluster
  cb: RowCallbacks
}) {
  const mixed = cluster.categorySpread.length > 1
  const label = cluster.canonical ?? cluster.merchantClean
  return (
    <TableRow>
      <TableCell>
        <input
          type="checkbox"
          aria-label={`Select ${cluster.merchantClean}`}
          checked={cb.selected}
          onChange={cb.onToggleSelect}
        />
      </TableCell>
      <TableCell>
        {cb.renaming ? (
          <div className="flex items-center gap-2">
            <Input
              autoFocus
              value={cb.renameValue}
              aria-label={`Rename ${cluster.merchantClean}`}
              onChange={(e) => cb.onRenameChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') cb.onSubmitRename()
                if (e.key === 'Escape') cb.onCancelRename()
              }}
            />
            <Button size="sm" onClick={cb.onSubmitRename}>
              Save
            </Button>
            <Button size="sm" variant="outline" onClick={cb.onCancelRename}>
              Cancel
            </Button>
          </div>
        ) : (
          <button
            type="button"
            className="text-left hover:underline"
            title="Rename canonical merchant"
            onClick={cb.onStartRename}
          >
            <span className="font-medium">{label}</span>
            {cluster.sampleDescriptions.length > 0 ? (
              <span className="block text-xs text-muted-foreground">
                {cluster.sampleDescriptions.join(' · ')}
              </span>
            ) : null}
          </button>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">{cluster.count}</TableCell>
      <TableCell className="text-right tabular-nums">
        {formatCurrency(Number(cluster.totalSpend), cluster.currency)}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <span>{cluster.dominantCategory ?? '—'}</span>
          {mixed ? (
            <Badge
              variant="secondary"
              title={cluster.categorySpread
                .map((s) => `${s.category ?? 'Uncategorized'} (${s.count})`)
                .join(', ')}
            >
              mixed +{cluster.categorySpread.length - 1}
            </Badge>
          ) : null}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <CategoryCloudPicker
            value={cb.pendingCategory}
            options={cb.categoryLabels}
            placeholder="Category"
            onChange={cb.onCategoryChange}
          />
          <Button size="sm" onClick={cb.onApplyCategory}>
            Apply category
          </Button>
          <Button size="sm" variant="outline" onClick={cb.onCreateRule}>
            Create rule
          </Button>
        </div>
      </TableCell>
    </TableRow>
  )
}

/**
 * Bulk merchant-cleanup review surface (issue #793). Lists every merchant
 * cluster (a derived GROUP BY merchant_clean view) sorted by total spend,
 * with inline rename, multi-select merge, per-cluster bulk recategorize, and
 * a one-click "Create rule" action. No new primitive — reads a derived view
 * and bulk-mutates the Transaction (and Rule) primitives.
 */
export function MerchantCleanupPage() {
  const [clusters, setClusters] = useState<MerchantCluster[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [categoryHints, setCategoryHints] = useState<CategoryHint[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [pendingCategory, setPendingCategory] = useState<Record<string, string>>({})

  const confirm = useConfirm()
  const { showToast } = useToast()

  const categoryLabels = useMemo(
    () => categoryHints.map((h) => h.label),
    [categoryHints],
  )
  const currency = clusters[0]?.currency ?? 'CAD'

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await getJson<MerchantClustersResponse>('/api/merchants/clusters')
      setClusters(data.clusters ?? [])
      setSelected(new Set())
    } catch (e) {
      setError(e instanceof Error ? e.message : ERROR_FALLBACK)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    void getJson<{ categories: CategoryHint[] }>('/api/transactions/category-hints')
      .then((d) => setCategoryHints(d.categories ?? []))
      .catch(() => setCategoryHints([]))
  }, [])

  const toggleSelect = useCallback((merchantClean: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(merchantClean)) next.delete(merchantClean)
      else next.add(merchantClean)
      return next
    })
  }, [])

  const applyCategory = useCallback(
    async (cluster: MerchantCluster, createRule: boolean) => {
      const category = (
        pendingCategory[cluster.merchantClean] ??
        cluster.dominantCategory ??
        ''
      ).trim()
      if (!category) {
        showToast({ title: 'Pick a category first', variant: 'warning' })
        return
      }
      if (cluster.categorySpread.length > 1) {
        const ok = await confirm({
          title: 'Apply category',
          description: `This overwrites the category on all ${cluster.count} transactions in "${cluster.merchantClean}".`,
          confirmLabel: 'Apply category',
        })
        if (!ok) return
      }
      try {
        const res = await postJson<MerchantBulkRecategorizeResponse>(
          '/api/merchants/bulk-recategorize',
          { merchantClean: cluster.merchantClean, category, createRule },
        )
        const name = cluster.canonical ?? cluster.merchantClean
        showToast({
          title: createRule
            ? `Recategorized ${res.recategorized} transactions and created a rule for ${name}`
            : `Recategorized ${res.recategorized} transactions under ${name}`,
          variant: 'success',
        })
        await load()
      } catch (e) {
        showToast({
          title: e instanceof Error ? e.message : 'Could not apply category',
          variant: 'destructive',
        })
      }
    },
    [pendingCategory, confirm, showToast, load],
  )

  const submitRename = useCallback(
    async (cluster: MerchantCluster) => {
      const canonicalName = renameValue.trim()
      if (!canonicalName) {
        setRenaming(null)
        return
      }
      try {
        const res = await postJson<MerchantMergeResponse>('/api/merchants/merge', {
          survivorMerchantClean: cluster.merchantClean,
          mergeMerchantCleans: [],
          canonicalName,
        })
        showToast({ title: `Renamed to ${res.survivor}`, variant: 'success' })
        setRenaming(null)
        setRenameValue('')
        await load()
      } catch (e) {
        showToast({
          title: e instanceof Error ? e.message : 'Could not rename',
          variant: 'destructive',
        })
      }
    },
    [renameValue, showToast, load],
  )

  const mergeSelected = useCallback(async () => {
    const cleans = Array.from(selected)
    if (cleans.length < 2) {
      showToast({ title: 'Select at least two merchants to merge', variant: 'warning' })
      return
    }
    const picked = clusters.filter((c) => selected.has(c.merchantClean))
    // Survivor = the selected cluster with the most spend (first in sort order).
    const survivor = picked[0]
    const mergeCleans = cleans.filter((c) => c !== survivor.merchantClean)
    const affected = picked.reduce((sum, c) => sum + c.count, 0)
    const canonicalName = survivor.canonical ?? survivor.merchantClean
    // v1 does not rewrite existing rules; warn if a selected cluster has one.
    const hasRuleWarning = picked.some((c) => c.canonical != null)

    const baseCopy = `This reassigns ${affected} transactions to the new canonical merchant and can't be undone in bulk.`
    const ok = await confirm({
      title: `Merge ${cleans.length} merchants into "${canonicalName}"?`,
      description: hasRuleWarning
        ? `${baseCopy} Existing rules still match their old patterns and will not be rewritten.`
        : baseCopy,
      confirmLabel: 'Merge merchants',
      destructive: true,
    })
    if (!ok) return

    try {
      const res = await postJson<MerchantMergeResponse>('/api/merchants/merge', {
        survivorMerchantClean: survivor.merchantClean,
        mergeMerchantCleans: mergeCleans,
        canonicalName,
      })
      showToast({
        title: `Merged ${cleans.length} merchants — ${res.reassigned} transactions reassigned to ${res.survivor}`,
        variant: 'success',
      })
      await load()
    } catch (e) {
      showToast({
        title: e instanceof Error ? e.message : 'Could not merge merchants',
        variant: 'destructive',
      })
    }
  }, [selected, clusters, confirm, showToast, load])

  const showEmpty = !loading && !error && clusters.length === 0

  return (
    <div>
      {confirm.dialog}
      <PageHeader
        title="Merchant cleanup"
        description="Group, rename, merge, and bulk-categorize your merchants."
        actions={
          selected.size >= 2 ? (
            <Button variant="outline" onClick={() => void mergeSelected()}>
              Merge selected ({selected.size})
            </Button>
          ) : undefined
        }
      />

      {error ? (
        <Alert
          variant="error"
          title={ERROR_FALLBACK}
          action={
            <Button variant="outline" onClick={() => void load()}>
              Retry
            </Button>
          }
        >
          {error}
        </Alert>
      ) : null}

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>Merchant</TableHead>
              <TableHead className="text-right">Transactions</TableHead>
              <TableHead className="text-right">Total spend</TableHead>
              <TableHead>Category</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <TableRow key={`skeleton-${i}`} data-testid="cluster-skeleton">
                  <TableCell colSpan={6}>
                    <div className="h-5 w-full animate-pulse rounded bg-muted" />
                  </TableCell>
                </TableRow>
              ))
            ) : showEmpty ? (
              <EmptyTableRow
                colSpan={6}
                title={EMPTY_HEADLINE}
                description={
                  <>
                    {EMPTY_BODY} <Link to="/import">Import transactions</Link>.
                  </>
                }
              />
            ) : (
              clusters.map((cluster) => (
                <ClusterRow
                  key={cluster.merchantClean}
                  cluster={cluster}
                  cb={{
                    selected: selected.has(cluster.merchantClean),
                    renaming: renaming === cluster.merchantClean,
                    renameValue,
                    pendingCategory:
                      pendingCategory[cluster.merchantClean] ??
                      cluster.dominantCategory ??
                      '',
                    categoryLabels,
                    onToggleSelect: () => toggleSelect(cluster.merchantClean),
                    onStartRename: () => {
                      setRenaming(cluster.merchantClean)
                      setRenameValue(cluster.canonical ?? cluster.merchantClean)
                    },
                    onRenameChange: setRenameValue,
                    onSubmitRename: () => void submitRename(cluster),
                    onCancelRename: () => setRenaming(null),
                    onCategoryChange: (v) =>
                      setPendingCategory((prev) => ({
                        ...prev,
                        [cluster.merchantClean]: v,
                      })),
                    onApplyCategory: () => void applyCategory(cluster, false),
                    onCreateRule: () => void applyCategory(cluster, true),
                  }}
                />
              ))
            )}
          </TableBody>
        </Table>
      </Card>
      {!loading && !error && clusters.length > 0 ? (
        <p className="muted mt-2 text-sm">
          Showing {clusters.length} merchants in {currency}. Select two or more to merge.
        </p>
      ) : null}
    </div>
  )
}
