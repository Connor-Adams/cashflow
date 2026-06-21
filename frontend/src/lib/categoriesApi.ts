import { getJson, postJson, patchJson, deleteReq } from './api';
import type { CategoryIconName } from '@cashflow/shared';
import type { CategoryTreeNode, ResolvedCategoryPath } from '../types/api';
import type { TaxTreatment } from './taxTreatment';

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

export function createCategory(name: string, parentId: number | null): Promise<CategoryTreeNode> {
  return postJson<CategoryTreeNode>('/api/categories', { name, parentId });
}

export function renameCategory(id: number, name: string): Promise<CategoryTreeNode> {
  return patchJson<CategoryTreeNode>(`/api/categories/${id}`, { name });
}

/** Patch a category's display/tax details (icon and/or tax treatment). */
export function updateCategory(
  id: number,
  patch: { icon?: CategoryIconName | null; taxTreatment?: TaxTreatment },
): Promise<CategoryTreeNode> {
  return patchJson<CategoryTreeNode>(`/api/categories/${id}`, patch);
}

export function reparentCategory(id: number, parentId: number | null): Promise<CategoryTreeNode> {
  return patchJson<CategoryTreeNode>(`/api/categories/${id}/reparent`, { parentId });
}

export function deleteCategory(id: number): Promise<void> {
  return deleteReq(`/api/categories/${id}`);
}
