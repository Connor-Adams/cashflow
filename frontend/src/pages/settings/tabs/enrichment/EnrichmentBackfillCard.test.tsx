import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { EnrichmentBackfillCard } from './EnrichmentBackfillCard'
import { ToastProvider } from '@/components/ui/toast'

describe('EnrichmentBackfillCard', () => {
  it('renders title, description, and admin pill', () => {
    render(
      <ToastProvider>
        <EnrichmentBackfillCard onComplete={() => undefined} />
      </ToastProvider>,
    )
    expect(screen.getByRole('heading', { name: /backfill enrichment/i })).toBeInTheDocument()
    expect(screen.getByText(/admin action/i)).toBeInTheDocument()
    expect(screen.getByText(/re-runs the import enrichment pipeline/i)).toBeInTheDocument()
  })

  it('exposes Dry run and Run backfill buttons', () => {
    render(
      <ToastProvider>
        <EnrichmentBackfillCard onComplete={() => undefined} />
      </ToastProvider>,
    )
    expect(screen.getByRole('button', { name: /dry run/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /run backfill/i })).toBeInTheDocument()
  })

  it('exposes both toggle checkboxes and the row-limit input', () => {
    render(
      <ToastProvider>
        <EnrichmentBackfillCard onComplete={() => undefined} />
      </ToastProvider>,
    )
    expect(screen.getByLabelText(/clear review flag/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/only re-process rows currently in review/i)).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/all rows/i)).toBeInTheDocument()
  })

  it('toggling review-only mode flips the checkbox state', () => {
    render(
      <ToastProvider>
        <EnrichmentBackfillCard onComplete={() => undefined} />
      </ToastProvider>,
    )
    const cb = screen.getByLabelText(/only re-process rows currently in review/i) as HTMLInputElement
    expect(cb.checked).toBe(false)
    fireEvent.click(cb)
    expect(cb.checked).toBe(true)
  })
})
