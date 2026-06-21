import { CATEGORY_PATH_SEPARATOR } from './categoriesApi';
import type { CategoryTreeNode } from '../types/api';

/** Map each category node id → its full path (e.g. "Work / Internet"). */
export function buildPathById(nodes: CategoryTreeNode[] | null | undefined): Map<number, string> {
  const out = new Map<number, string>();
  if (!nodes) return out;
  const walk = (node: CategoryTreeNode, prefix: string) => {
    const path = prefix ? `${prefix}${CATEGORY_PATH_SEPARATOR}${node.name}` : node.name;
    out.set(node.id, path);
    for (const child of node.children) walk(child, path);
  };
  for (const root of nodes) walk(root, '');
  return out;
}
