// frontend/src/pages/settings/tabs/CategoryTreeReparent.test.tsx
import React from 'react';
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
