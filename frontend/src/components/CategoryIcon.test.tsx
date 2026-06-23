import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { CategoryIcon } from './CategoryIcon'
import * as api from '../lib/api'
import { _resetCategoriesCacheForTest } from '../lib/useCategories'

describe('CategoryIcon', () => {
  beforeEach(() => {
    _resetCategoriesCacheForTest()
    vi.restoreAllMocks()
  })

  it('renders the DS icon mapped to the category', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue([
      { id: 1, householdId: 1, name: 'Coffee', icon: 'Coffee',
        createdAt: '', updatedAt: '' },
    ])
    const { container } = render(<CategoryIcon name="Coffee" />)
    await waitFor(() => {
      expect(container.querySelector('[data-icon="Coffee"]')).toBeInTheDocument()
    })
  })

  it('renders fallback Tag icon for unknown category', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue([])
    const { container } = render(<CategoryIcon name="Unknown" />)
    await waitFor(() => {
      expect(container.querySelector('[data-icon="Tag"]')).toBeInTheDocument()
    })
  })

  it('renders fallback Tag when category exists but icon is null', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue([
      { id: 1, householdId: 1, name: 'Rent', icon: null,
        createdAt: '', updatedAt: '' },
    ])
    const { container } = render(<CategoryIcon name="Rent" />)
    await waitFor(() => {
      expect(container.querySelector('[data-icon="Tag"]')).toBeInTheDocument()
    })
  })

  it('renders nothing when name is null', () => {
    const { container } = render(<CategoryIcon name={null} />)
    expect(container).toBeEmptyDOMElement()
  })
})
