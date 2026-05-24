import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { AiInboxPage } from './AiInboxPage'

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('AiInboxPage', () => {
  it('renders an empty state when there are no items', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), { status: 200 }),
    )
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AiInboxPage />
      </MemoryRouter>,
    )
    expect(html).toContain('AI Inbox')
  })
})
