import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { ImportsTab } from './ImportsTab'

vi.stubGlobal('fetch', vi.fn(() =>
  Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response),
))

describe('ImportsTab', () => {
  it('renders both Import receipts and Receipt capture headings', () => {
    render(<ImportsTab />)
    expect(screen.getByRole('heading', { name: /import receipts/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /receipt capture/i })).toBeInTheDocument()
  })
})
