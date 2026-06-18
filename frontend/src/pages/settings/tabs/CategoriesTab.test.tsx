import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CategoriesTab } from './CategoriesTab'
import * as api from '../../../lib/api'
import { _resetCategoriesCacheForTest } from '../../../lib/useCategories'

type FlatCat = { id: number; householdId: number; name: string; icon: string | null; taxTreatment: string; createdAt: string; updatedAt: string }
type TreeCat = { id: number; name: string; parentId: number | null; icon: string | null; taxTreatment: string; children: TreeCat[] }

function mockApis(flat: FlatCat[], tree: TreeCat[]) {
  vi.spyOn(api, 'getJson').mockImplementation((path: string) => {
    if (path === '/api/categories/tree') return Promise.resolve(tree) as never
    return Promise.resolve(flat) as never
  })
}

describe('CategoriesTab', () => {
  beforeEach(() => {
    _resetCategoriesCacheForTest()
    vi.restoreAllMocks()
  })

  it('clicking a tree row icon opens the edit dialog and PATCHes the icon', async () => {
    const flat: FlatCat[] = [
      { id: 1, householdId: 1, name: 'Coffee', icon: null, taxTreatment: 'none', createdAt: '', updatedAt: '' },
    ]
    mockApis(flat, [{ id: 1, name: 'Coffee', parentId: null, icon: null, taxTreatment: 'none', children: [] }])
    const patchSpy = vi.spyOn(api, 'patchJson').mockResolvedValue({ ...flat[0], icon: 'Coffee' })
    render(<CategoriesTab />)
    await waitFor(() => screen.getByText('Coffee'))

    await userEvent.click(screen.getByRole('button', { name: /edit icon and tax for Coffee/i }))
    const dialog = await screen.findByRole('dialog')
    // pick the Coffee icon cell inside the picker grid (scoped to the dialog)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Coffee' }))
    await waitFor(() => {
      expect(patchSpy).toHaveBeenCalledWith('/api/categories/1', { icon: 'Coffee' })
    })
  })

  it('changing tax treatment in the dialog PATCHes the category', async () => {
    const flat: FlatCat[] = [
      { id: 1, householdId: 1, name: 'Coffee', icon: null, taxTreatment: 'none', createdAt: '', updatedAt: '' },
    ]
    mockApis(flat, [{ id: 1, name: 'Coffee', parentId: null, icon: null, taxTreatment: 'none', children: [] }])
    const patchSpy = vi.spyOn(api, 'patchJson').mockResolvedValue({ ...flat[0], taxTreatment: 'donations' })
    render(<CategoriesTab />)
    await waitFor(() => screen.getByText('Coffee'))

    await userEvent.click(screen.getByRole('button', { name: /edit icon and tax for Coffee/i }))
    const select = screen.getByRole('combobox', { name: /tax treatment for Coffee/i })
    await userEvent.selectOptions(select, 'donations')

    await waitFor(() => {
      expect(patchSpy).toHaveBeenCalledWith('/api/categories/1', { taxTreatment: 'donations' })
    })
  })

  it('renders the category tree', async () => {
    mockApis(
      [{ id: 1, householdId: 1, name: 'Coffee', icon: null, taxTreatment: 'none', createdAt: '', updatedAt: '' }],
      [{ id: 1, name: 'Coffee', parentId: null, icon: null, taxTreatment: 'none', children: [] }],
    )
    render(<CategoriesTab />)
    await waitFor(() => screen.getByRole('button', { name: /edit icon and tax for Coffee/i }))
  })
})
