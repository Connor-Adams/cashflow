import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/ui/page-header'
import { getJson } from '../lib/api'
import { formatMoney } from '../lib/formatMoney'
import type { Account, PartnerFairnessByCurrency, PartnerFairnessResponse } from '../types/api'

/**
 * Partner Home — a viewer-relative landing surface for a household member.
 * Everything here is projected to the logged-in user by the backend
 * (`GET /api/partner/fairness` keys shares off `created_by_user_id`), so each
 * partner sees their own side: "you owe" ↔ "owes you" mirror automatically.
 *
 * When nothing is shared yet (no `visibility='shared'` account), the page leads
 * with an onboarding nudge to the existing Accounts page rather than an empty
 * dashboard.
 */
function directionLabel(d: 'partner_owes_me' | 'i_owe_partner' | 'even'): string {
  if (d === 'partner_owes_me') return 'Partner owes you'
  if (d === 'i_owe_partner') return 'You owe partner'
  return 'Settled up'
}

function balanceTone(d: 'partner_owes_me' | 'i_owe_partner' | 'even'): string {
  if (d === 'partner_owes_me') return 'text-positive'
  if (d === 'i_owe_partner') return 'text-negative'
  return 'text-muted-foreground'
}

function CurrencyCard({ data }: { data: PartnerFairnessByCurrency }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{data.currency}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div>
          <p className="mb-1 text-sm text-muted-foreground">{directionLabel(data.direction)}</p>
          <p className={`mb-0 text-2xl font-semibold ${balanceTone(data.direction)}`}>
            {formatMoney(Math.abs(data.balance), data.currency)}
          </p>
        </div>
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-muted-foreground">Shared this month</dt>
            <dd className="mb-0 font-medium">
              {formatMoney(data.currentMonthSharedSpend, data.currency)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Shared transactions</dt>
            <dd className="mb-0 font-medium">{data.sharedTransactionCount}</dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  )
}

export function PartnerHomePage() {
  const navigate = useNavigate()
  const [fairness, setFairness] = useState<PartnerFairnessByCurrency[]>([])
  const [hasSharedAccount, setHasSharedAccount] = useState(false)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      getJson<PartnerFairnessResponse>('/api/partner/fairness'),
      getJson<Account[]>('/api/accounts'),
    ])
      .then(([f, accounts]) => {
        if (cancelled) return
        setFairness(f.byCurrency)
        setHasSharedAccount(accounts.some((a) => a.visibility === 'shared'))
        setErr(null)
      })
      .catch((e) => {
        if (cancelled) return
        setErr(e instanceof Error ? e.message : 'Could not load partner home.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div>
      <PageHeader
        title="Partner home"
        description="Your shared finances at a glance — balances shown from your side."
        actions={
          <Button variant="secondary" asChild>
            <Link to="/reports/partner">Full fairness dashboard</Link>
          </Button>
        }
      />

      {err ? (
        <Alert variant="error" className="mb-4">
          {err}
        </Alert>
      ) : null}

      {loading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}

      {!loading && !hasSharedAccount ? (
        <EmptyState
          title="Nothing shared yet"
          description="Share an account with your partner so they can see joint spending here. Your private accounts stay private."
          actions={<Button onClick={() => navigate('/accounts')}>Share an account</Button>}
        />
      ) : null}

      {!loading && hasSharedAccount && fairness.length === 0 ? (
        <EmptyState
          title="No shared spending yet"
          description="Once you split a transaction with your partner, the running balance shows up here."
          actions={<Button onClick={() => navigate('/transactions')}>Go to transactions</Button>}
        />
      ) : null}

      {fairness.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {fairness.map((c) => (
            <CurrencyCard key={c.currency} data={c} />
          ))}
        </div>
      ) : null}
    </div>
  )
}
