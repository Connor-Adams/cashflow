// frontend/src/pages/settings/tabs/CategoryTreeCollapse.test.tsx
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

describe('CategoryTreeManager collapse/expand', () => {
  beforeEach(() => {
    _resetCategoriesCacheForTest();
    vi.restoreAllMocks();
    vi.spyOn(catApi, 'getCategoryTree').mockResolvedValue(tree);
    vi.spyOn(api, 'getJson').mockResolvedValue([]);
  });

  it('children render expanded by default, collapse hides them, expand shows again', async () => {
    render(<CategoryTreeManager />);
    await waitFor(() => screen.getByText('Work'));
    expect(screen.getByText('Internet')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /collapse Work/i }));
    expect(screen.queryByText('Internet')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /expand Work/i }));
    expect(screen.getByText('Internet')).toBeInTheDocument();
  });

  it('leaf nodes expose no expand/collapse control', async () => {
    render(<CategoryTreeManager />);
    await waitFor(() => screen.getByText('Internet'));
    expect(screen.queryByRole('button', { name: /collapse Internet/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /expand Internet/i })).not.toBeInTheDocument();
  });
});
