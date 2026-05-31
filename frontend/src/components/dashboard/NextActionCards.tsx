/**
 * Post-import next-action card deck (issue #274). Shows a horizontal strip of
 * up to 3 activation cards nudging the user toward the next setup step.
 * Hidden when all steps are complete.
 */
import { Link } from 'react-router-dom'
import { Target, BookOpen, Users, TrendingUp } from 'lucide-react'

type ActionCard = {
  icon: React.ElementType
  title: string
  body: string
  cta: string
  to: string
}

type Props = {
  hasBudgets: boolean
  hasGoals: boolean
  reviewCount: number
  hasPartner: boolean
}

export function NextActionCards({ hasBudgets, hasGoals, reviewCount, hasPartner }: Props) {
  const cards: ActionCard[] = []

  if (reviewCount > 0) {
    cards.push({
      icon: BookOpen,
      title: `${reviewCount} transaction${reviewCount === 1 ? '' : 's'} need review`,
      body: 'Categorize or flag transactions to keep your data clean.',
      cta: 'Review now',
      to: '/review',
    })
  }

  if (!hasBudgets) {
    cards.push({
      icon: Target,
      title: 'Set a budget',
      body: 'Track spending against targets and get alerts when you approach limits.',
      cta: 'Create budget',
      to: '/settings/budgets',
    })
  }

  if (!hasGoals) {
    cards.push({
      icon: TrendingUp,
      title: 'Add a financial goal',
      body: 'Track progress toward an emergency fund, down payment, or any savings target.',
      cta: 'Add goal',
      to: '/goals',
    })
  }

  if (!hasPartner) {
    cards.push({
      icon: Users,
      title: 'Invite your partner',
      body: 'Share your household to track finances together.',
      cta: 'Invite',
      to: '/settings/members',
    })
  }

  if (cards.length === 0) return null

  const visible = cards.slice(0, 3)

  return (
    <div
      className="mb-4 grid gap-3"
      style={{ gridTemplateColumns: `repeat(${visible.length}, 1fr)` }}
      aria-label="Suggested next actions"
    >
      {visible.map((card) => {
        const Icon = card.icon
        return (
          <Link
            key={card.to}
            to={card.to}
            className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4 shadow-sm hover:bg-accent/40 transition-colors"
          >
            <div className="flex items-center gap-2">
              <Icon className="h-4 w-4 text-primary shrink-0" aria-hidden="true" />
              <span className="text-sm font-semibold">{card.title}</span>
            </div>
            <p className="text-xs text-muted-foreground">{card.body}</p>
            <span className="mt-auto text-xs font-medium text-primary">{card.cta} →</span>
          </Link>
        )
      })}
    </div>
  )
}
