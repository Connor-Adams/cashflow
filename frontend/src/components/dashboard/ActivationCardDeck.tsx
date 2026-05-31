import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { getJson, postJson } from '../../lib/api'

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
  headline: string
  body: (state: ActivationState) => string
  cta: string
  to: string
  visible: (state: ActivationState) => boolean
}

const CARDS: CardDef[] = [
  {
    id: 'import',
    headline: 'Import your first statement',
    body: () => 'Cashflow turns your statements into a clear picture of where your money goes.',
    cta: 'Import',
    to: '/import',
    visible: (s) => !s.hasAccounts,
  },
  {
    id: 'review',
    headline: 'Review imported transactions',
    body: (s) =>
      `We found ${s.unreviewedCount} transaction${s.unreviewedCount === 1 ? '' : 's'} that need a category. Two minutes to clean up.`,
    cta: 'Review',
    to: '/review',
    visible: (s) => s.hasAccounts && s.unreviewedCount > 0,
  },
  {
    id: 'budget',
    headline: 'Set your first budget',
    body: () => "Tell us what you want to spend in each category. We'll alert you if you stray.",
    cta: 'Set a budget',
    to: '/settings/budgets',
    visible: (s) => s.hasAccounts && !s.hasBudget,
  },
  {
    id: 'goal',
    headline: 'Set a financial goal',
    body: () => 'Saving for something specific? Track it here.',
    cta: 'Add a goal',
    to: '/goals',
    visible: (s) => s.hasAccounts && !s.hasGoal,
  },
  {
    id: 'invite',
    headline: 'Invite a household member',
    body: () => 'Share Cashflow with a partner, spouse, or accountant.',
    cta: 'Send invite',
    to: '/settings/members',
    visible: (s) => s.hasAccounts && !s.hasOutboundInvite,
  },
]

export function ActivationCardDeck() {
  const [state, setState] = useState<ActivationState | null>(null)
  const [dismissing, setDismissing] = useState<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    getJson<ActivationState>('/api/activation-state')
      .then((data) => { if (!cancelled) setState(data) })
      .catch(() => { /* hide silently on error */ })
    return () => { cancelled = true }
  }, [])

  async function dismiss(cardId: string) {
    setDismissing((prev) => new Set(prev).add(cardId))
    try {
      await postJson('/api/activation-state/dismiss-card', { cardId })
      setState((prev) =>
        prev ? { ...prev, dismissedCards: [...prev.dismissedCards, cardId] } : prev,
      )
    } catch {
      // noop — optimistically removed from view
    } finally {
      setDismissing((prev) => {
        const next = new Set(prev)
        next.delete(cardId)
        return next
      })
    }
  }

  if (!state) return null

  const visible = CARDS.filter(
    (c) => c.visible(state) && !state.dismissedCards.includes(c.id),
  )
  if (visible.length === 0) return null

  return (
    <section aria-label="Next actions" className="mb-4">
      <div className="flex gap-3 overflow-x-auto pb-1">
        {visible.map((card) => (
          <Card
            key={card.id}
            className="relative flex-shrink-0 w-64 p-4 flex flex-col gap-2"
          >
            <button
              type="button"
              aria-label={`Dismiss "${card.headline}"`}
              onClick={() => void dismiss(card.id)}
              disabled={dismissing.has(card.id)}
              className="absolute top-2 right-2 text-muted-foreground hover:text-foreground"
            >
              <X size={14} />
            </button>
            <p className="text-sm font-semibold pr-4">{card.headline}</p>
            <p className="text-xs text-muted-foreground flex-1">{card.body(state)}</p>
            <Link to={card.to}>
              <Button type="button" size="sm" className="w-full mt-1">
                {card.cta}
              </Button>
            </Link>
          </Card>
        ))}
      </div>
    </section>
  )
}
