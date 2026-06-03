export type ReceiptLinkStatus = 'linked' | 'needs_match' | 'orphan'

export type ReceiptItem = {
  id: number
  title: string
  quantity: number
  unitPrice: string | null
  totalPrice: string | null
  inferredCategory: string | null
}

export type ReceiptOrder = {
  id: number
  vendor: string
  source: string | null
  orderDate: string | null
  subtotal: string | null
  tax: string | null
  shipping: string | null
  total: string | null
  currency: string
  paymentLast4: string | null
  linkStatus: ReceiptLinkStatus
  items?: ReceiptItem[]
}

export type OrdersSummary = {
  count: number
  orphanCount: number
  totalSum: number
  taxSum: number
}

/** Aggregate counts and money sums for the list header. Null amounts are skipped. */
export function summarizeOrders(orders: ReceiptOrder[]): OrdersSummary {
  let orphanCount = 0
  let totalSum = 0
  let taxSum = 0
  for (const o of orders) {
    if (o.linkStatus === 'orphan') orphanCount++
    if (o.total != null) totalSum += Number(o.total)
    if (o.tax != null) taxSum += Number(o.tax)
  }
  return { count: orders.length, orphanCount, totalSum, taxSum }
}

export type CategoryTotal = { category: string; total: number }

const MAX_CATEGORIES = 5

/**
 * Sum a receipt's items by inferred category (positive line amounts only),
 * sorted descending. Beyond the top 5, the remainder folds into "Other".
 * Returns [] when no item carries a category.
 */
export function rollUpCategories(items: ReceiptItem[]): CategoryTotal[] {
  const sums = new Map<string, number>()
  for (const it of items) {
    if (!it.inferredCategory || it.totalPrice == null) continue
    const amount = Number(it.totalPrice)
    if (!Number.isFinite(amount) || amount <= 0) continue
    sums.set(it.inferredCategory, (sums.get(it.inferredCategory) ?? 0) + amount)
  }
  const sorted = [...sums.entries()]
    .map(([category, total]) => ({ category, total }))
    .sort((a, b) => b.total - a.total)
  if (sorted.length <= MAX_CATEGORIES) return sorted
  const top = sorted.slice(0, MAX_CATEGORIES)
  const rest = sorted.slice(MAX_CATEGORIES).reduce((sum, c) => sum + c.total, 0)
  return [...top, { category: 'Other', total: rest }]
}
