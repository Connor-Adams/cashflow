import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@connor-adams/designsystem'
import { getJson, postJson } from '@/lib/api'

type ActivationState = {
  hasAccounts: boolean
  unreviewedCount: number
  hasBudget: boolean
  hasGoal: boolean
  hasOutboundInvite: boolean
  dismissedCards: string[]
}

type CardDef = {
  id: string
  title: string
  description: string
  href: string
  cta: string
  done: (s: ActivationState) => boolean
}

const CARDS: CardDef[] = [
  {
    id: 'import',
    title: 'Import your first transactions',
    description: 'Upload a bank CSV or connect an account to start tracking.',
    href: '/import',
    cta: 'Go to Import',
    done: (s) => s.hasAccounts,
  },
  {
    id: 'review',
    title: 'Review flagged transactions',
    description: 'A few transactions need your attention before totals finalize.',
    href: '/review',
    cta: 'Open Review Inbox',
    done: (s) => s.unreviewedCount === 0,
  },
  {
    id: 'budget',
    title: 'Create your first budget',
    description: 'Set spending targets and track pacing on the dashboard.',
    href: '/budgets',
    cta: 'Set up a budget',
    done: (s) => s.hasBudget,
  },
  {
    id: 'goal',
    title: 'Add a financial goal',
    description: 'Track savings targets, debt payoff, or any custom milestone.',
    href: '/goals',
    cta: 'Add a goal',
    done: (s) => s.hasGoal,
  },
  {
    id: 'invite',
    title: 'Invite a partner or family member',
    description: 'Share your household for joint budgeting and fair-share tracking.',
    href: '/settings/household',
    cta: 'Send invite',
    done: (s) => s.hasOutboundInvite,
  },
]

export function ActivationCardDeck() {
  const [state, setState] = useState<ActivationState | null>(null)

  useEffect(() => {
    void getJson<ActivationState>('/api/activation-state')
      .then(setState)
      .catch(() => setState(null))
  }, [])

  const dismiss = useCallback(async (cardId: string) => {
    try {
      await postJson('/api/activation-state/dismiss-card', { cardId })
      setState((prev) =>
        prev ? { ...prev, dismissedCards: [...prev.dismissedCards, cardId] } : prev
      )
    } catch {
      // ignore
    }
  }, [])

  if (!state) return null

  const visible = CARDS.filter(
    (c) => !state.dismissedCards.includes(c.id) && !c.done(state)
  )
  if (visible.length === 0) return null

  return (
    <div
      className="mb-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"
      aria-label="Getting started"
    >
      {visible.map((card) => (
        <article
          key={card.id}
          className="relative rounded-xl border border-border bg-card p-4 shadow-sm"
        >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Dismiss ${card.title}`}
            onClick={() => void dismiss(card.id)}
            className="absolute right-3 top-3"
          >
            ×
          </Button>
          <h3 className="mb-1 pr-6 text-sm font-semibold">{card.title}</h3>
          <p className="mb-3 text-xs text-muted-foreground">{card.description}</p>
          <Link
            to={card.href}
            className="inline-flex items-center rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-brand-foreground hover:opacity-90"
          >
            {card.cta}
          </Link>
        </article>
      ))}
    </div>
  )
}
