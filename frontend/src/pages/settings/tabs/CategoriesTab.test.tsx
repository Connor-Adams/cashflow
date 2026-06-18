import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CategoriesTab } from './CategoriesTab'
import * as api from '../../../lib/api'
import { _resetCategoriesCacheForTest } from '../../../lib/useCategories'

describe('CategoriesTab', () => {
  beforeEach(() => {
    _resetCategoriesCacheForTest()
    vi.restoreAllMocks()
  })

  it('lists categories and opens picker to PATCH icon', async () => {
    const list = [
      { id: 1, householdId: 1, name: 'Coffee', icon: null,
        taxTreatment: 'none', createdAt: '', updatedAt: '' },
      { id: 2, householdId: 1, name: 'Rent', icon: 'Home',
        taxTreatment: 'none', createdAt: '', updatedAt: '' },
    ]
    vi.spyOn(api, 'getJson').mockImplementation((path: string) => {
      if (path === '/api/categories/tree') return Promise.resolve([]) as never;
      return Promise.resolve(list) as never;
    })
    const patchSpy = vi
      .spyOn(api, 'patchJson')
      .mockResolvedValue({ ...list[0], icon: 'Coffee' })
    render(<CategoriesTab />)
    await waitFor(() => screen.getByText('Coffee'))
    await waitFor(() => screen.getByText('Rent'))

    await userEvent.click(
      screen.getByRole('button', { name: /edit icon for Coffee/i })
    )
    // Picker opens — click the Coffee cell inside the picker grid
    await userEvent.click(await screen.findByRole('button', { name: 'Coffee' }))
    await waitFor(() => {
      expect(patchSpy).toHaveBeenCalledWith('/api/categories/1', { icon: 'Coffee' })
    })
  })

  it('changing tax treatment patches the category', async () => {
    const list = [
      { id: 1, householdId: 1, name: 'Coffee', icon: null,
        taxTreatment: 'none', createdAt: '', updatedAt: '' },
    ]
    vi.spyOn(api, 'getJson').mockImplementation((path: string) => {
      if (path === '/api/categories/tree') return Promise.resolve([]) as never;
      return Promise.resolve(list) as never;
    })
    const patchSpy = vi
      .spyOn(api, 'patchJson')
      .mockResolvedValue({ ...list[0], taxTreatment: 'donations' })
    render(<CategoriesTab />)
    await waitFor(() => screen.getByText('Coffee'))

    const select = screen.getByRole('combobox', { name: /tax treatment for Coffee/i })
    await userEvent.selectOptions(select, 'donations')

    await waitFor(() => {
      expect(patchSpy).toHaveBeenCalledWith('/api/categories/1', { taxTreatment: 'donations' })
    })
  })

  it('renders the tree manager alongside icon/tax editing', async () => {
    const list = [{ id: 1, householdId: 1, name: 'Coffee', icon: null, taxTreatment: 'none', createdAt: '', updatedAt: '' }];
    vi.spyOn(api, 'getJson').mockImplementation((path: string) => {
      if (path === '/api/categories/tree') return Promise.resolve([{ id: 1, name: 'Coffee', parentId: null, icon: null, taxTreatment: 'none', children: [] }]) as never;
      return Promise.resolve(list) as never;
    });
    render(<CategoriesTab />);
    // tree manager heading + the icon/tax control both present
    await waitFor(() => screen.getByText('Organize categories'));
    await waitFor(() => screen.getByRole('button', { name: /edit icon for Coffee/i }));
  });
})
