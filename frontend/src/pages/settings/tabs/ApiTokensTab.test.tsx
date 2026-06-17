import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { ApiTokensTab } from './ApiTokensTab'

vi.mock('./AuditTokensTab', () => ({ AuditTokensTab: () => <div>audit-tokens-marker</div> }))
vi.mock('./ReportingTokensTab', () => ({ ReportingTokensTab: () => <div>reporting-tokens-marker</div> }))

describe('ApiTokensTab', () => {
  it('renders both the audit-tokens and reporting-tokens sections', () => {
    render(<ApiTokensTab />)
    expect(screen.getByText('audit-tokens-marker')).toBeInTheDocument()
    expect(screen.getByText('reporting-tokens-marker')).toBeInTheDocument()
  })
})
