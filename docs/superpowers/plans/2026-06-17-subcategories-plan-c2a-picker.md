# Subcategories — Plan C2a: category picker path-syntax + child tagging

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user tag a transaction to a *child* category by picking or typing a full path (`Work / Expenses / Internet`) in the Transactions page — resolving the path to a node id and PATCHing `categoryOverrideId`.

**Architecture:** Add typed API helpers (`getCategoryTree`, `resolveCategoryPath`) and a `flattenTreeToPaths` util in a new `frontend/src/lib/categoriesApi.ts`; a `useCategoryPaths()` hook exposes the household's categories as full-path strings. The existing `CategoryCloudPicker` already takes a `string[]` of options and a string value — so it needs no change; the Transactions row passes full-path options and, on save, resolves the chosen path to an id via `POST /api/categories/resolve-path` and PATCHes `categoryOverrideId` (C1's id-authoritative hook derives the strings). A bare name (no `/`) still resolves/creates a root, preserving today's flat behavior.

**Tech Stack:** React 19 + Tailwind v4 + vitest/testing-library. No new dependency.

## Global Constraints

- Worktree root: `/Users/connoradams/Developer/cashflow/.claude/worktrees/subcategories-plan-c2` (no local install; `@cashflow/shared` + `.bin` symlinked into `node_modules`).
- **Frontend tests:** vitest + testing-library; run one file:
  `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn workspace frontend run test src/<path>.test.tsx` (vitest run mode; append `--run` if it watches).
- Frontend typecheck/lint: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn workspace frontend run build` (tsc) and `... run lint`.
- Mock API in tests via `vi.spyOn(api, 'getJson'|'postJson'|'patchJson')` — the established pattern (see `useCategories.test.tsx`, `CategoryIcon.test.tsx`).
- Frontend imports DTO types from `../types/api` (the `@cashflow/shared` barrel re-export), never `@cashflow/shared` directly in components.
- Builds on merged C1: `POST /api/categories/resolve-path` → `{ id, name, path, createdIds }`; `GET /api/categories/tree` → `CategoryNode[]`; transaction `PATCH` accepts `categoryOverrideId: number | null`.
- Backend `shared/api-types.ts` is the single source of DTO types imported by both sides as `@cashflow/shared`.
- Commits: NO co-author trailers. Stage only each task's files (never `git add -A`, never `yarn.lock`). Prefix commit with `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH`.

---

### Task 1: Shared DTO types for the tree + resolve-path

**Files:**
- Modify: `shared/api-types.ts`
- Modify: `frontend/src/types/api.ts` (re-export)
- Test: `shared/categoryTree.types.test.ts` (a compile-time type assertion test via `tsx`)

**Interfaces:**
- Produces (in `@cashflow/shared`):
  ```ts
  export type CategoryTreeNode = {
    id: number; name: string; parentId: number | null;
    icon: string | null; taxTreatment: TaxTreatment;
    children: CategoryTreeNode[];
  };
  export type ResolvedCategoryPath = { id: number; name: string | null; path: string; createdIds: number[] };
  ```
  Re-exported from `frontend/src/types/api.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// shared/categoryTree.types.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CategoryTreeNode, ResolvedCategoryPath } from './api-types';

test('CategoryTreeNode + ResolvedCategoryPath are usable, recursive shapes', () => {
  const node: CategoryTreeNode = {
    id: 1, name: 'Work', parentId: null, icon: null, taxTreatment: 'none',
    children: [{ id: 2, name: 'Internet', parentId: 1, icon: null, taxTreatment: 'none', children: [] }],
  };
  const resolved: ResolvedCategoryPath = { id: 2, name: 'Internet', path: 'Work / Internet', createdIds: [] };
  assert.equal(node.children[0].id, 2);
  assert.equal(resolved.id, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/connoradams/Developer/cashflow/.claude/worktrees/subcategories-plan-c2 && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH tsx --test shared/categoryTree.types.test.ts`
Expected: FAIL — `CategoryTreeNode`/`ResolvedCategoryPath` not exported.

- [ ] **Step 3: Write minimal implementation**

In `shared/api-types.ts`, add (near the existing `Category` type; `TaxTreatment` already exists there):
```ts
export type CategoryTreeNode = {
  id: number;
  name: string;
  parentId: number | null;
  icon: string | null;
  taxTreatment: TaxTreatment;
  children: CategoryTreeNode[];
};

export type ResolvedCategoryPath = {
  id: number;
  name: string | null;
  path: string;
  createdIds: number[];
};
```
In `frontend/src/types/api.ts`, add `CategoryTreeNode,` and `ResolvedCategoryPath,` to the `export type { ... } from '@cashflow/shared'` list.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/connoradams/Developer/cashflow/.claude/worktrees/subcategories-plan-c2 && PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH tsx --test shared/categoryTree.types.test.ts`
Expected: PASS. Then `PATH=...:$PATH yarn workspace frontend run build` → tsc clean.

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add shared/api-types.ts frontend/src/types/api.ts shared/categoryTree.types.test.ts && \
git commit -m "feat(categories): shared CategoryTreeNode + ResolvedCategoryPath types"
```

---

### Task 2: `categoriesApi.ts` — tree fetch, path resolve, flatten util

**Files:**
- Create: `frontend/src/lib/categoriesApi.ts`
- Test: `frontend/src/lib/categoriesApi.test.ts`

**Interfaces:**
- Consumes: `getJson`/`postJson` from `./api`; `CategoryTreeNode`/`ResolvedCategoryPath` (Task 1).
- Produces:
  - `getCategoryTree(): Promise<CategoryTreeNode[]>` → `GET /api/categories/tree`.
  - `resolveCategoryPath(path: string): Promise<ResolvedCategoryPath>` → `POST /api/categories/resolve-path` with `{ path }`.
  - `flattenTreeToPaths(nodes: CategoryTreeNode[]): string[]` — returns every node's full path (`Work / Expenses / Internet`), depth-first, sorted, using ` / ` as the separator.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/lib/categoriesApi.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as api from './api';
import { getCategoryTree, resolveCategoryPath, flattenTreeToPaths } from './categoriesApi';
import type { CategoryTreeNode } from '../types/api';

const tree: CategoryTreeNode[] = [
  { id: 1, name: 'Work', parentId: null, icon: null, taxTreatment: 'none', children: [
    { id: 2, name: 'Expenses', parentId: 1, icon: null, taxTreatment: 'none', children: [
      { id: 3, name: 'Internet', parentId: 2, icon: null, taxTreatment: 'none', children: [] },
    ]},
  ]},
  { id: 4, name: 'Groceries', parentId: null, icon: null, taxTreatment: 'none', children: [] },
];

describe('categoriesApi', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('flattenTreeToPaths returns full paths sorted', () => {
    expect(flattenTreeToPaths(tree)).toEqual([
      'Groceries', 'Work', 'Work / Expenses', 'Work / Expenses / Internet',
    ]);
  });

  it('getCategoryTree hits /api/categories/tree', async () => {
    const spy = vi.spyOn(api, 'getJson').mockResolvedValue(tree);
    const out = await getCategoryTree();
    expect(spy).toHaveBeenCalledWith('/api/categories/tree');
    expect(out[0].name).toBe('Work');
  });

  it('resolveCategoryPath posts the path', async () => {
    const spy = vi.spyOn(api, 'postJson').mockResolvedValue({ id: 3, name: 'Internet', path: 'Work / Expenses / Internet', createdIds: [] });
    const out = await resolveCategoryPath('Work / Expenses / Internet');
    expect(spy).toHaveBeenCalledWith('/api/categories/resolve-path', { path: 'Work / Expenses / Internet' });
    expect(out.id).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn workspace frontend run test src/lib/categoriesApi.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// frontend/src/lib/categoriesApi.ts
import { getJson, postJson } from './api';
import type { CategoryTreeNode, ResolvedCategoryPath } from '../types/api';

export const CATEGORY_PATH_SEPARATOR = ' / ';

export function getCategoryTree(): Promise<CategoryTreeNode[]> {
  return getJson<CategoryTreeNode[]>('/api/categories/tree');
}

export function resolveCategoryPath(path: string): Promise<ResolvedCategoryPath> {
  return postJson<ResolvedCategoryPath>('/api/categories/resolve-path', { path });
}

/** Every node's full path, depth-first, sorted ascending. */
export function flattenTreeToPaths(nodes: CategoryTreeNode[]): string[] {
  const out: string[] = [];
  const walk = (node: CategoryTreeNode, prefix: string) => {
    const path = prefix ? `${prefix}${CATEGORY_PATH_SEPARATOR}${node.name}` : node.name;
    out.push(path);
    for (const child of node.children) walk(child, path);
  };
  for (const root of nodes) walk(root, '');
  return out.sort((a, b) => a.localeCompare(b));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn workspace frontend run test src/lib/categoriesApi.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add frontend/src/lib/categoriesApi.ts frontend/src/lib/categoriesApi.test.ts && \
git commit -m "feat(categories): categoriesApi — tree fetch, path resolve, flatten util"
```

---

### Task 3: `useCategoryPaths` hook

**Files:**
- Create: `frontend/src/lib/useCategoryPaths.ts`
- Test: `frontend/src/lib/useCategoryPaths.test.tsx`

**Interfaces:**
- Consumes: `getCategoryTree`, `flattenTreeToPaths` (Task 2).
- Produces: `useCategoryPaths(): { paths: string[]; refresh: () => Promise<void> }` — fetches the tree once on mount, exposes full-path strings; `refresh()` re-fetches. Mirrors the `useCategories` module-cache pattern (shared cache + listeners) so multiple rows don't each fetch.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/lib/useCategoryPaths.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import * as catApi from './categoriesApi';
import { useCategoryPaths, _resetCategoryPathsCacheForTest } from './useCategoryPaths';
import type { CategoryTreeNode } from '../types/api';

const tree: CategoryTreeNode[] = [
  { id: 1, name: 'Work', parentId: null, icon: null, taxTreatment: 'none', children: [
    { id: 2, name: 'Internet', parentId: 1, icon: null, taxTreatment: 'none', children: [] },
  ]},
];

describe('useCategoryPaths', () => {
  beforeEach(() => { vi.restoreAllMocks(); _resetCategoryPathsCacheForTest(); });

  it('exposes full paths from the tree', async () => {
    vi.spyOn(catApi, 'getCategoryTree').mockResolvedValue(tree);
    const { result } = renderHook(() => useCategoryPaths());
    await waitFor(() => expect(result.current.paths).toContain('Work / Internet'));
    expect(result.current.paths).toContain('Work');
  });

  it('fetches once across instances', async () => {
    const spy = vi.spyOn(catApi, 'getCategoryTree').mockResolvedValue(tree);
    const a = renderHook(() => useCategoryPaths());
    const b = renderHook(() => useCategoryPaths());
    await waitFor(() => expect(a.result.current.paths.length).toBeGreaterThan(0));
    await waitFor(() => expect(b.result.current.paths.length).toBeGreaterThan(0));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn workspace frontend run test src/lib/useCategoryPaths.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// frontend/src/lib/useCategoryPaths.ts
import { useEffect, useState, useCallback } from 'react';
import { getCategoryTree, flattenTreeToPaths } from './categoriesApi';

type Listener = (paths: string[]) => void;
let cache: string[] | null = null;
let inflight: Promise<string[]> | null = null;
const listeners = new Set<Listener>();

export function _resetCategoryPathsCacheForTest(): void {
  cache = null; inflight = null; listeners.clear();
}

async function load(force = false): Promise<string[]> {
  if (!force && cache) return cache;
  if (!force && inflight) return inflight;
  inflight = getCategoryTree()
    .then((tree) => {
      const paths = flattenTreeToPaths(tree);
      cache = paths;
      for (const l of listeners) l(paths);
      return paths;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

export function useCategoryPaths(): { paths: string[]; refresh: () => Promise<void> } {
  const [paths, setPaths] = useState<string[]>(cache ?? []);
  useEffect(() => {
    listeners.add(setPaths);
    load().then(setPaths).catch(() => {/* refresh() can retry */});
    return () => { listeners.delete(setPaths); };
  }, []);
  const refresh = useCallback(async () => { setPaths(await load(true)); }, []);
  return { paths, refresh };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn workspace frontend run test src/lib/useCategoryPaths.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add frontend/src/lib/useCategoryPaths.ts frontend/src/lib/useCategoryPaths.test.tsx && \
git commit -m "feat(categories): useCategoryPaths hook (full-path options)"
```

---

### Task 4: Transactions row tags children via `categoryOverrideId`

**Files:**
- Modify: `frontend/src/pages/TransactionsPage.tsx` (row `categoryOptions` source; the category save in `saveRow`/the row's save handler)
- Test: `frontend/src/pages/TransactionsCategoryTag.test.tsx`

**Interfaces:**
- Consumes: `useCategoryPaths` (Task 3), `resolveCategoryPath` (Task 2).
- Produces: when the user picks/types a category path on a transaction row and saves, the page resolves the path → id and PATCHes `{ categoryOverrideId: id }` (clearing → `{ categoryOverrideId: null }`) instead of `{ categoryOverride: string }`. The full-path options come from `useCategoryPaths`.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/pages/TransactionsCategoryTag.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import * as catApi from '../lib/categoriesApi';
import * as api from '../lib/api';

// Extract the row's category-save into a small exported pure helper so it is unit-testable
// without rendering the whole page; import + test that helper.
import { resolveCategoryPatch } from './TransactionsPage';

describe('resolveCategoryPatch', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('resolves a path to an id and returns a categoryOverrideId patch', async () => {
    vi.spyOn(catApi, 'resolveCategoryPath').mockResolvedValue({ id: 7, name: 'Internet', path: 'Work / Internet', createdIds: [] });
    const patch = await resolveCategoryPatch('Work / Internet');
    expect(patch).toEqual({ categoryOverrideId: 7 });
  });

  it('empty input clears the override', async () => {
    const patch = await resolveCategoryPatch('');
    expect(patch).toEqual({ categoryOverrideId: null });
  });
});
```

> If `TransactionsPage.tsx` is too large/tangled to export cleanly, place `resolveCategoryPatch` in a new `frontend/src/pages/transactionsCategory.ts` and import it both in the page and the test (keeps the page thin and the logic unit-testable). Prefer that.

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn workspace frontend run test src/pages/TransactionsCategoryTag.test.tsx`
Expected: FAIL — `resolveCategoryPatch` not exported.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/pages/transactionsCategory.ts`:
```ts
import { resolveCategoryPath } from '../lib/categoriesApi';

/**
 * Turn a chosen category path string into a transaction PATCH body that tags by id.
 * Empty/whitespace → clears the override (null). Otherwise resolve path → leaf id.
 */
export async function resolveCategoryPatch(pathInput: string): Promise<{ categoryOverrideId: number | null }> {
  const trimmed = pathInput.trim();
  if (!trimmed) return { categoryOverrideId: null };
  const { id } = await resolveCategoryPath(trimmed);
  return { categoryOverrideId: id };
}
```
Re-export it from `TransactionsPage.tsx` (`export { resolveCategoryPatch } from './transactionsCategory';`) so the test's import path works, OR point the test at `./transactionsCategory` — pick one and keep it consistent.

In `TransactionsPage.tsx`:
1. Source the row `categoryOptions` from `useCategoryPaths().paths` (replace the existing flat-name options).
2. In the row's save path, where it currently puts `categoryOverride: cat` into the patch, instead: `const catPatch = await resolveCategoryPatch(cat); ...{ ...patch, ...catPatch }` and remove the `categoryOverride` string assignment. Keep all other patch fields unchanged.

> Leave `ReviewInboxPage` and the bulk-patch path as-is in C2a (they still send `categoryOverride` strings → resolve to roots). Child-tagging in Review/bulk is a follow-on (needs `categoryOverrideId` support in `/api/transactions/bulk-patch`).

- [ ] **Step 4: Run test to verify it passes**

Run: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn workspace frontend run test src/pages/TransactionsCategoryTag.test.tsx`
Expected: PASS (2). Then `yarn workspace frontend run build` (tsc) + `... run lint` clean, and run the existing TransactionsPage tests if any (`yarn workspace frontend run test TransactionsPage`).

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add frontend/src/pages/TransactionsPage.tsx frontend/src/pages/transactionsCategory.ts frontend/src/pages/TransactionsCategoryTag.test.tsx && \
git commit -m "feat(categories): Transactions row tags children via categoryOverrideId"
```

---

## Final verification

- [ ] Frontend tests green: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn workspace frontend run test src/lib/categoriesApi.test.ts src/lib/useCategoryPaths.test.tsx src/pages/TransactionsCategoryTag.test.tsx`.
- [ ] `yarn workspace frontend run build` (tsc) + `... run lint` clean.
- [ ] Shared type test green (`tsx --test shared/categoryTree.types.test.ts`).
- [ ] Manual sanity (optional): the Transactions picker shows full paths; choosing `Work / Internet` PATCHes `categoryOverrideId`.

## What C2a leaves to C2b / C2c / follow-on

- **Follow-on (small backend + frontend):** `ReviewInboxPage` + `/api/transactions/bulk-patch` child-tagging via `categoryOverrideId` (bulk-patch currently only accepts the `categoryOverride` string).
- **C2b:** category manager (extend `CategoriesTab`) — tree, create child, rename, drag-to-reparent (`dnd-kit`), delete-block.
- **C2c:** `RollupRow`/`categoryTree` shared types + a collapsible per-currency rollup tree rendered in the dashboard/monthly category views.
- AI suggestion accept-time path creation.
