// frontend/src/pages/settings/tabs/CategoryTreeManager.tsx
import { useRef, useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogBody, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tree, TreeGroup, TreeRow } from '@/components/ui/tree';
import { CategoryIcon } from '../../../components/CategoryIcon';
import { CategoryIconPicker } from '../../../components/CategoryIconPicker';
import { TaxTreatmentSelect } from '../../../components/TaxTreatmentSelect';
import { useCategoryTree } from '../../../lib/useCategoryTree';
import { useCategories } from '../../../lib/useCategories';
import { createCategory, renameCategory, deleteCategory, reparentCategory, updateCategory } from '../../../lib/categoriesApi';
import { TAX_TREATMENTS, type TaxTreatment } from '../../../lib/taxTreatment';
import type { CategoryIconName } from '@cashflow/shared';
import type { CategoryTreeNode } from '../../../types/api';

type NodeProps = {
  node: CategoryTreeNode;
  depth: number;
  collapsed: Set<number>;
  toggle: (id: number) => void;
  dragOverId: number | null;
  setDragOverId: (id: number | null) => void;
  onReparent: (draggedId: number, targetId: number) => void;
  onEdit: (id: number) => void;
  onChanged: () => Promise<void>;
  onError: (msg: string) => void;
};

function TreeNode({
  node, depth, collapsed, toggle, dragOverId, setDragOverId, onReparent, onEdit, onChanged, onError,
}: NodeProps) {
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(node.name);
  const [adding, setAdding] = useState(false);
  const [childName, setChildName] = useState('');
  const savedRef = useRef(false);

  const kids = node.children ?? [];
  const hasKids = kids.length > 0;
  const isOpen = !collapsed.has(node.id);
  const isDropTarget = dragOverId === node.id;

  async function run(fn: () => Promise<unknown>) {
    try { await fn(); await onChanged(); }
    catch (e) { onError(e instanceof Error ? e.message : 'Action failed'); }
  }

  return (
    <li>
      <TreeRow
        grip
        highlighted={isDropTarget}
        expandable={hasKids}
        expanded={isOpen}
        toggleLabel={node.name}
        onToggle={() => toggle(node.id)}
        draggable={!renaming}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(node.id));
        }}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; }}
        onDragEnter={(e) => { e.stopPropagation(); setDragOverId(node.id); }}
        onDragLeave={(e) => {
          // only clear when leaving the row itself, not bubbling from a child
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOverId(null);
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation(); // a drop on a node must not also trigger the root (top-level) handler
          setDragOverId(null);
          const draggedId = Number(e.dataTransfer.getData('text/plain'));
          if (!draggedId || draggedId === node.id) return;
          onReparent(draggedId, node.id);
        }}
        icon={
          <button
            type="button"
            data-slot="tree-icon"
            aria-label={`Edit icon and tax for ${node.name}`}
            className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-muted"
            onClick={() => onEdit(node.id)}
          >
            {node.icon
              ? <CategoryIcon name={node.name} size={15} />
              : <span className="size-1.5 rounded-full bg-muted-foreground/30 transition-colors group-hover:bg-muted-foreground/70" aria-hidden />}
          </button>
        }
        actions={
          <>
            <Button
              type="button" variant="ghost" size="icon" className="size-7"
              aria-label={`Rename ${node.name}`}
              onClick={() => { savedRef.current = false; setRenameValue(node.name); setRenaming(true); }}
            >
              <Pencil size={14} />
            </Button>
            <Button
              type="button" variant="ghost" size="icon" className="size-7"
              aria-label={`Add subcategory under ${node.name}`}
              onClick={() => setAdding((v) => !v)}
            >
              <Plus size={14} />
            </Button>
            <Button
              type="button" variant="ghost" size="icon" className="size-7 text-destructive hover:text-destructive"
              aria-label={`Delete ${node.name}`}
              onClick={() => void run(() => deleteCategory(node.id))}
            >
              <Trash2 size={14} />
            </Button>
          </>
        }
      >
        {renaming ? (
          <Input
            aria-label={`Rename ${node.name}`}
            className="h-7 flex-1"
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
            data-slot="tree-label"
            className="flex-1 truncate rounded px-1 text-left text-sm hover:bg-muted/40"
            onDoubleClick={() => { savedRef.current = false; setRenameValue(node.name); setRenaming(true); }}
          >
            {node.name}
          </button>
        )}
      </TreeRow>

      {adding && (
        <div className="flex items-center gap-2 py-1 pl-7">
          <Input
            aria-label="new subcategory name"
            className="h-7 flex-1"
            value={childName}
            autoFocus
            placeholder="Subcategory name"
            onChange={(e) => setChildName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { setAdding(false); setChildName(''); }
              if (e.key === 'Enter') {
                const n = childName.trim();
                if (!n) return;
                setAdding(false);
                setChildName('');
                void run(() => createCategory(n, node.id));
              }
            }}
          />
          <Button
            type="button" size="sm"
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

      {hasKids && isOpen && (
        <TreeGroup>
          {kids.map((c) => (
            <TreeNode
              key={c.id}
              node={c}
              depth={depth + 1}
              collapsed={collapsed}
              toggle={toggle}
              dragOverId={dragOverId}
              setDragOverId={setDragOverId}
              onReparent={onReparent}
              onEdit={onEdit}
              onChanged={onChanged}
              onError={onError}
            />
          ))}
        </TreeGroup>
      )}
    </li>
  );
}

/** Find a node by id anywhere in the tree. */
function findNode(tree: CategoryTreeNode[], id: number): CategoryTreeNode | null {
  for (const n of tree) {
    if (n.id === id) return n;
    const hit = findNode(n.children ?? [], id);
    if (hit) return hit;
  }
  return null;
}

/** All descendant ids of `id` within the tree (excludes `id` itself). */
function descendantIds(tree: CategoryTreeNode[], id: number): Set<number> {
  const out = new Set<number>();
  const root = findNode(tree, id);
  const walk = (n: CategoryTreeNode) => {
    for (const c of n.children ?? []) { out.add(c.id); walk(c); }
  };
  if (root) walk(root);
  return out;
}

export function CategoryTreeManager() {
  const { tree, loading, error, refresh } = useCategoryTree();
  const { refresh: refreshGlobal } = useCategories();
  const [actionError, setActionError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [dragOverId, setDragOverId] = useState<number | null>(null);
  const [draggingRoot, setDraggingRoot] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const editing = editingId != null ? findNode(tree, editingId) : null;

  function toggle(id: number) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function onChanged() {
    setActionError(null);
    await refresh();
    // best-effort: keep the global flat cache (icon/tax list, pickers) fresh
    refreshGlobal().catch(() => { /* swallow */ });
  }

  async function doReparent(draggedId: number, targetParentId: number | null) {
    setActionError(null);
    if (targetParentId != null && descendantIds(tree, draggedId).has(targetParentId)) {
      setActionError('Cannot move a category into one of its own subcategories');
      return;
    }
    try {
      await reparentCategory(draggedId, targetParentId);
      await onChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not move category');
    }
  }

  async function updateDetails(id: number, patch: { icon?: CategoryIconName | null; taxTreatment?: TaxTreatment }) {
    setActionError(null);
    try {
      await updateCategory(id, patch);
      await onChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not update category');
    }
  }

  return (
    <div>
      {(error || actionError) && (
        <span className="error" role="alert">{actionError ?? error}</span>
      )}
      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
        <Tree
          onDragEnter={() => setDraggingRoot(true)}
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
          onDrop={(e) => {
            e.preventDefault();
            setDraggingRoot(false);
            setDragOverId(null);
            const id = Number(e.dataTransfer.getData('text/plain'));
            if (!id) return;
            void doReparent(id, null);
          }}
        >
          <li
            className={
              'rounded-md border border-dashed px-3 py-1.5 text-xs text-muted-foreground transition-all ' +
              (draggingRoot ? 'treeDropZoneActive opacity-100' : 'border-transparent opacity-0 h-0 py-0 overflow-hidden')
            }
            aria-label="Move to top level"
          >
            Drop here to make a top-level category
          </li>
          {tree.map((n) => (
            <TreeNode
              key={n.id}
              node={n}
              depth={0}
              collapsed={collapsed}
              toggle={toggle}
              dragOverId={dragOverId}
              setDragOverId={setDragOverId}
              onReparent={(draggedId, targetId) => void doReparent(draggedId, targetId)}
              onEdit={setEditingId}
              onChanged={onChanged}
              onError={setActionError}
            />
          ))}
        </Tree>
      )}

      {editing && (
        <Dialog open onOpenChange={(open) => { if (!open) setEditingId(null); }}>
          <DialogHeader>
            <DialogTitle>{`Edit "${editing.name}"`}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <div className="mb-3 flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Tax treatment</span>
              <TaxTreatmentSelect
                aria-label={`Tax treatment for ${editing.name}`}
                value={editing.taxTreatment}
                options={[...TAX_TREATMENTS]}
                onChange={(t) => { if (t) void updateDetails(editing.id, { taxTreatment: t }); }}
              />
            </div>
            <CategoryIconPicker
              value={(editing.icon as CategoryIconName | null) ?? null}
              onSelect={(next) => void updateDetails(editing.id, { icon: next })}
            />
          </DialogBody>
        </Dialog>
      )}
    </div>
  );
}
