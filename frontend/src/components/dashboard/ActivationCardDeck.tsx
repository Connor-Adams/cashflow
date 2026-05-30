import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getJson, postJson } from '@/lib/api'

type ActivationState = {
  hasAccounts: boolean
  unreviewedCount: number
  hasBudget: boolean
  hasGoal: boolean
  hasOutboundInvite: boolean
  dismissedCards: string[]
}

type CardId = 'import' | 'review' | 'budget' | 'goal' | 'invite'

type CardDef = {
  id: CardId
  headline: string
  body: (state: ActivationState) => string
  ctaLabel: string
  ctaPath: string
  visible: (state: ActivationState) => boolean
}

const CARD_DEFS: CardDef[] = [
  {
    id: 'import',
    headline: 'Import your first statement',
    body: () =>
      'Cashflow turns your statements into a clear picture of where your money goes.',
    ctaLabel: 'Import',
    ctaPath: '/import',
    visible: (s) => !s.hasAccounts,
  },
  {
    id: 'review',
    headline: 'Review imported transactions',
    body: (s) =>
      `We found ${s.unreviewedCount} transaction${s.unreviewedCount === 1 ? '' : 's'} that need${s.unreviewedCount === 1 ? 's' : ''} a category. Two minutes to clean up.`,
    ctaLabel: 'Review',
    ctaPath: '/review',
    visible: (s) => s.hasAccounts && s.unreviewedCount > 0,
  },
  {
    id: 'budget',
    headline: 'Set your first budget',
    body: () =>
      "Tell us what you want to spend in each category. We'll alert you if you stray.",
    ctaLabel: 'Set a budget',
    ctaPath: '/settings/budgets',
    visible: (s) => s.hasAccounts && !s.hasBudget,
  },
  {
    id: 'goal',
    headline: 'Set a financial goal',
    body: () => 'Saving for something specific? Track it here.',
    ctaLabel: 'Add a goal',
    ctaPath: '/goals',
    visible: (s) => s.hasAccounts && !s.hasGoal,
  },
  {
    id: 'invite',
    headline: 'Invite a household member',
    body: () =>
      'Share Cashflow with a partner, spouse, or accountant.',
    ctaLabel: 'Send invite',
    ctaPath: '/settings/members',
    visible: (s) => s.hasAccounts && !s.hasOutboundInvite,
  },
]

/**
 * Dashboard next-action card deck (#274). Fetches activation state on mount
 * and renders a horizontal row of cards for incomplete onboarding steps.
 * Each card is independently dismissable. Renders nothing when all cards
 * are hidden (dismissed or already done).
 */
export function ActivationCardDeck() {
  const navigate = useNavigate()
  const [state, setState] = useState<ActivationState | null>(null)
  const [localDismissed, setLocalDismissed] = useState<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    getJson<ActivationState>('/api/activation-state')
      .then((data) => {
        if (!cancelled) setState(data)
      })
      .catch(() => {
        // Silent failure — card deck simply doesn't render
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (!state) return null

  const isDismissed = (id: string): boolean =>
    localDismissed.has(id) || (state.dismissedCards ?? []).includes(id)

  const visibleCards = CARD_DEFS.filter(
    (card) => card.visible(state) && !isDismissed(card.id),
  )

  if (visibleCards.length === 0) return null

  function handleDismiss(id: CardId) {
    // Optimistically hide the card
    setLocalDismissed((prev) => new Set([...prev, id]))
    // Persist in background — ignore errors
    postJson('/api/activation-state/dismiss-card', { cardId: id }).catch(() => {})
  }

  return (
    <div
      className="mb-4 flex gap-3 overflow-x-auto pb-1"
      aria-label="Next steps"
    >
      {visibleCards.map((card) => (
        <article
          key={card.id}
          className="relative flex shrink-0 flex-col gap-3 rounded-xl border p-4"
          style={{
            width: '280px',
            background: 'var(--card)',
            borderColor: 'var(--border)',
            boxShadow: 'var(--shadow)',
          }}
        >
          <button
            type="button"
            aria-label={`Dismiss ${card.headline}`}
            onClick={() => handleDismiss(card.id)}
            className="absolute right-2 top-2 flex size-6 items-center justify-center rounded-full text-sm opacity-50 hover:opacity-100"
            style={{ color: 'var(--muted-foreground)' }}
          >
            ×
          </button>
          <div className="flex flex-col gap-1 pr-6">
            <h3
              className="text-sm font-semibold leading-snug"
              style={{ color: 'var(--foreground)' }}
            >
              {card.headline}
            </h3>
            <p
              className="text-xs leading-relaxed"
              style={{ color: 'var(--muted-foreground)' }}
            >
              {card.body(state)}
            </p>
          </div>
          <button
            type="button"
            onClick={() => navigate(card.ctaPath)}
            className="mt-auto w-fit rounded-lg px-3 py-1.5 text-xs font-semibold transition-opacity hover:opacity-90"
            style={{
              background: 'var(--primary)',
              color: 'var(--primary-foreground)',
            }}
          >
            {card.ctaLabel}
          </button>
        </article>
      ))}
    </div>
  )
}
