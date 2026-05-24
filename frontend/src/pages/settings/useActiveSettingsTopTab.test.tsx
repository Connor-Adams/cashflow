import React from 'react'
import { renderHook } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect } from 'vitest'
import { useActiveSettingsTopTab } from './useActiveSettingsTopTab'

function wrapper(initialPath: string) {
  return ({ children }: { children: React.ReactNode }) => (
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/settings/*" element={<>{children}</>} />
      </Routes>
    </MemoryRouter>
  )
}

describe('useActiveSettingsTopTab', () => {
  it.each([
    ['/settings/display', 'settings'],
    ['/settings/gmail', 'settings'],
    ['/settings/partner-invite', 'settings'],
    ['/settings/imports', 'imports'],
    ['/settings/enrichment', 'enrichment'],
    ['/settings/contacts', 'contacts'],
    ['/settings/budgets', 'budgets'],
  ])('maps %s to %s', (path, expected) => {
    const { result } = renderHook(() => useActiveSettingsTopTab(), {
      wrapper: wrapper(path),
    })
    expect(result.current).toBe(expected)
  })
})
