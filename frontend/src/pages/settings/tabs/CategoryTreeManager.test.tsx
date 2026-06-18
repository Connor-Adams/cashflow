// frontend/src/pages/settings/tabs/CategoryTreeManager.test.tsx
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as catApi from '../../../lib/categoriesApi';
import * as api from '../../../lib/api';
import { _resetCategoriesCacheForTest } from '../../../lib/useCategories';
import { CategoryTreeManager } from './CategoryTreeManager';
import type { CategoryTreeNode } from '../../../types/api';

const tree: CategoryTreeNode[] = [
  { id: 1, name: 'Work', parentId: null, icon: null, taxTreatment: 'none', children: [
    { id: 2, name: 'Internet', parentId: 1, icon: null, taxTreatment: 'none', children: [] },
  ]},
];

describe('CategoryTreeManager', () => {
  beforeEach(() => {
    _resetCategoriesCacheForTest();
    vi.restoreAllMocks();
  });

  function mockApis(treeData = tree) {
    vi.spyOn(catApi, 'getCategoryTree').mockResolvedValue(treeData);
    vi.spyOn(api, 'getJson').mockResolvedValue([]);
  }

  it('renders the tree (parent + child)', async () => {
    mockApis();
    render(<CategoryTreeManager />);
    await waitFor(() => screen.getByText('Work'));
    expect(screen.getByText('Internet')).toBeInTheDocument();
  });

  it('creating a child calls createCategory then refreshes', async () => {
    mockApis();
    const getSpy = vi.spyOn(catApi, 'getCategoryTree');
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
    mockApis();
    vi.spyOn(catApi, 'deleteCategory').mockRejectedValue(
      Object.assign(new Error('reparent or remove child categories before deleting this one'), { status: 409 }),
    );
    render(<CategoryTreeManager />);
    await waitFor(() => screen.getByText('Work'));
    await userEvent.click(screen.getByRole('button', { name: /delete Work/i }));
    await waitFor(() => screen.getByText(/reparent or remove child categories/i));
  });

  it('Enter-rename calls renameCategory exactly once (not again on blur)', async () => {
    mockApis();
    const renameSpy = vi.spyOn(catApi, 'renameCategory').mockResolvedValue({ id: 1 } as never);
    render(<CategoryTreeManager />);
    await waitFor(() => screen.getByText('Work'));
    await userEvent.click(screen.getByRole('button', { name: /rename Work/i }));
    const input = screen.getByRole('textbox', { name: /Rename Work/i });
    await userEvent.clear(input);
    await userEvent.type(input, 'Work2');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(renameSpy).toHaveBeenCalledTimes(1));
    expect(renameSpy).toHaveBeenCalledWith(1, 'Work2');
  });
});
