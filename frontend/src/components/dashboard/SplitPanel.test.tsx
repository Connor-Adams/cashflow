import React from 'react'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SplitPanel } from './SplitPanel'

describe('SplitPanel', () => {
  it('renders both toned figures and the share labels', () => {
    render(
      <SplitPanel business={3740} personal={6100} businessShare={38} currency="CAD" emptyCaption="No income in current filters." />,
    )
    expect(screen.getByText('Business')).toBeInTheDocument()
    expect(screen.getByText('Personal')).toBeInTheDocument()
    expect(screen.getByText(/Business 38%/)).toBeInTheDocument()
    expect(screen.getByText(/Personal 62%/)).toBeInTheDocument()
  })

  it('shows the empty caption when business + personal <= 0', () => {
    render(
      <SplitPanel business={0} personal={0} businessShare={0} currency="CAD" emptyCaption="No income in current filters." />,
    )
    expect(screen.getByText('No income in current filters.')).toBeInTheDocument()
  })

  it('hides the empty caption when there is value', () => {
    render(
      <SplitPanel business={100} personal={0} businessShare={100} currency="CAD" emptyCaption="No income in current filters." />,
    )
    expect(screen.queryByText('No income in current filters.')).not.toBeInTheDocument()
  })
})
