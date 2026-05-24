import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { GmailSection } from './GmailSection'

vi.stubGlobal('fetch', vi.fn(() =>
  Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response),
))

describe('GmailSection', () => {
  it('renders the Connect Gmail heading', () => {
    render(<GmailSection />)
    expect(screen.getByRole('heading', { name: /connect gmail/i })).toBeInTheDocument()
  })
})
