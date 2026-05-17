import type { Transaction } from '../types/api'

export type ReviewInboxSummary = {
  total: number
  reviewed: number
  unreviewed: number
  batches: Array<{ name: string; total: number; unreviewed: number }>
}

export type SelectedReviewSummary = {
  count: number
  absoluteSpend: number
  currency: string | null
  commonMerchant: string | null
}

export type ReviewBulkPatchInput = {
  category: string
  business: string
  splitType: string
  markReviewed: boolean
}

export function getReviewInboxSummary(rows: Transaction[]): ReviewInboxSummary {
  const batches = new Map<string, { name: string; total: number; unreviewed: number }>()
  let reviewed = 0
  let unreviewed = 0

  for (const row of rows) {
    if (row.reviewFlag) {
      unreviewed += 1
    } else {
      reviewed += 1
    }

    const batch = row.importBatch || 'Unbatched'
    const current = batches.get(batch) ?? { name: batch, total: 0, unreviewed: 0 }
    current.total += 1
    if (row.reviewFlag) current.unreviewed += 1
    batches.set(batch, current)
  }

  return {
    total: rows.length,
    reviewed,
    unreviewed,
    batches: Array.from(batches.values()),
  }
}

export function getSelectedReviewSummary(
  rows: Transaction[],
  selectedIds: Set<number>
): SelectedReviewSummary {
  const selected = rows.filter((row) => selectedIds.has(row.id))
  const first = selected[0]
  const commonMerchant =
    first && selected.every((row) => row.merchantClean === first.merchantClean)
      ? first.merchantClean
      : null
  const currency =
    first && selected.every((row) => row.currency === first.currency)
      ? first.currency
      : null

  return {
    count: selected.length,
    absoluteSpend: selected.reduce((sum, row) => sum + Math.abs(row.amount), 0),
    currency,
    commonMerchant,
  }
}

export function buildReviewBulkPatch(input: ReviewBulkPatchInput): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  const category = input.category.trim()

  if (category) patch.categoryOverride = category
  if (input.business === 'true') patch.businessOverride = true
  if (input.business === 'false') patch.businessOverride = false
  if (input.splitType) patch.splitOverride = input.splitType
  if (input.markReviewed) patch.reviewFlag = false

  return patch
}
