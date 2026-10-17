/**
 * The total never appears without its caveat, and an affirmative report is
 * distinguishable from an unattempted one.
 *
 * "My personal tax looks too low" was investigated three times, and each time the
 * answer was that the data was incomplete while the tab displayed a clean, confident
 * number. This panel exists so that cannot happen silently again.
 *
 * Deliberately no modal and no blocking interstitial: the number stays readable, it
 * just never appears without what is missing from it.
 */
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import type { CompletenessItemDto, CompletenessReportDto } from '@cashflow/shared'
import { CompletenessPanel } from './CompletenessPanel'

function item(over: Partial<CompletenessItemDto> = {}): CompletenessItemDto {
  return {
    kind: 'unclassified_corp_draws',
    severity: 'blocker',
    title: '3 corp→personal transfers not classified',
    detail: '$42,000 moved from the corporation to you and is not on the return.',
    amount: '42000.00',
    taxEstimate: '4227.00',
    fix: { surface: 'classify', label: 'Classify these draws' },
    references: [1, 2, 3],
    ...over,
  }
}

function report(over: Partial<CompletenessReportDto> = {}): CompletenessReportDto {
  return {
    status: 'complete',
    checkedAt: '2026-09-29T12:00:00.000Z',
    coverageThrough: '2026-09-25',
    blockers: [],
    gaps: [],
    ...over,
  }
}

const renderPanel = (r: CompletenessReportDto, onNavigate = vi.fn()) => {
  render(
    <MemoryRouter>
      <CompletenessPanel report={r} onNavigate={onNavigate} />
    </MemoryRouter>,
  )
  return onNavigate
}

describe('CompletenessPanel', () => {
  it('states affirmatively that the year is complete, with the coverage date', () => {
    // "No warnings" and "nobody checked" must not look the same. This is why the
    // complete case renders at all rather than collapsing to nothing.
    renderPanel(report())
    expect(screen.getByText(/complete/i)).toBeInTheDocument()
    expect(screen.getByText(/2026-09-25/)).toBeInTheDocument()
  })

  it('says so when there is nothing to cover rather than implying a clean year', () => {
    renderPanel(report({ coverageThrough: null }))
    expect(screen.getByText(/no transactions/i)).toBeInTheDocument()
  })

  it('renders a blocker with its amount and tax estimate', () => {
    renderPanel(report({ status: 'blocked', blockers: [item()] }))
    expect(screen.getByText(/3 corp→personal transfers not classified/)).toBeInTheDocument()
    expect(screen.getByText(/\$42,000\.00/)).toBeInTheDocument()
    expect(screen.getByText(/\$4,227\.00/)).toBeInTheDocument()
  })

  it('renders no tax figure when the item carries none', () => {
    // The outbound-corp-transfer blocker. Its character is unknown, so pricing it
    // would put an invented number on the return — the panel must not fill the gap
    // with a placeholder or a zero.
    renderPanel(report({
      status: 'blocked',
      blockers: [item({
        kind: 'unimported_outbound_corp_transfer',
        title: '1 corp transfer with no imported counterpart',
        amount: '15000.00',
        taxEstimate: null,
      })],
    }))
    expect(screen.getByText(/\$15,000\.00/)).toBeInTheDocument()
    // Specifically the "of tax" figure, not the word anywhere in the detail prose.
    expect(screen.queryByText(/of tax/)).not.toBeInTheDocument()
  })

  it('renders neither figure when the item carries neither', () => {
    renderPanel(report({
      status: 'gaps',
      gaps: [item({
        kind: 'missing_t5',
        severity: 'gap',
        title: 'Dividend income with no T5 entered',
        // The detail prose is replaced too: the default fixture's text contains a
        // dollar figure, and asserting "no $ anywhere" would then fail on the prose
        // rather than on a rendered figure.
        detail: 'The slip reconciles what the corporation declared against what moved.',
        amount: null,
        taxEstimate: null,
        references: [],
      })],
    }))
    expect(screen.getByText(/Dividend income with no T5 entered/)).toBeInTheDocument()
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument()
    expect(screen.queryByText(/of tax/)).not.toBeInTheDocument()
  })

  it('separates blockers from gaps, blockers first', () => {
    renderPanel(report({
      status: 'blocked',
      blockers: [item({ title: 'A blocker' })],
      gaps: [item({ severity: 'gap', title: 'A gap', amount: null, taxEstimate: null })],
    }))
    const blocker = screen.getByText('A blocker')
    const gap = screen.getByText('A gap')
    expect(blocker.compareDocumentPosition(gap) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('a fix that lives on another tab calls onNavigate with that tab', async () => {
    const onNavigate = renderPanel(report({ status: 'blocked', blockers: [item()] }))
    await userEvent.click(screen.getByRole('button', { name: /Classify these draws/ }))
    expect(onNavigate).toHaveBeenCalledWith('classify')
  })

  it('a fix that lives on another page is a link, not a button', () => {
    renderPanel(report({
      status: 'blocked',
      blockers: [item({
        fix: { surface: 'import', label: 'Import the matching statements' },
      })],
    }))
    const link = screen.getByRole('link', { name: /Import the matching statements/ })
    expect(link).toHaveAttribute('href', '/accounts/statements')
  })

  it('an item with no destination shows no action rather than a dead link', () => {
    // The projected-rate-table gap is fixed by editing a source file. Offering a
    // link to nowhere is worse than offering none.
    renderPanel(report({
      status: 'gaps',
      gaps: [item({
        kind: 'projected_rate_table',
        severity: 'gap',
        title: '2027 rates are projected',
        amount: null,
        taxEstimate: null,
        fix: { surface: 'rates', label: 'Verify the 2027 rate table' },
      })],
    }))
    expect(screen.queryByRole('button', { name: /Verify the 2027 rate table/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Verify the 2027 rate table/ })).not.toBeInTheDocument()
    // The item itself is still shown — it is not silently dropped.
    expect(screen.getByText(/2027 rates are projected/)).toBeInTheDocument()
  })

  it('shows the count of references so the size of the job is visible', () => {
    renderPanel(report({ status: 'blocked', blockers: [item({ references: [1, 2, 3] })] }))
    expect(screen.getByText(/3 transactions/)).toBeInTheDocument()
  })
})
