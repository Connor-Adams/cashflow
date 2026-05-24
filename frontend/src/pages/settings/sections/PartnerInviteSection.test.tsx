import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { PartnerInviteSection } from './PartnerInviteSection'

vi.stubGlobal('fetch', vi.fn(() =>
  Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response),
))

describe('PartnerInviteSection', () => {
  it('renders the heading', () => {
    render(<PartnerInviteSection />)
    expect(screen.getByRole('heading', { name: /partner invite/i })).toBeInTheDocument()
  })
})
