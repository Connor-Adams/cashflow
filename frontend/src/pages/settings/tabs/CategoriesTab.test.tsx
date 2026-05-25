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
        createdAt: '', updatedAt: '' },
      { id: 2, householdId: 1, name: 'Rent', icon: 'Home',
        createdAt: '', updatedAt: '' },
    ]
    vi.spyOn(api, 'getJson').mockResolvedValue(list)
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
})
