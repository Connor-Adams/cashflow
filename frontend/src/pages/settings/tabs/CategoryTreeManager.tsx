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
  onReparent?: (id: number, newParentId: number | null) => void;
};

function TreeNode({ node, depth, onChanged, onError, onReparent: _onReparent }: NodeProps) {
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
            onKeyDown={(e) => {
              if (e.key === 'Enter') { setRenaming(false); void run(() => renameCategory(node.id, renameValue.trim())); }
              if (e.key === 'Escape') { setRenaming(false); setRenameValue(node.name); }
            }}
            onBlur={() => {
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
            onDoubleClick={() => { setRenameValue(node.name); setRenaming(true); }}
          >
            {node.name}
          </button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Rename ${node.name}`}
          onClick={() => { setRenameValue(node.name); setRenaming(true); }}
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
      {node.children.length > 0 && (
        <ul>
          {node.children.map((c) => (
            <TreeNode
              key={c.id}
              node={c}
              depth={depth + 1}
              onChanged={onChanged}
              onError={onError}
              onReparent={_onReparent}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export type CategoryTreeManagerProps = {
  onReparent?: (id: number, newParentId: number | null) => void;
};

export function CategoryTreeManager({ onReparent }: CategoryTreeManagerProps = {}) {
  const { tree, loading, error, refresh } = useCategoryTree();
  const [actionError, setActionError] = useState<string | null>(null);

  return (
    <div>
      {(error || actionError) && (
        <span className="error" role="alert">{actionError ?? error}</span>
      )}
      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
        <ul className="flex flex-col">
          {tree.map((n) => (
            <TreeNode
              key={n.id}
              node={n}
              depth={0}
              onChanged={async () => { setActionError(null); await refresh(); }}
              onError={setActionError}
              onReparent={onReparent}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
