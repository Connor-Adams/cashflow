// frontend/src/pages/settings/tabs/CategoryTreeManager.test.tsx
import React from 'react';
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
