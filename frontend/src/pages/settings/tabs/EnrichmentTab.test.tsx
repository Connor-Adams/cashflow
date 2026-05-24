import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { EnrichmentTab } from './EnrichmentTab'

vi.stubGlobal('fetch', vi.fn(() =>
  Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response),
))

describe('EnrichmentTab', () => {
  it('renders Enrichment maintenance and dashboard headings', () => {
    render(<EnrichmentTab />)
    expect(screen.getByRole('heading', { name: /enrichment maintenance/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /enrichment dashboard/i })).toBeInTheDocument()
  })
})
