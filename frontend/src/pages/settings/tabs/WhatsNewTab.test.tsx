import React from 'react'
import { render, screen } from '@testing-library/react'
import { it, expect, vi, beforeEach } from 'vitest'
import * as api from '@/lib/api'
import { WhatsNewTab } from './WhatsNewTab'

beforeEach(() => {
  vi.restoreAllMocks()
})

it('renders overview and feed entries', async () => {
  vi.spyOn(api, 'getJson').mockImplementation((path: string) => {
    if (path === '/api/changelog/overview') {
      return Promise.resolve({ html: '<p>The whole app</p>', updatedAt: 'x' }) as never
    }
    return Promise.resolve({
      entries: [
        { version: 'v0.13.52', title: 'Newer', publishedAt: '2026-05-30T01:22:39Z', html: '<p>new</p>' },
        { version: 'v0.13.51', title: 'Older', publishedAt: '2026-05-28T20:33:35Z', html: '<p>old</p>' },
      ],
    }) as never
  })

  render(<WhatsNewTab />)

  expect(await screen.findByText('The whole app')).toBeInTheDocument()
  expect(screen.getByText('Newer')).toBeInTheDocument()
  expect(screen.getByText('Older')).toBeInTheDocument()
})

it('shows empty state when there is nothing', async () => {
  vi.spyOn(api, 'getJson').mockImplementation((path: string) => {
    if (path === '/api/changelog/overview') return Promise.resolve({ empty: true }) as never
    return Promise.resolve({ entries: [] }) as never
  })
  render(<WhatsNewTab />)
  expect(await screen.findByText(/no release notes yet/i)).toBeInTheDocument()
})
