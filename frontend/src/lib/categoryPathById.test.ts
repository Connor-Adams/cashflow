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
