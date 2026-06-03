# Receipts Ledger Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the `/receipts` list into a dense, aligned ledger with a per-receipt financial breakdown and category roll-up — frontend-only, no backend change.

**Architecture:** Extract the data shape and two pure derivation helpers (`summarizeOrders`, `rollUpCategories`) into a unit-tested `receiptDerivations.ts`. Rewrite `ReceiptsList.tsx` to consume them: a fixed CSS-grid row layout, a status dot, and an expansion panel with three blocks (items / breakdown / category roll-up) plus a summary bar. All fields already arrive via `GET /api/external-orders`.

**Tech Stack:** React + TypeScript, Tailwind v4, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-06-01-receipts-ledger-redesign-design.md`

---

## File Structure

- **Create** `frontend/src/components/receipts/receiptDerivations.ts` — data types (`ReceiptItem`, `ReceiptOrder`, `ReceiptLinkStatus`) + pure functions (`summarizeOrders`, `rollUpCategories`). No React.
- **Create** `frontend/src/components/receipts/receiptDerivations.test.ts` — unit tests for the pure functions.
- **Modify** `frontend/src/components/receipts/ReceiptsList.tsx` — import types/helpers from the new module; rewrite render.
- **Modify** `frontend/src/components/receipts/ReceiptsList.test.tsx` — add breakdown / status-dot / category / summary coverage.

Run all commands from the `frontend/` directory.

---

## Task 1: Pure derivation module

**Files:**
- Create: `frontend/src/components/receipts/receiptDerivations.ts`
- Test: `frontend/src/components/receipts/receiptDerivations.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/components/receipts/receiptDerivations.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  summarizeOrders,
  rollUpCategories,
  type ReceiptOrder,
  type ReceiptItem,
} from './receiptDerivations'

function order(partial: Partial<ReceiptOrder>): ReceiptOrder {
  return {
    id: 1,
    vendor: 'costco',
    source: null,
    orderDate: '2026-02-13',
    subtotal: null,
    tax: null,
    shipping: null,
    total: null,
    currency: 'CAD',
    paymentLast4: null,
    linkStatus: 'orphan',
    items: [],
    ...partial,
  }
}

function item(partial: Partial<ReceiptItem>): ReceiptItem {
  return { id: 1, title: 'x', quantity: 1, unitPrice: null, totalPrice: null, inferredCategory: null, ...partial }
}

describe('summarizeOrders', () => {
  it('counts orders and orphans, and sums total and tax skipping nulls', () => {
    const s = summarizeOrders([
      order({ id: 1, linkStatus: 'orphan', total: '562.33', tax: '23.17' }),
      order({ id: 2, linkStatus: 'linked', total: '582.64', tax: '27.00' }),
      order({ id: 3, linkStatus: 'linked', total: null, tax: null }),
    ])
    expect(s.count).toBe(3)
    expect(s.orphanCount).toBe(1)
    expect(s.totalSum).toBeCloseTo(1144.97, 2)
    expect(s.taxSum).toBeCloseTo(50.17, 2)
  })

  it('returns zeroes for an empty list', () => {
    expect(summarizeOrders([])).toEqual({ count: 0, orphanCount: 0, totalSum: 0, taxSum: 0 })
  })
})

describe('rollUpCategories', () => {
  it('groups by inferredCategory, sums positive totals, sorts descending', () => {
    const cats = rollUpCategories([
      item({ id: 1, inferredCategory: 'Groceries', totalPrice: '10.00' }),
      item({ id: 2, inferredCategory: 'Alcohol', totalPrice: '30.00' }),
      item({ id: 3, inferredCategory: 'Groceries', totalPrice: '5.00' }),
    ])
    expect(cats).toEqual([
      { category: 'Alcohol', total: 30 },
      { category: 'Groceries', total: 15 },
    ])
  })

  it('ignores items with no category, null price, or non-positive price', () => {
    const cats = rollUpCategories([
      item({ id: 1, inferredCategory: null, totalPrice: '10.00' }),
      item({ id: 2, inferredCategory: 'Groceries', totalPrice: null }),
      item({ id: 3, inferredCategory: 'Discounts', totalPrice: '-2.00' }),
      item({ id: 4, inferredCategory: 'Groceries', totalPrice: '8.00' }),
    ])
    expect(cats).toEqual([{ category: 'Groceries', total: 8 }])
  })

  it('caps at 5 categories and folds the rest into "Other"', () => {
    const cats = rollUpCategories([
      item({ id: 1, inferredCategory: 'A', totalPrice: '60' }),
      item({ id: 2, inferredCategory: 'B', totalPrice: '50' }),
      item({ id: 3, inferredCategory: 'C', totalPrice: '40' }),
      item({ id: 4, inferredCategory: 'D', totalPrice: '30' }),
      item({ id: 5, inferredCategory: 'E', totalPrice: '20' }),
      item({ id: 6, inferredCategory: 'F', totalPrice: '5' }),
      item({ id: 7, inferredCategory: 'G', totalPrice: '3' }),
    ])
    expect(cats).toHaveLength(6)
    expect(cats[5]).toEqual({ category: 'Other', total: 8 })
  })

  it('returns an empty array when nothing is categorized', () => {
    expect(rollUpCategories([item({ inferredCategory: null, totalPrice: '10' })])).toEqual([])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn vitest run src/components/receipts/receiptDerivations.test.ts`
Expected: FAIL — `Failed to resolve import "./receiptDerivations"`.

- [ ] **Step 3: Write the module**

Create `frontend/src/components/receipts/receiptDerivations.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn vitest run src/components/receipts/receiptDerivations.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/receipts/receiptDerivations.ts frontend/src/components/receipts/receiptDerivations.test.ts
git commit -m "feat(receipts): add pure summary + category-rollup derivations"
```

---

## Task 2: Restyle ReceiptsList into the ledger

**Files:**
- Modify: `frontend/src/components/receipts/ReceiptsList.tsx` (full rewrite of the file)
- Test: `frontend/src/components/receipts/ReceiptsList.test.tsx`

- [ ] **Step 1: Write the failing tests**

Replace the contents of `frontend/src/components/receipts/ReceiptsList.test.tsx` with:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { ReceiptsList } from './ReceiptsList'

vi.mock('@/lib/api', () => ({
  getJson: vi.fn(),
}))
import { getJson } from '@/lib/api'

const FULL_ORDER = {
  id: 1,
  vendor: 'costco',
  source: 'costco_till_receipt.pdf',
  orderDate: '2026-02-13',
  subtotal: '555.64',
  tax: '27.00',
  shipping: null,
  total: '582.64',
  currency: 'CAD',
  paymentLast4: '4021',
  linkStatus: 'linked',
  items: [
    { id: 5, title: 'LEGO 10374', quantity: 1, unitPrice: null, totalPrice: '59.99', inferredCategory: 'Toys' },
    { id: 6, title: 'Campo Viejo', quantity: 2, unitPrice: null, totalPrice: '31.98', inferredCategory: 'Alcohol' },
  ],
}

describe('ReceiptsList', () => {
  beforeEach(() => {
    vi.mocked(getJson).mockReset()
  })

  it('fetches with the group param and renders order rows with link status', async () => {
    vi.mocked(getJson).mockResolvedValue([FULL_ORDER])
    render(<ReceiptsList group="gmail" />)
    await waitFor(() => expect(screen.getByText('costco')).toBeInTheDocument())
    expect(getJson).toHaveBeenCalledWith('/api/external-orders?group=gmail')
    expect(screen.getByText(/linked/i)).toBeInTheDocument()
  })

  it('shows an empty state when there are no receipts', async () => {
    vi.mocked(getJson).mockResolvedValue([])
    render(<ReceiptsList group="all" />)
    await waitFor(() => expect(screen.getByText(/no receipts/i)).toBeInTheDocument())
  })

  it('renders the financial breakdown for present fields', async () => {
    vi.mocked(getJson).mockResolvedValue([FULL_ORDER])
    render(<ReceiptsList group="other" />)
    // 'Breakdown' / 'Subtotal' are unique to the panel; 'Tax'/'Total' are NOT
    // (they also label the collapsed-row columns), so assert via unique strings.
    await waitFor(() => expect(screen.getByText('Breakdown')).toBeInTheDocument())
    expect(screen.getByText('Subtotal')).toBeInTheDocument()
    expect(screen.getByText('CA$555.64')).toBeInTheDocument()
    expect(screen.getAllByText('CA$582.64').length).toBeGreaterThan(0)
    expect(screen.getByText(/4021/)).toBeInTheDocument()
  })

  it('hides breakdown lines whose values are null', async () => {
    vi.mocked(getJson).mockResolvedValue([
      { ...FULL_ORDER, subtotal: null, tax: null, shipping: null, paymentLast4: null },
    ])
    render(<ReceiptsList group="other" />)
    await waitFor(() => expect(screen.getByText('costco')).toBeInTheDocument())
    // 'Subtotal'/'Shipping' are panel-only labels; 'Tax' also heads a column, so
    // prove tax is hidden via its (now absent) value instead of the word.
    expect(screen.queryByText('Subtotal')).not.toBeInTheDocument()
    expect(screen.queryByText('Shipping')).not.toBeInTheDocument()
    expect(screen.queryByText('CA$27.00')).not.toBeInTheDocument()
    expect(screen.queryByText(/paid with/i)).not.toBeInTheDocument()
  })

  it('renders the category roll-up when items have categories, and omits it otherwise', async () => {
    vi.mocked(getJson).mockResolvedValue([FULL_ORDER])
    const { unmount } = render(<ReceiptsList group="other" />)
    await waitFor(() => expect(screen.getByText(/where it went/i)).toBeInTheDocument())
    expect(screen.getByText('Toys')).toBeInTheDocument()
    expect(screen.getByText('Alcohol')).toBeInTheDocument()
    unmount()

    vi.mocked(getJson).mockResolvedValue([
      {
        ...FULL_ORDER,
        items: [{ id: 9, title: 'mystery', quantity: 1, unitPrice: null, totalPrice: '5.00', inferredCategory: null }],
      },
    ])
    render(<ReceiptsList group="other" />)
    await waitFor(() => expect(screen.getByText('mystery')).toBeInTheDocument())
    expect(screen.queryByText(/where it went/i)).not.toBeInTheDocument()
  })

  it('renders a summary bar with orphan count shown only when there are orphans', async () => {
    vi.mocked(getJson).mockResolvedValue([
      FULL_ORDER,
      { ...FULL_ORDER, id: 2, linkStatus: 'orphan', total: '100.00', tax: null },
    ])
    const { unmount } = render(<ReceiptsList group="all" />)
    await waitFor(() => expect(screen.getByText('receipts')).toBeInTheDocument())
    expect(screen.getByText('orphan')).toBeInTheDocument()
    unmount()

    vi.mocked(getJson).mockResolvedValue([FULL_ORDER])
    render(<ReceiptsList group="all" />)
    await waitFor(() => expect(screen.getByText('receipts')).toBeInTheDocument())
    expect(screen.queryByText('orphan')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn vitest run src/components/receipts/ReceiptsList.test.tsx`
Expected: FAIL — new assertions (`Subtotal`, `where it went`, `receipts`) not found; old component still renders the flex layout.

- [ ] **Step 3: Rewrite the component**

Replace the entire contents of `frontend/src/components/receipts/ReceiptsList.tsx` with:

```tsx
import { useEffect, useState } from 'react'
import { getJson } from '@/lib/api'
import { EmptyState } from '@/components/ui/empty-state'
import { formatMoney } from '@/lib/formatMoney'
import {
  summarizeOrders,
  rollUpCategories,
  type ReceiptOrder,
  type ReceiptLinkStatus,
} from './receiptDerivations'

export type ReceiptGroup = 'all' | 'gmail' | 'amazon' | 'other'

const LINK_LABEL: Record<ReceiptLinkStatus, string> = {
  linked: 'Linked',
  needs_match: 'Needs match',
  orphan: 'Orphan',
}

const LINK_COLOR: Record<ReceiptLinkStatus, string> = {
  linked: 'var(--positive)',
  needs_match: 'var(--primary)',
  orphan: 'var(--warning)',
}

// Distinct swatches for the per-receipt category roll-up bar (cycled if needed).
const CAT_COLORS = [
  'var(--primary)',
  'var(--positive)',
  'var(--warning)',
  '#7E9CD8',
  'var(--muted-foreground)',
  'var(--border)',
]

// Single source of truth for the column template so header + every row align.
const ROW_GRID = 'grid grid-cols-[1.6fr_0.7fr_1fr_1fr_auto_1rem] items-center gap-3'

export function ReceiptsList({ group }: { group: ReceiptGroup }) {
  const [orders, setOrders] = useState<ReceiptOrder[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setOrders(null)
    setError(null)
    void (async () => {
      try {
        const data = await getJson<ReceiptOrder[]>(`/api/external-orders?group=${group}`)
        if (!cancelled) setOrders(data)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load receipts')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [group])

  if (error) {
    return (
      <p className="error text-sm" role="alert">
        {error}
      </p>
    )
  }
  if (orders === null) {
    return <p className="muted text-sm">Loading receipts…</p>
  }
  if (orders.length === 0) {
    return (
      <EmptyState
        title="No receipts yet"
        description="Connect Gmail and run a scan, or import an order report, to see receipts here."
      />
    )
  }

  const summary = summarizeOrders(orders)
  const currency = orders[0].currency

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-[var(--muted-foreground)]">
        <span>
          <strong className="text-[var(--foreground)]">{summary.count}</strong> receipts
        </span>
        {summary.orphanCount > 0 ? (
          <>
            <span aria-hidden>·</span>
            <span>
              <strong style={{ color: 'var(--warning)' }}>{summary.orphanCount}</strong> orphan
            </span>
          </>
        ) : null}
        <span aria-hidden>·</span>
        <span className="tabular-nums">
          <strong className="text-[var(--foreground)]">{formatMoney(summary.totalSum, currency)}</strong> total
        </span>
        {summary.taxSum > 0 ? (
          <>
            <span aria-hidden>·</span>
            <span className="tabular-nums">
              <strong className="text-[var(--foreground)]">{formatMoney(summary.taxSum, currency)}</strong> tax
            </span>
          </>
        ) : null}
      </div>

      <div className={`${ROW_GRID} px-3 text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]`}>
        <span>Vendor</span>
        <span>Date</span>
        <span className="text-right">Tax</span>
        <span className="text-right">Total</span>
        <span className="sr-only">Status</span>
        <span aria-hidden />
      </div>

      <ul className="flex flex-col gap-1">
        {orders.map((o) => {
          const cats = rollUpCategories(o.items ?? [])
          const catTotal = cats.reduce((sum, c) => sum + c.total, 0)
          const items = o.items ?? []
          return (
            <li key={o.id}>
              <details className="group rounded-md border border-border">
                <summary className={`${ROW_GRID} cursor-pointer list-none px-3 py-2 [&::-webkit-details-marker]:hidden`}>
                  <span className="truncate font-medium">{o.vendor}</span>
                  <span className="muted text-sm tabular-nums">{o.orderDate ?? '—'}</span>
                  <span className="muted text-right text-sm tabular-nums">
                    {o.tax != null ? formatMoney(Number(o.tax), o.currency) : ''}
                  </span>
                  <span className="text-right tabular-nums">
                    {o.total != null ? formatMoney(Number(o.total), o.currency) : '—'}
                  </span>
                  <span className="flex justify-center">
                    <span
                      className="inline-block h-2 w-2 rounded-full"
                      style={{ background: LINK_COLOR[o.linkStatus] }}
                      title={LINK_LABEL[o.linkStatus]}
                    />
                    <span className="sr-only">{LINK_LABEL[o.linkStatus]}</span>
                  </span>
                  <span className="text-[var(--muted-foreground)] transition-transform group-open:rotate-90">›</span>
                </summary>

                <div className="flex flex-col gap-3 border-t border-border bg-[var(--card)] p-3 sm:flex-row sm:gap-6">
                  <div className="min-w-0 flex-1">
                    <p className="mb-1 text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]">
                      {items.length} items
                    </p>
                    <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto pr-1 text-sm">
                      {items.map((it) => (
                        <li key={it.id} className="flex justify-between gap-2">
                          <span className="truncate">
                            {it.title}
                            {it.quantity > 1 ? ` ×${it.quantity}` : ''}
                          </span>
                          <span
                            className="muted tabular-nums"
                            style={
                              it.totalPrice != null && Number(it.totalPrice) < 0
                                ? { color: 'var(--warning)' }
                                : undefined
                            }
                          >
                            {it.totalPrice != null ? formatMoney(Number(it.totalPrice), o.currency) : '—'}
                          </span>
                        </li>
                      ))}
                      {items.length === 0 ? <li className="muted">No line items</li> : null}
                    </ul>
                  </div>

                  <div className="sm:w-56">
                    <p className="mb-1 text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]">Breakdown</p>
                    <dl className="text-sm">
                      {o.subtotal != null ? (
                        <div className="flex justify-between gap-2 py-0.5 text-[var(--muted-foreground)]">
                          <dt>Subtotal</dt>
                          <dd className="tabular-nums text-[var(--foreground)]">{formatMoney(Number(o.subtotal), o.currency)}</dd>
                        </div>
                      ) : null}
                      {o.tax != null ? (
                        <div className="flex justify-between gap-2 py-0.5 text-[var(--muted-foreground)]">
                          <dt>Tax</dt>
                          <dd className="tabular-nums text-[var(--foreground)]">{formatMoney(Number(o.tax), o.currency)}</dd>
                        </div>
                      ) : null}
                      {o.shipping != null ? (
                        <div className="flex justify-between gap-2 py-0.5 text-[var(--muted-foreground)]">
                          <dt>Shipping</dt>
                          <dd className="tabular-nums text-[var(--foreground)]">{formatMoney(Number(o.shipping), o.currency)}</dd>
                        </div>
                      ) : null}
                      <div className="mt-1 flex justify-between gap-2 border-t border-border pt-2 font-semibold">
                        <dt>Total</dt>
                        <dd className="tabular-nums">
                          {o.total != null ? formatMoney(Number(o.total), o.currency) : '—'}
                        </dd>
                      </div>
                    </dl>
                    {o.paymentLast4 ? (
                      <p className="mt-2 text-xs text-[var(--muted-foreground)]">
                        Paid with{' '}
                        <span className="rounded border border-border px-1.5 py-0.5 text-[var(--foreground)]">•••• {o.paymentLast4}</span>
                      </p>
                    ) : null}

                    {cats.length > 0 ? (
                      <div className="mt-3 border-t border-border pt-2">
                        <p className="mb-1.5 text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]">Where it went</p>
                        <div className="mb-2 flex h-2 overflow-hidden rounded">
                          {cats.map((c, i) => (
                            <span
                              key={c.category}
                              style={{ width: `${(c.total / catTotal) * 100}%`, background: CAT_COLORS[i % CAT_COLORS.length] }}
                            />
                          ))}
                        </div>
                        <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-[var(--muted-foreground)]">
                          {cats.map((c, i) => (
                            <li key={c.category} className="flex items-center gap-1.5">
                              <span
                                className="inline-block h-2 w-2 rounded-sm"
                                style={{ background: CAT_COLORS[i % CAT_COLORS.length] }}
                              />
                              {c.category}{' '}
                              <span className="tabular-nums text-[var(--foreground)]">{formatMoney(c.total, o.currency)}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                </div>
              </details>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn vitest run src/components/receipts/ReceiptsList.test.tsx`
Expected: PASS (6 tests).

- [ ] **Step 5: Lint**

Run: `yarn lint`
Expected: no errors in `receiptDerivations.ts` or `ReceiptsList.tsx`. (If `ReceiptOrder`/`ReceiptItem` are reported as unused anywhere they were previously declared, ensure the old inline type/`LINK_*` map blocks in `ReceiptsList.tsx` were fully replaced by the rewrite above.)

- [ ] **Step 6: Run the full receipts test directory to confirm no regressions**

Run: `yarn vitest run src/components/receipts`
Expected: PASS (all files).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/receipts/ReceiptsList.tsx frontend/src/components/receipts/ReceiptsList.test.tsx
git commit -m "feat(receipts): ledger layout with breakdown + category rollup"
```

---

## Self-Review

**Spec coverage:**
- Fixed-grid collapsed row (Vendor | Date | Tax | Total | dot | chevron) → Task 2 component + `ROW_GRID`.
- Status as colored dot w/ accessible label → Task 2 (`LINK_COLOR`/`LINK_LABEL`, `sr-only`).
- Scroll-capped items (`max-h-40 overflow-y-auto`) → Task 2.
- Breakdown Subtotal/Tax/Shipping (conditional) + Total + Paid-with → Task 2 + null-hiding test.
- Category roll-up from `inferredCategory`, top 5 + Other, omitted when none → Task 1 (`rollUpCategories`) + Task 2 render + test.
- Summary bar counts/sums → Task 1 (`summarizeOrders`) + Task 2 render + test.
- Widened types incl. subtotal/tax/shipping/paymentLast4 → Task 1 `ReceiptOrder`.
- Deposits/Discounts NOT aggregated into breakdown (resolved decision) → not implemented, by design. Status display-only (no actions) → no action handlers added.
- Nulls hide lines (not `—`), except Total/Date which keep `—` → matches spec.

**Placeholder scan:** none — all steps contain full code and exact commands.

**Type consistency:** `ReceiptOrder`, `ReceiptItem`, `ReceiptLinkStatus`, `summarizeOrders`, `rollUpCategories`, `OrdersSummary`, `CategoryTotal` defined in Task 1 and imported identically in Task 2 and both test files. `ReceiptGroup` stays exported from `ReceiptsList.tsx` (consumed by `ReceiptsPage.tsx`) — unchanged.
