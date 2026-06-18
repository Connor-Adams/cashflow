# Subcategories — Plan C2c: rollup rendering + full-path display + review tagging

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render B2's per-currency category rollup tree in the Dashboard, show full category paths on transactions, and let the Review inbox tag transactions to child categories.

**Architecture:** Add `RollupRow` to `shared/api-types.ts` (B2 already returns `categoryTree` untyped) and expose `categoryOverrideId`/`finalCategoryId` on the shared `Transaction` DTO. A new presentational `CategoryRollupTree` builds a parent→children tree from the flat `RollupRow[]` and renders collapsible rows with rolled totals, filtered to the active currency; it mounts additively in the Dashboard beside `TopGrowersTile`. `TransactionsPage` derives a category's full path from its id via a tree-backed `pathById` map for display + picker seeding. `ReviewInboxPage` resolves a chosen path → id and bulk-patches `categoryOverrideId` (the backend `bulk-patch` already routes through `applyPatchBody`, which C1 taught to accept `categoryOverrideId`).

**Tech Stack:** React 19 + Tailwind v4 + vitest/testing-library; one shared-types touch. No new dependency.

## Global Constraints

- Worktree root: `/Users/connoradams/Developer/cashflow/.claude/worktrees/subcategories-plan-c2c` (frontend deps via the `frontend/node_modules` symlink; `@cashflow/shared` + `.bin` symlinked).
- Frontend tests: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn workspace frontend run test src/<path>.test.tsx`. Build: `... run build`; lint: `... run lint`. Shared-type test via `tsx --test`. Backend integration via `cd backend && PATH=...:$PATH yarn run test:integration` (Postgres up).
- Mock API in tests via `vi.spyOn(api, ...)`; `@testing-library/user-event`; reset relevant caches in `beforeEach`.
- Frontend imports DTO types from `../types/api`, never `@cashflow/shared` directly in components.
- Builds on merged A/B1/B2/C1 + C2a + C2b (on this branch): `categoriesApi.getCategoryTree`, `flattenTreeToPaths`; `Transaction` model has `categoryOverrideId`/`finalCategoryId` columns (B1); the transactions list route returns full model rows; `/dashboard` + `/monthly` responses already include `categoryTree: RollupRow[]` (B2); `bulk-patch` applies `categoryOverrideId` via `applyPatchBody` (C1).
- `RollupRow` MUST match `backend/src/categories/rollup.ts` exactly: `{ categoryId: number; currency: string; name: string; path: string; parentId: number | null; depth: number; directTotal: number; rolledTotal: number }`.
- Commits: NO co-author trailers. Stage only each task's files (never `git add -A`, never `yarn.lock`). Prefix commit with `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH`.

---

### Task 1: shared `RollupRow` + expose txn category ids

**Files:**
- Modify: `shared/api-types.ts` (add `RollupRow`; add 2 fields to `Transaction`)
- Modify: `frontend/src/types/api.ts` (re-export `RollupRow`)
- Test: `shared/rollupRow.types.test.ts`

**Interfaces:**
- Produces: `RollupRow` (exact shape above) exported from `@cashflow/shared` + re-exported from `../types/api`; `Transaction` gains `categoryOverrideId: number | null` and `finalCategoryId: number | null`.

- [ ] **Step 1: Write the failing test**

```ts
// shared/rollupRow.types.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RollupRow, Transaction } from './api-types';

test('RollupRow has the rollup shape', () => {
  const r: RollupRow = { categoryId: 1, currency: 'CAD', name: 'Work', path: 'Work', parentId: null, depth: 0, directTotal: 0, rolledTotal: 10 };
  assert.equal(r.rolledTotal, 10);
});

test('Transaction exposes category ids', () => {
  const ids: Pick<Transaction, 'categoryOverrideId' | 'finalCategoryId'> = { categoryOverrideId: 3, finalCategoryId: 3 };
  assert.equal(ids.finalCategoryId, 3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/connoradams/Developer/cashflow/.claude/worktrees/subcategories-plan-c2c && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH tsx --test shared/rollupRow.types.test.ts`
Expected: FAIL — `RollupRow` not exported / `Transaction` lacks the id fields.

- [ ] **Step 3: Write minimal implementation**

In `shared/api-types.ts`:
1. Add near `CategoryTreeNode`:
```ts
export type RollupRow = {
  categoryId: number;
  currency: string;
  name: string;
  path: string;
  parentId: number | null;
  depth: number;
  directTotal: number;
  rolledTotal: number;
};
```
2. In the `Transaction` type, beside `autoCategory`/`categoryOverride`/`finalCategory`, add:
```ts
  categoryOverrideId: number | null
  finalCategoryId: number | null
```
In `frontend/src/types/api.ts`, add `RollupRow,` to the `export type { ... } from '@cashflow/shared'` list.

> Verify the transactions list route serializes the ids: read `backend/src/routes/transactions.ts` GET list handler — if it uses an explicit `attributes:` array, add `'categoryOverrideId'` and `'finalCategoryId'`; if it returns full model rows (no attributes list), the columns already serialize. Confirm by reading; adjust only if an explicit attributes list excludes them.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/connoradams/Developer/cashflow/.claude/worktrees/subcategories-plan-c2c && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH tsx --test shared/rollupRow.types.test.ts`
Expected: PASS. Then `PATH=...:$PATH yarn workspace frontend run build` (tsc) clean and `yarn workspace cashflow-backend run typecheck` clean.

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add shared/api-types.ts frontend/src/types/api.ts shared/rollupRow.types.test.ts && \
git commit -m "feat(categories): shared RollupRow type + expose txn category ids"
```
> If the transactions route needed an attributes change, stage `backend/src/routes/transactions.ts` too and mention it in the report.

---

### Task 2: `CategoryRollupTree` component

**Files:**
- Create: `frontend/src/components/CategoryRollupTree.tsx`
- Test: `frontend/src/components/CategoryRollupTree.test.tsx`

**Interfaces:**
- Consumes: `RollupRow` from `../types/api`.
- Produces: `<CategoryRollupTree rows={RollupRow[]} currency={string} />` — filters `rows` to `currency`, builds a parent→children map by `parentId`, renders root rows showing `name` + `rolledTotal`; each row with children has a disclosure toggle (default collapsed) that reveals child rows (indented by `depth`). Amounts shown via a passed-in or simple formatter. Empty/absent → renders nothing (or a muted "No category spend").

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/CategoryRollupTree.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CategoryRollupTree } from './CategoryRollupTree';
import type { RollupRow } from '../types/api';

const rows: RollupRow[] = [
  { categoryId: 1, currency: 'CAD', name: 'Work', path: 'Work', parentId: null, depth: 0, directTotal: 50, rolledTotal: 80 },
  { categoryId: 2, currency: 'CAD', name: 'Internet', path: 'Work / Internet', parentId: 1, depth: 1, directTotal: 30, rolledTotal: 30 },
  { categoryId: 9, currency: 'USD', name: 'Other', path: 'Other', parentId: null, depth: 0, directTotal: 5, rolledTotal: 5 },
];

describe('CategoryRollupTree', () => {
  it('renders roots for the active currency with rolled totals; child hidden until expanded', async () => {
    render(<CategoryRollupTree rows={rows} currency="CAD" />);
    expect(screen.getByText('Work')).toBeInTheDocument();
    expect(screen.queryByText('Internet')).not.toBeInTheDocument(); // collapsed
    expect(screen.queryByText('Other')).not.toBeInTheDocument();    // wrong currency
    await userEvent.click(screen.getByRole('button', { name: /expand Work/i }));
    expect(screen.getByText('Internet')).toBeInTheDocument();
  });

  it('renders nothing meaningful when no rows for the currency', () => {
    const { container } = render(<CategoryRollupTree rows={rows} currency="GBP" />);
    expect(container.textContent).not.toContain('Work');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn workspace frontend run test src/components/CategoryRollupTree.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```tsx
// frontend/src/components/CategoryRollupTree.tsx
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { RollupRow } from '../types/api';

type Props = { rows: RollupRow[]; currency: string };

function format(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function CategoryRollupTree({ rows, currency }: Props) {
  const { roots, childrenByParent, byId } = useMemo(() => {
    const scoped = rows.filter((r) => r.currency === currency);
    const childrenByParent = new Map<number, RollupRow[]>();
    const byId = new Map<number, RollupRow>();
    for (const r of scoped) byId.set(r.categoryId, r);
    const roots: RollupRow[] = [];
    for (const r of scoped) {
      if (r.parentId != null && byId.has(r.parentId)) {
        const list = childrenByParent.get(r.parentId) ?? [];
        list.push(r);
        childrenByParent.set(r.parentId, list);
      } else {
        roots.push(r);
      }
    }
    const cmp = (a: RollupRow, b: RollupRow) => b.rolledTotal - a.rolledTotal;
    roots.sort(cmp);
    for (const list of childrenByParent.values()) list.sort(cmp);
    return { roots, childrenByParent, byId };
  }, [rows, currency]);

  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  if (roots.length === 0) return <p className="muted">No category spend</p>;

  const renderRow = (r: RollupRow) => {
    const kids = childrenByParent.get(r.categoryId) ?? [];
    const isOpen = expanded.has(r.categoryId);
    return (
      <li key={r.categoryId}>
        <div className="flex items-center gap-2 py-1" style={{ paddingLeft: r.depth * 16 }}>
          {kids.length > 0 ? (
            <Button
              type="button" variant="ghost" size="sm"
              aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${r.name}`}
              aria-expanded={isOpen}
              onClick={() => setExpanded((prev) => { const next = new Set(prev); if (next.has(r.categoryId)) next.delete(r.categoryId); else next.add(r.categoryId); return next; })}
            >{isOpen ? '▾' : '▸'}</Button>
          ) : <span className="inline-block w-6" />}
          <span className="flex-1">{r.name}</span>
          <span className="tabular-nums">{format(r.rolledTotal)}</span>
        </div>
        {isOpen && kids.length > 0 && <ul>{kids.map(renderRow)}</ul>}
      </li>
    );
  };

  return <ul className="flex flex-col">{roots.map(renderRow)}</ul>;
}
```
> `byId` is used to decide root-vs-child (a row whose `parentId` is not in the scoped set is treated as a root — matches the backend, which includes ancestor rows). Keep it.

- [ ] **Step 4: Run test to verify it passes**

Run: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn workspace frontend run test src/components/CategoryRollupTree.test.tsx`
Expected: PASS (2 tests). Then build (tsc) + lint clean.

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add frontend/src/components/CategoryRollupTree.tsx frontend/src/components/CategoryRollupTree.test.tsx && \
git commit -m "feat(categories): CategoryRollupTree collapsible rollup component"
```

---

### Task 3: render the rollup in the Dashboard

**Files:**
- Modify: `frontend/src/pages/DashboardPage.tsx` (local `DashResp` type ~146-155; the breakdown render area near the `TopGrowersTile` ~1385)
- Test: `frontend/src/pages/DashboardCategoryRollup.test.tsx`

**Interfaces:**
- Consumes: `CategoryRollupTree` (Task 2), `RollupRow` (Task 1).
- Produces: `DashResp` gains `categoryTree?: RollupRow[]`; the Dashboard renders a `<CategoryRollupTree rows={data?.categoryTree ?? []} currency={displayCurrency} />` in a new section beside `TopGrowersTile`. `TopGrowersTile` is unchanged.

- [ ] **Step 1: Write the failing test**

Because `DashboardPage` is large, extract the section into a tiny wrapper and test THAT, OR test that `CategoryRollupTree` receives the response's `categoryTree`. Simplest: a focused render test of the new section component. Add a small exported `DashboardCategorySection`:

```tsx
// frontend/src/pages/DashboardCategoryRollup.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DashboardCategorySection } from './DashboardCategorySection';
import type { RollupRow } from '../types/api';

const rows: RollupRow[] = [
  { categoryId: 1, currency: 'CAD', name: 'Work', path: 'Work', parentId: null, depth: 0, directTotal: 50, rolledTotal: 80 },
];

describe('DashboardCategorySection', () => {
  it('renders the rollup tree for the active currency', () => {
    render(<DashboardCategorySection categoryTree={rows} currency="CAD" />);
    expect(screen.getByText('Work')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn workspace frontend run test src/pages/DashboardCategoryRollup.test.tsx`
Expected: FAIL — `DashboardCategorySection` not found.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/pages/DashboardCategorySection.tsx`:
```tsx
import { Card } from '@/components/ui/card';
import { CategoryRollupTree } from '../components/CategoryRollupTree';
import type { RollupRow } from '../types/api';

export function DashboardCategorySection({ categoryTree, currency }: { categoryTree: RollupRow[]; currency: string }) {
  return (
    <Card className="dashboardTile">
      <h3>Categories</h3>
      <p className="muted">Spending rolled up by category. Expand a parent to see subcategories.</p>
      <CategoryRollupTree rows={categoryTree} currency={currency} />
    </Card>
  );
}
```
In `DashboardPage.tsx`: add `categoryTree?: RollupRow[]` to the local `DashResp` type (import `RollupRow` from `../types/api`), and render `<DashboardCategorySection categoryTree={data?.categoryTree ?? []} currency={displayCurrency} />` adjacent to the `TopGrowersTile` (same grid/section). Leave `TopGrowersTile` untouched.

- [ ] **Step 4: Run test to verify it passes**

Run: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn workspace frontend run test src/pages/DashboardCategoryRollup.test.tsx`
Expected: PASS. Then build (tsc) + lint clean; run existing DashboardPage tests (`yarn workspace frontend run test DashboardPage`) → no regression.

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add frontend/src/pages/DashboardPage.tsx frontend/src/pages/DashboardCategorySection.tsx frontend/src/pages/DashboardCategoryRollup.test.tsx && \
git commit -m "feat(categories): render category rollup tree in the Dashboard"
```

---

### Task 4: full category-path display in Transactions

**Files:**
- Create: `frontend/src/lib/categoryPathById.ts` (helper)
- Modify: `frontend/src/pages/TransactionsPage.tsx` (row `cat` seed ~1989; display ~2168)
- Test: `frontend/src/lib/categoryPathById.test.ts`

**Interfaces:**
- Consumes: `flattenTreeToPaths` is path-only; here we need id→path. Add `buildPathById(nodes: CategoryTreeNode[]): Map<number, string>` to a new helper (depth-first, ' / ' separator, keyed by node id). Consumed by `TransactionsPage` to seed/display the path.
- Produces: `buildPathById`; the Transactions row seeds `cat` from `pathById.get(t.categoryOverrideId ?? t.finalCategoryId ?? -1) ?? (t.categoryOverride ?? '')` and the display uses the same path.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/lib/categoryPathById.test.ts
import { describe, it, expect } from 'vitest';
import { buildPathById } from './categoryPathById';
import type { CategoryTreeNode } from '../types/api';

const tree: CategoryTreeNode[] = [
  { id: 1, name: 'Work', parentId: null, icon: null, taxTreatment: 'none', children: [
    { id: 2, name: 'Internet', parentId: 1, icon: null, taxTreatment: 'none', children: [] },
  ]},
];

describe('buildPathById', () => {
  it('maps node id to full path', () => {
    const m = buildPathById(tree);
    expect(m.get(1)).toBe('Work');
    expect(m.get(2)).toBe('Work / Internet');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn workspace frontend run test src/lib/categoryPathById.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// frontend/src/lib/categoryPathById.ts
import { CATEGORY_PATH_SEPARATOR } from './categoriesApi';
import type { CategoryTreeNode } from '../types/api';

/** Map each category node id → its full path (e.g. "Work / Internet"). */
export function buildPathById(nodes: CategoryTreeNode[]): Map<number, string> {
  const out = new Map<number, string>();
  const walk = (node: CategoryTreeNode, prefix: string) => {
    const path = prefix ? `${prefix}${CATEGORY_PATH_SEPARATOR}${node.name}` : node.name;
    out.set(node.id, path);
    for (const child of node.children) walk(child, path);
  };
  for (const root of nodes) walk(root, '');
  return out;
}
```
In `TransactionsPage.tsx`: build a `pathById` once (load the tree via `getCategoryTree` in a small `useState`/effect or reuse a tree the page already loads; if none, add one). Seed the row `cat` from `pathById.get(t.categoryOverrideId ?? t.finalCategoryId ?? -1) ?? (t.categoryOverride ?? '')`, and use the same value for the displayed category text. Keep the `categoryFieldChanged`/`resolveCategoryPatch` save path from C2a unchanged (now the baseline is the path, so re-saving an unchanged row is correctly a no-op).

> The picker `options` already come from `useCategoryPaths().paths` (full paths, C2a). Seeding `cat` from the path makes the baseline consistent with the options.

- [ ] **Step 4: Run test to verify it passes**

Run: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn workspace frontend run test src/lib/categoryPathById.test.ts`
Expected: PASS. Then build (tsc) + lint clean; run existing TransactionsPage tests + the C2a `TransactionsCategoryTag` test → no regression.

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add frontend/src/lib/categoryPathById.ts frontend/src/lib/categoryPathById.test.ts frontend/src/pages/TransactionsPage.tsx && \
git commit -m "feat(categories): show full category path on transactions (id-derived)"
```

---

### Task 5: ReviewInbox child tagging

**Files:**
- Modify: `frontend/src/lib/reviewInbox.ts` (`buildReviewBulkPatch` ~76-88), `frontend/src/pages/ReviewInboxPage.tsx` (category control + apply)
- Test: `frontend/src/lib/reviewInbox.test.ts` (extend)

**Interfaces:**
- Consumes: `resolveCategoryPath` (categoriesApi), `useCategoryPaths` (C2a).
- Produces: `buildReviewBulkPatch` accepts a resolved `categoryOverrideId: number | null` instead of (or in addition to) the `category` string, and emits `{ categoryOverrideId }` into the bulk patch when set (the backend `bulk-patch` → `applyPatchBody` already handles it). `ReviewInboxPage`'s category control uses the full-path picker options; on apply it resolves the chosen path → id and passes that id to the patch builder.

- [ ] **Step 1: Write the failing test**

```ts
// add to frontend/src/lib/reviewInbox.test.ts
import { buildReviewBulkPatch } from './reviewInbox';

it('emits categoryOverrideId when a resolved id is provided', () => {
  const patch = buildReviewBulkPatch({ category: '', categoryOverrideId: 7, business: '', splitType: '', taxTreatment: '', markReviewed: true });
  expect(patch.categoryOverrideId).toBe(7);
  expect('categoryOverride' in patch).toBe(false);
});

it('omits category fields when neither string nor id set', () => {
  const patch = buildReviewBulkPatch({ category: '', categoryOverrideId: null, business: '', splitType: '', taxTreatment: '', markReviewed: true });
  expect('categoryOverrideId' in patch).toBe(false);
  expect('categoryOverride' in patch).toBe(false);
});
```
(Keep the existing string-path tests passing.)

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn workspace frontend run test src/lib/reviewInbox.test.ts`
Expected: FAIL — `categoryOverrideId` not in the input type / not emitted.

- [ ] **Step 3: Write minimal implementation**

In `frontend/src/lib/reviewInbox.ts`, extend `ReviewBulkPatchInput` with `categoryOverrideId?: number | null` and update `buildReviewBulkPatch`: when `categoryOverrideId != null`, set `patch.categoryOverrideId = input.categoryOverrideId` (and do NOT also set the `categoryOverride` string); else keep the existing `if (category) patch.categoryOverride = category` behavior. Everything else unchanged.

In `ReviewInboxPage.tsx`: change the category control's options to `useCategoryPaths().paths` (full paths), and in the apply handler resolve the chosen category path → id via `resolveCategoryPath(category)` (when `category` is set), then call `buildReviewBulkPatch({ ..., categoryOverrideId: resolved?.id ?? null })`. When the category field is empty, pass `categoryOverrideId: null` and don't resolve. (Read the page for the exact apply flow; keep business/split/tax/markReviewed handling intact.)

- [ ] **Step 4: Run test to verify it passes**

Run: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn workspace frontend run test src/lib/reviewInbox.test.ts`
Expected: PASS (existing + 2 new). Then build (tsc) + lint clean; run existing ReviewInbox tests → no regression.

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add frontend/src/lib/reviewInbox.ts frontend/src/pages/ReviewInboxPage.tsx frontend/src/lib/reviewInbox.test.ts && \
git commit -m "feat(categories): ReviewInbox tags children via categoryOverrideId"
```

---

## Final verification

- [ ] Full frontend suite green: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn workspace frontend run test`.
- [ ] Backend typecheck + the existing transaction integration tests still pass (the txn DTO id exposure + any route attribute change): `yarn workspace cashflow-backend run typecheck`; if a route attribute changed, run `cd backend && PATH=...:$PATH yarn run test:integration --test-name-pattern 'transactions'`.
- [ ] Frontend build (tsc) + lint clean.
- [ ] Manual sanity (optional): Dashboard shows a "Categories" rollup (expand a parent → children + rolled totals); a child-tagged transaction shows its full path; tagging a child in the Review inbox sticks.

## Feature complete after C2c

This closes the subcategories feature: A (tree) → B1 (id plumbing) → B2 (rollup) → C1 (id-authoritative write path + rename) → C2a (picker child tagging) → C2b (manager) → C2c (rollup rendering + path display + review tagging).
Remaining nice-to-haves (not blocking, can be tracked separately): AI suggestion accept-time path creation; DnD drop-target highlight + keyboard-accessible reparent in the manager; surfaced error on category-tree load failure.
