import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import '@testing-library/jest-dom'
import { ContactsTab } from './ContactsTab'

vi.stubGlobal('fetch', vi.fn(() =>
  Promise.resolve({ ok: true, json: () => Promise.resolve([]) } as Response),
))

describe('ContactsTab', () => {
  it('renders the Contacts ledger heading', () => {
    render(<ContactsTab />)
    expect(screen.getByRole('heading', { name: /contacts ledger/i })).toBeInTheDocument()
  })
})
