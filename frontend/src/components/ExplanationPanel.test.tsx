/**
 * Component tests for ExplanationPanel — the structured per-field
 * categorisation explanation rendered inside EnrichmentSignalsDialog
 * (issue #230).
 *
 * Focus: render the right human-readable summary + attribution links for
 * each source (rule/manual/ai/import-default/fallback). The pure helper
 * (backend/src/util/transactionExplanation.ts) is tested separately.
 */
import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { ExplanationPanel } from './ExplanationPanel'
import type { TransactionExplanation } from '../types/api'

// Re-export React so the JSX runtime (configured by @vitejs/plugin-react) can
// reach it under the older classic transform used by this repo's tests.
void React

const baseExplanation: TransactionExplanation = {
  transactionId: 1,
  category: {
    source: 'fallback',
    value: null,
    message: 'No category yet — set one or accept an AI suggestion.',
  },
  split: {
    source: 'fallback',
    value: 'me',
    message: 'Split type is the default "me".',
  },
  business: {
    source: 'fallback',
    value: false,
    message: 'Defaults to "personal".',
  },
  notes: {
    source: 'none',
    value: null,
    message: 'No notes attached.',
  },
  review: {
    state: 'never-flagged',
    lastChangedAt: null,
    message: 'Never required review.',
  },
}

function renderPanel(over: Partial<TransactionExplanation> = {}) {
  return render(
    <MemoryRouter>
      <ExplanationPanel explanation={{ ...baseExplanation, ...over }} />
    </MemoryRouter>,
  )
}

describe('ExplanationPanel', () => {
  it('renders the fallback message for an uncategorised transaction', () => {
    renderPanel()
    expect(screen.getByText(/no category yet/i)).toBeInTheDocument()
    expect(screen.getByText(/no notes attached/i)).toBeInTheDocument()
    expect(screen.getByText(/never required review/i)).toBeInTheDocument()
  })

  it('renders rule attribution with a link to the rule when source=rule', () => {
    renderPanel({
      category: {
        source: 'rule',
        value: 'Groceries',
        message: 'Applied by rule "COSTCO" → Groceries.',
        appliedRule: {
          id: 42,
          merchantPattern: 'COSTCO',
          category: 'Groceries',
        },
      },
    })
    expect(screen.getByText(/applied by rule/i)).toBeInTheDocument()
    // Rule pattern surfaces as code text inside a link
    const link = screen.getByRole('link', { name: /COSTCO/i })
    expect(link).toBeInTheDocument()
    expect(link.getAttribute('href')).toContain('highlight=42')
  })

  it('renders manual edit attribution with actor display name + date', () => {
    renderPanel({
      category: {
        source: 'manual',
        value: 'Dining',
        message: 'Manually set to "Dining" by Connor on 2026-03-15.',
        overrideValue: 'Dining',
        autoValue: 'Groceries',
        manualEdit: {
          at: '2026-03-15T18:30:00.000Z',
          actorUserId: 7,
          actorDisplayName: 'Connor',
        },
      },
    })
    expect(screen.getByText(/last edited by connor on 2026-03-15/i)).toBeInTheDocument()
    // Surfaces the autoValue vs overrideValue contrast.
    expect(screen.getByText(/Auto-suggested:/)).toBeInTheDocument()
  })

  it('renders AI attribution with suggestion id and model when source=ai', () => {
    renderPanel({
      category: {
        source: 'ai',
        value: 'Subscriptions',
        message: 'AI suggested "Subscriptions" via gpt-4o-mini and you accepted it.',
        aiSuggestion: {
          id: 901,
          createdAt: '2026-04-01T12:00:00.000Z',
          status: 'accepted',
          model: 'gpt-4o-mini',
        },
      },
    })
    expect(screen.getByText(/AI suggestion #901/i)).toBeInTheDocument()
    // Model name appears in both message text and the AI-link line.
    expect(screen.getAllByText(/gpt-4o-mini/).length).toBeGreaterThanOrEqual(1)
  })

  it('renders import-default rationale when present', () => {
    renderPanel({
      category: {
        source: 'import-default',
        value: 'Coffee',
        message: 'Auto-categorised by import (memory).',
        autoSourceLabel: 'memory',
        signalRationale: 'Matched 3 prior reviewed transactions at this merchant',
      },
    })
    expect(
      screen.getByText(/matched 3 prior reviewed transactions/i),
    ).toBeInTheDocument()
  })

  it('renders the review state badge with the right label', () => {
    renderPanel({
      review: {
        state: 'needs-review',
        lastChangedAt: null,
        message: 'Flagged for review.',
      },
    })
    expect(screen.getByText(/needs review/i)).toBeInTheDocument()
    expect(screen.getByText(/flagged for review/i)).toBeInTheDocument()
  })
})
