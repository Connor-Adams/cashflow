// frontend/src/pages/settings/tabs/CategoryTreeManager.tsx
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useCategoryTree } from '../../../lib/useCategoryTree';
import { useCategories } from '../../../lib/useCategories';
import { createCategory, renameCategory, deleteCategory, reparentCategory } from '../../../lib/categoriesApi';
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
  const savedRef = useRef(false);

  async function run(fn: () => Promise<unknown>) {
    try { await fn(); await onChanged(); }
    catch (e) { onError(e instanceof Error ? e.message : 'Action failed'); }
  }

  return (
    <li>
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
        {renaming ? (
          <input
            aria-label={`Rename ${node.name}`}
            className="flex-1"
            value={renameValue}
            autoFocus
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                savedRef.current = true;
                setRenaming(false);
                void run(() => renameCategory(node.id, renameValue.trim()));
              }
              if (e.key === 'Escape') { setRenaming(false); setRenameValue(node.name); }
            }}
            onBlur={() => {
              if (savedRef.current) { savedRef.current = false; return; }
              setRenaming(false);
              if (renameValue.trim() && renameValue.trim() !== node.name) {
                void run(() => renameCategory(node.id, renameValue.trim()));
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="flex-1 text-left"
            onDoubleClick={() => { savedRef.current = false; setRenameValue(node.name); setRenaming(true); }}
          >
            {node.name}
          </button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Rename ${node.name}`}
          onClick={() => { savedRef.current = false; setRenameValue(node.name); setRenaming(true); }}
        >
          Rename
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Add subcategory under ${node.name}`}
          onClick={() => setAdding((v) => !v)}
        >
          + Sub
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Delete ${node.name}`}
          onClick={() => void run(() => deleteCategory(node.id))}
        >
          Delete
        </Button>
      </div>
      {adding && (
        <div className="flex items-center gap-2 py-1" style={{ paddingLeft: (depth + 1) * 16 }}>
          <input
            aria-label="new subcategory name"
            className="flex-1"
            value={childName}
            autoFocus
            onChange={(e) => setChildName(e.target.value)}
          />
          <Button
            type="button"
            size="sm"
            aria-label="create subcategory"
            onClick={() => {
              const n = childName.trim();
              if (!n) return;
              setAdding(false);
              setChildName('');
              void run(() => createCategory(n, node.id));
            }}
          >
            Add
          </Button>
        </div>
      )}
      {(node.children?.length ?? 0) > 0 && (
        <ul>
          {node.children.map((c) => (
            <TreeNode
              key={c.id}
              node={c}
              depth={depth + 1}
              onChanged={onChanged}
              onError={onError}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export type CategoryTreeManagerProps = Record<string, never>;

export function CategoryTreeManager() {
  const { tree, loading, error, refresh } = useCategoryTree();
  const { refresh: refreshGlobal } = useCategories();
  const [actionError, setActionError] = useState<string | null>(null);

  async function onChanged() {
    setActionError(null);
    await refresh();
    // best-effort: keep the global flat cache (icon/tax list, pickers) fresh
    refreshGlobal().catch(() => { /* swallow */ });
  }

  return (
    <div>
      {(error || actionError) && (
        <span className="error" role="alert">{actionError ?? error}</span>
      )}
      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
        <ul
          className="flex flex-col"
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
          onDrop={(e) => {
            e.preventDefault();
            const id = Number(e.dataTransfer.getData('text/plain'));
            if (!id) return;
            setActionError(null);
            reparentCategory(id, null)
              .then(() => refresh())
              .catch((err) => setActionError(err instanceof Error ? err.message : 'Could not move to root'));
          }}
        >
          <li className="muted" aria-label="Move to top level">
            Drop here to make a top-level category
          </li>
          {tree.map((n) => (
            <TreeNode
              key={n.id}
              node={n}
              depth={0}
              onChanged={onChanged}
              onError={setActionError}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
