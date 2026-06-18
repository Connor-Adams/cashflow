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
