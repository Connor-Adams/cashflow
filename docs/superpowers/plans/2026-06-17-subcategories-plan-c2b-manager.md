# Subcategories — Plan C2b: category manager page

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the flat category settings tab into a **tree manager** — view the category tree, create a child, rename inline, drag-to-reparent, and delete (with block-on-409 messaging).

**Architecture:** Add category mutation wrappers (`createCategory`/`renameCategory`/`reparentCategory`/`deleteCategory`) to `categoriesApi.ts`; a `useCategoryTree()` hook loads the tree + refreshes. A new `CategoryTreeManager` component renders `CategoryTreeNode[]` recursively — each row has inline rename, a "+ child" button, a delete button (surfaces the 409 `has_children`/`has_references` message), and is a native-HTML5 drag source + drop target for reparent (cycle/`sibling_conflict` errors surfaced). `CategoriesTab` swaps its flat list for the manager while keeping per-node icon/tax editing.

**Tech Stack:** React 19 + Tailwind v4 + vitest/testing-library. **Reparent uses native HTML5 drag-and-drop** (`draggable` + `onDragStart`/`onDragOver`/`onDrop`, mirroring `frontend/src/components/import/ImportModal.tsx`) — **no new dependency** (the worktree cannot `yarn add`).

## Global Constraints

- Worktree root: `/Users/connoradams/Developer/cashflow/.claude/worktrees/subcategories-plan-c2` (frontend deps via the `frontend/node_modules` symlink to the main checkout).
- **Frontend tests:** `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn workspace frontend run test src/<path>.test.tsx`. Build (tsc): `... run build`; lint: `... run lint`.
- Mock API in tests via `vi.spyOn(api, 'getJson'|'postJson'|'patchJson'|'deleteReq')`; use `@testing-library/user-event`; reset the categories cache with `_resetCategoriesCacheForTest` where a test renders `CategoriesTab`.
- Frontend imports DTO types from `../types/api`, never `@cashflow/shared` directly in components.
- Builds on merged C1 + C2a (on this branch): `categoriesApi.ts` has `getCategoryTree`/`resolveCategoryPath`/`flattenTreeToPaths`; backend endpoints exist — POST `/api/categories {name, parentId}` → 201 row; PATCH `/api/categories/:id {name}` → 200 row | 409 `{error, code:'sibling_conflict'}`; PATCH `/api/categories/:id/reparent {parentId}` → 200 row | 409 `{code:'cycle'|'sibling_conflict'}` | 404 `{code:'not_found'|'parent_not_found'}`; DELETE `/api/categories/:id` → 204 | 409 `{error, code:'has_children'|'has_references'}`.
- The `ApiError` thrown by the api client carries `.message` and `.status`; the response body's `code` is NOT on the error object — surface the server `error` message text (which is human-readable) for delete/reparent failures.
- Commits: NO co-author trailers. Stage only each task's files (never `git add -A`, never `yarn.lock`). Prefix commit with `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH`.

---

### Task 1: category mutation API wrappers

**Files:**
- Modify: `frontend/src/lib/categoriesApi.ts`
- Test: `frontend/src/lib/categoriesApiMutations.test.ts`

**Interfaces:**
- Consumes: `postJson`/`patchJson`/`deleteReq` from `./api`; `CategoryTreeNode` from `../types/api`.
- Produces:
  - `createCategory(name: string, parentId: number | null): Promise<CategoryTreeNode>` → `POST /api/categories { name, parentId }`.
  - `renameCategory(id: number, name: string): Promise<CategoryTreeNode>` → `PATCH /api/categories/:id { name }`.
  - `reparentCategory(id: number, parentId: number | null): Promise<CategoryTreeNode>` → `PATCH /api/categories/:id/reparent { parentId }`.
  - `deleteCategory(id: number): Promise<void>` → `DELETE /api/categories/:id`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/lib/categoriesApiMutations.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as api from './api';
import { createCategory, renameCategory, reparentCategory, deleteCategory } from './categoriesApi';

describe('categoriesApi mutations', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('createCategory posts name + parentId', async () => {
    const spy = vi.spyOn(api, 'postJson').mockResolvedValue({ id: 5 } as never);
    await createCategory('Internet', 1);
    expect(spy).toHaveBeenCalledWith('/api/categories', { name: 'Internet', parentId: 1 });
  });

  it('renameCategory patches name', async () => {
    const spy = vi.spyOn(api, 'patchJson').mockResolvedValue({ id: 5 } as never);
    await renameCategory(5, 'WiFi');
    expect(spy).toHaveBeenCalledWith('/api/categories/5', { name: 'WiFi' });
  });

  it('reparentCategory patches the reparent endpoint', async () => {
    const spy = vi.spyOn(api, 'patchJson').mockResolvedValue({ id: 5 } as never);
    await reparentCategory(5, 2);
    expect(spy).toHaveBeenCalledWith('/api/categories/5/reparent', { parentId: 2 });
  });

  it('deleteCategory hits the delete endpoint', async () => {
    const spy = vi.spyOn(api, 'deleteReq').mockResolvedValue(undefined);
    await deleteCategory(5);
    expect(spy).toHaveBeenCalledWith('/api/categories/5');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn workspace frontend run test src/lib/categoriesApiMutations.test.ts`
Expected: FAIL — the four functions are not exported.

- [ ] **Step 3: Write minimal implementation**

In `frontend/src/lib/categoriesApi.ts`, change the import to add `patchJson, deleteReq` and append the four functions:
```ts
import { getJson, postJson, patchJson, deleteReq } from './api';
// ... existing exports ...

export function createCategory(name: string, parentId: number | null): Promise<CategoryTreeNode> {
  return postJson<CategoryTreeNode>('/api/categories', { name, parentId });
}

export function renameCategory(id: number, name: string): Promise<CategoryTreeNode> {
  return patchJson<CategoryTreeNode>(`/api/categories/${id}`, { name });
}

export function reparentCategory(id: number, parentId: number | null): Promise<CategoryTreeNode> {
  return patchJson<CategoryTreeNode>(`/api/categories/${id}/reparent`, { parentId });
}

export function deleteCategory(id: number): Promise<void> {
  return deleteReq(`/api/categories/${id}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn workspace frontend run test src/lib/categoriesApiMutations.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add frontend/src/lib/categoriesApi.ts frontend/src/lib/categoriesApiMutations.test.ts && \
git commit -m "feat(categories): create/rename/reparent/delete API wrappers"
```

---

### Task 2: `useCategoryTree` hook

**Files:**
- Create: `frontend/src/lib/useCategoryTree.ts`
- Test: `frontend/src/lib/useCategoryTree.test.tsx`

**Interfaces:**
- Consumes: `getCategoryTree` (categoriesApi).
- Produces: `useCategoryTree(): { tree: CategoryTreeNode[]; loading: boolean; error: string | null; refresh: () => Promise<void> }` — loads the tree on mount, exposes it, and `refresh()` re-fetches. (Per-instance state — the manager is the only consumer; no module cache needed.)

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/lib/useCategoryTree.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import * as catApi from './categoriesApi';
import { useCategoryTree } from './useCategoryTree';
import type { CategoryTreeNode } from '../types/api';

const tree: CategoryTreeNode[] = [
  { id: 1, name: 'Work', parentId: null, icon: null, taxTreatment: 'none', children: [] },
];

describe('useCategoryTree', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('loads the tree on mount', async () => {
    vi.spyOn(catApi, 'getCategoryTree').mockResolvedValue(tree);
    const { result } = renderHook(() => useCategoryTree());
    await waitFor(() => expect(result.current.tree).toHaveLength(1));
    expect(result.current.tree[0].name).toBe('Work');
    expect(result.current.loading).toBe(false);
  });

  it('refresh re-fetches', async () => {
    const spy = vi.spyOn(catApi, 'getCategoryTree').mockResolvedValue(tree);
    const { result } = renderHook(() => useCategoryTree());
    await waitFor(() => expect(result.current.tree).toHaveLength(1));
    await act(async () => { await result.current.refresh(); });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn workspace frontend run test src/lib/useCategoryTree.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// frontend/src/lib/useCategoryTree.ts
import { useEffect, useState, useCallback } from 'react';
import { getCategoryTree } from './categoriesApi';
import type { CategoryTreeNode } from '../types/api';

export function useCategoryTree(): {
  tree: CategoryTreeNode[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const [tree, setTree] = useState<CategoryTreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTree(await getCategoryTree());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load categories');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return { tree, loading, error, refresh };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn workspace frontend run test src/lib/useCategoryTree.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add frontend/src/lib/useCategoryTree.ts frontend/src/lib/useCategoryTree.test.tsx && \
git commit -m "feat(categories): useCategoryTree hook"
```

---

### Task 3: `CategoryTreeManager` — render, create child, rename, delete

**Files:**
- Create: `frontend/src/pages/settings/tabs/CategoryTreeManager.tsx`
- Test: `frontend/src/pages/settings/tabs/CategoryTreeManager.test.tsx`

**Interfaces:**
- Consumes: `useCategoryTree` (Task 2), `createCategory`/`renameCategory`/`deleteCategory` (Task 1), `CategoryTreeNode` from `../../../types/api`.
- Produces: `<CategoryTreeManager />` — renders the tree (nested, indented by depth); each node row has the name, a "+ Sub" button (creates a child via a small inline input/prompt), an inline rename (double-click or an Edit button → input → save on Enter/blur), and a Delete button that on a 409 shows the server's message inline. Mutations call `refresh()` after success. Reparent (drag) is added in Task 4; leave a `onReparent?` hook seam.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/pages/settings/tabs/CategoryTreeManager.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as catApi from '../../../lib/categoriesApi';
import { CategoryTreeManager } from './CategoryTreeManager';
import type { CategoryTreeNode } from '../../../types/api';

const tree: CategoryTreeNode[] = [
  { id: 1, name: 'Work', parentId: null, icon: null, taxTreatment: 'none', children: [
    { id: 2, name: 'Internet', parentId: 1, icon: null, taxTreatment: 'none', children: [] },
  ]},
];

describe('CategoryTreeManager', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders the tree (parent + child)', async () => {
    vi.spyOn(catApi, 'getCategoryTree').mockResolvedValue(tree);
    render(<CategoryTreeManager />);
    await waitFor(() => screen.getByText('Work'));
    expect(screen.getByText('Internet')).toBeInTheDocument();
  });

  it('creating a child calls createCategory then refreshes', async () => {
    const getSpy = vi.spyOn(catApi, 'getCategoryTree').mockResolvedValue(tree);
    const createSpy = vi.spyOn(catApi, 'createCategory').mockResolvedValue({ id: 9 } as never);
    render(<CategoryTreeManager />);
    await waitFor(() => screen.getByText('Work'));
    await userEvent.click(screen.getByRole('button', { name: /add subcategory under Work/i }));
    await userEvent.type(screen.getByRole('textbox', { name: /new subcategory name/i }), 'Phone');
    await userEvent.click(screen.getByRole('button', { name: /create subcategory/i }));
    await waitFor(() => expect(createSpy).toHaveBeenCalledWith('Phone', 1));
    expect(getSpy).toHaveBeenCalledTimes(2); // initial + refresh
  });

  it('delete that returns 409 shows the server message', async () => {
    vi.spyOn(catApi, 'getCategoryTree').mockResolvedValue(tree);
    vi.spyOn(catApi, 'deleteCategory').mockRejectedValue(
      Object.assign(new Error('reparent or remove child categories before deleting this one'), { status: 409 }),
    );
    render(<CategoryTreeManager />);
    await waitFor(() => screen.getByText('Work'));
    await userEvent.click(screen.getByRole('button', { name: /delete Work/i }));
    await waitFor(() => screen.getByText(/reparent or remove child categories/i));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn workspace frontend run test src/pages/settings/tabs/CategoryTreeManager.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```tsx
// frontend/src/pages/settings/tabs/CategoryTreeManager.tsx
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useCategoryTree } from '../../../lib/useCategoryTree';
import { createCategory, renameCategory, deleteCategory } from '../../../lib/categoriesApi';
import type { CategoryTreeNode } from '../../../types/api';

type NodeProps = {
  node: CategoryTreeNode;
  depth: number;
  onChanged: () => Promise<void>;
  onError: (msg: string) => void;
};

function TreeNode({ node, depth, onChanged, onError }: NodeProps) {
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(node.name);
  const [adding, setAdding] = useState(false);
  const [childName, setChildName] = useState('');

  async function run(fn: () => Promise<unknown>) {
    try { await fn(); await onChanged(); }
    catch (e) { onError(e instanceof Error ? e.message : 'Action failed'); }
  }

  return (
    <li>
      <div className="flex items-center gap-2 py-1" style={{ paddingLeft: depth * 16 }}>
        {renaming ? (
          <input
            aria-label={`Rename ${node.name}`}
            className="flex-1"
            value={renameValue}
            autoFocus
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { setRenaming(false); void run(() => renameCategory(node.id, renameValue.trim())); } if (e.key === 'Escape') { setRenaming(false); setRenameValue(node.name); } }}
            onBlur={() => { setRenaming(false); if (renameValue.trim() && renameValue.trim() !== node.name) void run(() => renameCategory(node.id, renameValue.trim())); }}
          />
        ) : (
          <button type="button" className="flex-1 text-left" onDoubleClick={() => { setRenameValue(node.name); setRenaming(true); }}>
            {node.name}
          </button>
        )}
        <Button type="button" variant="ghost" size="sm" aria-label={`Rename ${node.name}`} onClick={() => { setRenameValue(node.name); setRenaming(true); }}>Rename</Button>
        <Button type="button" variant="ghost" size="sm" aria-label={`Add subcategory under ${node.name}`} onClick={() => setAdding((v) => !v)}>+ Sub</Button>
        <Button type="button" variant="ghost" size="sm" aria-label={`Delete ${node.name}`} onClick={() => void run(() => deleteCategory(node.id))}>Delete</Button>
      </div>
      {adding && (
        <div className="flex items-center gap-2 py-1" style={{ paddingLeft: (depth + 1) * 16 }}>
          <input aria-label="new subcategory name" className="flex-1" value={childName} autoFocus onChange={(e) => setChildName(e.target.value)} />
          <Button type="button" size="sm" aria-label="create subcategory" onClick={() => { const n = childName.trim(); if (!n) return; setAdding(false); setChildName(''); void run(() => createCategory(n, node.id)); }}>Add</Button>
        </div>
      )}
      {node.children.length > 0 && (
        <ul>{node.children.map((c) => <TreeNode key={c.id} node={c} depth={depth + 1} onChanged={onChanged} onError={onError} />)}</ul>
      )}
    </li>
  );
}

export function CategoryTreeManager() {
  const { tree, loading, error, refresh } = useCategoryTree();
  const [actionError, setActionError] = useState<string | null>(null);

  return (
    <div>
      {(error || actionError) && <span className="error" role="alert">{actionError ?? error}</span>}
      {loading ? <p className="muted">Loading…</p> : (
        <ul className="flex flex-col">
          {tree.map((n) => (
            <TreeNode key={n.id} node={n} depth={0} onChanged={async () => { setActionError(null); await refresh(); }} onError={setActionError} />
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn workspace frontend run test src/pages/settings/tabs/CategoryTreeManager.test.tsx`
Expected: PASS (3 tests). Then `yarn workspace frontend run build` (tsc) + `... run lint` clean.

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add frontend/src/pages/settings/tabs/CategoryTreeManager.tsx frontend/src/pages/settings/tabs/CategoryTreeManager.test.tsx && \
git commit -m "feat(categories): CategoryTreeManager — tree render, create child, rename, delete-block"
```

---

### Task 4: drag-to-reparent (native HTML5)

**Files:**
- Modify: `frontend/src/pages/settings/tabs/CategoryTreeManager.tsx`
- Test: `frontend/src/pages/settings/tabs/CategoryTreeReparent.test.tsx`

**Interfaces:**
- Consumes: `reparentCategory` (Task 1).
- Produces: each `TreeNode` row is `draggable` (sets `dataTransfer` `text/plain` = node id on `onDragStart`) and a drop target (`onDragOver` preventDefault + `onDrop` reads the dragged id and calls `reparentCategory(draggedId, node.id)` then `refresh()`). A root-level drop zone (the outer `<ul>`) reparents to `null` (move to root). On a 409 (cycle / sibling_conflict), the server message is surfaced via `onError` — the two cases produce distinct server messages, so no client mapping is needed.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/pages/settings/tabs/CategoryTreeReparent.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import * as catApi from '../../../lib/categoriesApi';
import { CategoryTreeManager } from './CategoryTreeManager';
import type { CategoryTreeNode } from '../../../types/api';

const tree: CategoryTreeNode[] = [
  { id: 1, name: 'Work', parentId: null, icon: null, taxTreatment: 'none', children: [] },
  { id: 2, name: 'Home', parentId: null, icon: null, taxTreatment: 'none', children: [] },
];

function dataTransfer() {
  const store: Record<string, string> = {};
  return { setData: (k: string, v: string) => { store[k] = v; }, getData: (k: string) => store[k] ?? '', effectAllowed: '', dropEffect: '' } as unknown as DataTransfer;
}

describe('CategoryTreeManager reparent', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('dropping Work onto Home reparents Work under Home', async () => {
    vi.spyOn(catApi, 'getCategoryTree').mockResolvedValue(tree);
    const reparentSpy = vi.spyOn(catApi, 'reparentCategory').mockResolvedValue({ id: 1 } as never);
    render(<CategoryTreeManager />);
    await waitFor(() => screen.getByText('Work'));
    const dt = dataTransfer();
    const workRow = screen.getByText('Work').closest('[draggable="true"]')!;
    const homeRow = screen.getByText('Home').closest('[draggable="true"]')!;
    fireEvent.dragStart(workRow, { dataTransfer: dt });
    fireEvent.dragOver(homeRow, { dataTransfer: dt });
    fireEvent.drop(homeRow, { dataTransfer: dt });
    await waitFor(() => expect(reparentSpy).toHaveBeenCalledWith(1, 2));
  });

  it('a reparent 409 surfaces the server message', async () => {
    vi.spyOn(catApi, 'getCategoryTree').mockResolvedValue(tree);
    vi.spyOn(catApi, 'reparentCategory').mockRejectedValue(
      Object.assign(new Error('cannot move a category into its own subtree'), { status: 409 }),
    );
    render(<CategoryTreeManager />);
    await waitFor(() => screen.getByText('Work'));
    const dt = dataTransfer();
    const workRow = screen.getByText('Work').closest('[draggable="true"]')!;
    const homeRow = screen.getByText('Home').closest('[draggable="true"]')!;
    fireEvent.dragStart(workRow, { dataTransfer: dt });
    fireEvent.drop(homeRow, { dataTransfer: dt });
    await waitFor(() => screen.getByText(/cannot move a category into its own subtree/i));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn workspace frontend run test src/pages/settings/tabs/CategoryTreeReparent.test.tsx`
Expected: FAIL — rows aren't draggable / no drop handler.

- [ ] **Step 3: Write minimal implementation**

In `CategoryTreeManager.tsx`, import `reparentCategory`, and make the per-node row `div` a drag source + drop target. Replace the row `<div className="flex items-center gap-2 py-1" ...>` with:
```tsx
        <div
          className="flex items-center gap-2 py-1"
          style={{ paddingLeft: depth * 16 }}
          draggable
          onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(node.id)); }}
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
          onDrop={(e) => {
            e.preventDefault();
            const draggedId = Number(e.dataTransfer.getData('text/plain'));
            if (!draggedId || draggedId === node.id) return;
            void run(() => reparentCategory(draggedId, node.id));
          }}
        >
```
(Keep the row's inner content unchanged.) The server returns distinct messages for `cycle` ("cannot move a category into its own subtree") vs `sibling_conflict` ("a sibling named ... already exists ..."), both surfaced via `onError` (the existing `run` helper already catches + calls `onError`).

- [ ] **Step 4: Run test to verify it passes**

Run: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn workspace frontend run test src/pages/settings/tabs/CategoryTreeReparent.test.tsx src/pages/settings/tabs/CategoryTreeManager.test.tsx`
Expected: PASS. Then build (tsc) + lint clean.

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add frontend/src/pages/settings/tabs/CategoryTreeManager.tsx frontend/src/pages/settings/tabs/CategoryTreeReparent.test.tsx && \
git commit -m "feat(categories): drag-to-reparent in the category tree manager"
```

---

### Task 5: integrate `CategoryTreeManager` into `CategoriesTab`

**Files:**
- Modify: `frontend/src/pages/settings/tabs/CategoriesTab.tsx`
- Test: `frontend/src/pages/settings/tabs/CategoriesTab.test.tsx` (update)

**Interfaces:**
- Consumes: `CategoryTreeManager` (Task 3-4).
- Produces: `CategoriesTab` renders the `CategoryTreeManager` (tree CRUD) in addition to keeping the per-category **icon** + **tax treatment** editing it has today. Simplest: render the existing flat icon/tax list AND the tree manager in the same card under sub-headings ("Organize" → tree manager; "Icons & tax" → existing list), OR fold icon/tax into the tree rows. To stay in scope and not regress the icon test, KEEP the existing flat icon/tax list and ADD the `<CategoryTreeManager />` above it under a heading.

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/pages/settings/tabs/CategoriesTab.test.tsx`:
```tsx
  it('renders the tree manager alongside icon/tax editing', async () => {
    const list = [{ id: 1, householdId: 1, name: 'Coffee', icon: null, taxTreatment: 'none', createdAt: '', updatedAt: '' }];
    vi.spyOn(api, 'getJson').mockImplementation((path: string) => {
      if (path === '/api/categories/tree') return Promise.resolve([{ id: 1, name: 'Coffee', parentId: null, icon: null, taxTreatment: 'none', children: [] }]) as never;
      return Promise.resolve(list) as never;
    });
    render(<CategoriesTab />);
    // tree manager heading + the icon/tax control both present
    await waitFor(() => screen.getByText('Organize categories'));
    await waitFor(() => screen.getByRole('button', { name: /edit icon for Coffee/i }));
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn workspace frontend run test src/pages/settings/tabs/CategoriesTab.test.tsx`
Expected: FAIL — "Organize categories" heading not present.

- [ ] **Step 3: Write minimal implementation**

In `CategoriesTab.tsx`, import `CategoryTreeManager`, and inside the `<Card>` (above the existing `<ul>` icon/tax list) add:
```tsx
      <h3 className="mt-2">Organize categories</h3>
      <p className="muted">Create subcategories, rename, drag to reparent, or delete.</p>
      <CategoryTreeManager />
      <h3 className="mt-4">Icons &amp; tax</h3>
```
Keep the existing icon/tax `<ul>` + dialog exactly as-is below the new heading.

- [ ] **Step 4: Run test to verify it passes**

Run: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn workspace frontend run test src/pages/settings/tabs/CategoriesTab.test.tsx`
Expected: PASS (existing icon/tax tests + the new one). Then the FULL frontend suite + build + lint:
`PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn workspace frontend run test` and `... run build` and `... run lint` → all green.

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
git add frontend/src/pages/settings/tabs/CategoriesTab.tsx frontend/src/pages/settings/tabs/CategoriesTab.test.tsx && \
git commit -m "feat(categories): mount CategoryTreeManager in the Categories settings tab"
```

---

## Final verification

- [ ] Full frontend suite green: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH yarn workspace frontend run test`.
- [ ] `yarn workspace frontend run build` (tsc) + `... run lint` clean.
- [ ] Manual sanity (optional): the Categories settings tab shows the tree; create a child, rename, drag a node onto another to reparent, delete a node with children → see the block message.

## What Plan C2b leaves to C2c

- Render B2's per-currency `categoryTree` rollup (collapsed parent totals, expand to children) + full category-path display in the dashboard/monthly category breakdown views.
- ReviewInbox + bulk-patch child tagging (`categoryOverrideId`).
- AI suggestion accept-time path creation.
