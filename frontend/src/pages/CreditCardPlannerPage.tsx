import { useCallback, useMemo, useState } from 'react'
import { CreditCard, CalendarClock, AlertTriangle, Pencil, Zap } from 'lucide-react'
import { Badge } from '@cashflow/ui'
import { Button } from '@cashflow/ui'
import { Card } from '@cashflow/ui'
import { EmptyState } from '@cashflow/ui'
import { Input } from '@cashflow/ui'
import { NativeSelect, NativeSelectOption } from '@cashflow/ui'
import { PageHeader } from '@/components/ui/page-header'
import { StatCard } from '@/components/ui/stat-card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@cashflow/ui'
import { useToast } from '@/components/ui/toast'
import { cn } from '@/lib/utils'
import { formatMoney } from '../lib/formatMoney'
import {
  useCreditCards,
  saveCardProfile,
  planCardPayment,
  markCardPaymentPaid,
} from '../hooks/useCreditCards'
import type { CreditCard as CreditCardType, CardPaymentStrategy } from '../types/api'

const STRATEGY_LABEL: Record<CardPaymentStrategy, string> = {
  statement: 'Statement balance',
  minimum: 'Minimum payment',
  current: 'Current balance',
}

/** Describe a due date for the warning badge. */
function dueLabel(card: CreditCardType): { text: string; tone: 'warn' | 'soon' | 'ok' } {
  if (card.daysUntilDue == null || card.nextDueDate == null) {
    return { text: 'No due date set', tone: 'ok' }
  }
  if (card.daysUntilDue === 0) return { text: 'Due today', tone: 'warn' }
  if (card.daysUntilDue < 0) return { text: 'Overdue', tone: 'warn' }
  if (card.dueSoon) return { text: `Due in ${card.daysUntilDue}d`, tone: 'soon' }
  return { text: `Due ${card.nextDueDate}`, tone: 'ok' }
}

export function CreditCardPlannerPage() {
  const { data, loading, error, refresh } = useCreditCards()

  const currency = data?.currency ?? 'CAD'
  const cards = useMemo(() => data?.cards ?? [], [data])

  const totalStatement = useMemo(
    () => cards.reduce((acc, c) => acc + (c.statementBalance ?? c.currentBalance), 0),
    [cards],
  )
  const totalMinimum = useMemo(
    () => cards.reduce((acc, c) => acc + c.minimumPayment, 0),
    [cards],
  )
  const dueSoonCount = useMemo(() => cards.filter((c) => c.dueSoon).length, [cards])

  return (
    <div className="page">
      <PageHeader
        title="Credit card payments"
        description="Track statement balances, due dates, minimum payments and autopay across your cards. Plan a payment into your forecast, then mark it paid when it clears."
      />

      {error ? (
        <EmptyState
          title="Could not load credit cards"
          description={error.message}
          actions={
            <Button size="sm" variant="outline" onClick={refresh}>
              Retry
            </Button>
          }
        />
      ) : null}

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryTile
          label="Cards"
          value={String(cards.length)}
          loading={loading}
        />
        <SummaryTile
          label="Total statement owed"
          value={cards.length ? formatMoney(totalStatement, currency) : '—'}
          loading={loading}
        />
        <SummaryTile
          label="Total minimum due"
          value={cards.length ? formatMoney(totalMinimum, currency) : '—'}
          loading={loading}
        />
        <SummaryTile
          label="Due soon"
          value={String(dueSoonCount)}
          description={dueSoonCount > 0 ? 'within 7 days' : undefined}
          tone={dueSoonCount > 0 ? 'warn' : 'default'}
          loading={loading}
        />
      </div>

      <Card className="p-3">
        <div className="mb-2 flex items-center gap-2">
          <CreditCard className="size-4" aria-hidden="true" />
          <h2 className="text-sm font-semibold">Your cards</h2>
        </div>
        {cards.length > 0 ? (
          <CardsTable cards={cards} currency={currency} onChanged={refresh} />
        ) : (
          <EmptyState
            title="No credit cards found"
            description={
              loading
                ? 'Loading…'
                : 'Add a credit card account to start planning your statement payments.'
            }
          />
        )}
      </Card>
    </div>
  )
}

function CardsTable({
  cards,
  currency,
  onChanged,
}: {
  cards: CreditCardType[]
  currency: string
  onChanged: () => void
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Card</TableHead>
          <TableHead className="text-right">Current</TableHead>
          <TableHead className="text-right">Statement</TableHead>
          <TableHead className="text-right">Minimum</TableHead>
          <TableHead>Due</TableHead>
          <TableHead>Autopay</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {cards.map((card) => (
          <CardRow key={card.accountId} card={card} currency={currency} onChanged={onChanged} />
        ))}
      </TableBody>
    </Table>
  )
}

function CardRow({
  card,
  currency,
  onChanged,
}: {
  card: CreditCardType
  currency: string
  onChanged: () => void
}) {
  const { showToast } = useToast()
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [strategy, setStrategy] = useState<CardPaymentStrategy>('statement')

  // Editable fields.
  const [statementBalance, setStatementBalance] = useState(
    card.statementBalance == null ? '' : String(card.statementBalance),
  )
  const [minimumPayment, setMinimumPayment] = useState(String(card.minimumPayment))
  const [dueDay, setDueDay] = useState(card.dueDay == null ? '' : String(card.dueDay))
  const [autopayEnabled, setAutopayEnabled] = useState(card.autopayEnabled)

  const due = dueLabel(card)

  const save = useCallback(async () => {
    setBusy(true)
    try {
      await saveCardProfile(card.accountId, {
        statementBalance: statementBalance === '' ? null : Number(statementBalance),
        minimumPayment: Number(minimumPayment) || 0,
        dueDay: dueDay === '' ? null : Number(dueDay),
        autopayEnabled,
      })
      setEditing(false)
      onChanged()
      showToast({ title: 'Saved', description: `${card.name} updated` })
    } catch (e) {
      showToast({
        title: 'Could not save',
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      })
    } finally {
      setBusy(false)
    }
  }, [statementBalance, minimumPayment, dueDay, autopayEnabled, card.accountId, card.name, onChanged, showToast])

  const planPayment = useCallback(async () => {
    setBusy(true)
    try {
      const res = await planCardPayment(card.accountId, { amountStrategy: strategy })
      onChanged()
      const sts = res.safeToSpend
      if (sts && sts.isNegative) {
        showToast({
          title: 'Payment added — heads up',
          description: `This payment pushes your safe-to-spend to ${formatMoney(sts.value, sts.currency)}.`,
          variant: 'destructive',
        })
      } else {
        showToast({ title: 'Payment added to forecast', description: card.name })
      }
    } catch (e) {
      showToast({
        title: 'Could not plan payment',
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      })
    } finally {
      setBusy(false)
    }
  }, [card.accountId, card.name, strategy, onChanged, showToast])

  const markPaid = useCallback(async () => {
    setBusy(true)
    try {
      await markCardPaymentPaid(card.accountId, {})
      onChanged()
      showToast({ title: 'Marked paid', description: card.name })
    } catch (e) {
      showToast({
        title: 'Could not mark paid',
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      })
    } finally {
      setBusy(false)
    }
  }, [card.accountId, card.name, onChanged, showToast])

  return (
    <TableRow>
      <TableCell>
        <span className="font-medium">{card.name}</span>
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {formatMoney(card.currentBalance, currency)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {editing ? (
          <Input
            type="number"
            min={0}
            step={0.01}
            value={statementBalance}
            onChange={(e) => setStatementBalance(e.target.value)}
            className="ml-auto h-8 w-28 text-right"
            aria-label={`${card.name} statement balance`}
            placeholder="—"
          />
        ) : card.statementBalance == null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          formatMoney(card.statementBalance, currency)
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {editing ? (
          <Input
            type="number"
            min={0}
            step={5}
            value={minimumPayment}
            onChange={(e) => setMinimumPayment(e.target.value)}
            className="ml-auto h-8 w-24 text-right"
            aria-label={`${card.name} minimum payment`}
          />
        ) : (
          formatMoney(card.minimumPayment, currency)
        )}
      </TableCell>
      <TableCell>
        {editing ? (
          <Input
            type="number"
            min={1}
            max={31}
            step={1}
            value={dueDay}
            onChange={(e) => setDueDay(e.target.value)}
            className="h-8 w-20"
            aria-label={`${card.name} due day of month`}
            placeholder="Day"
          />
        ) : (
          <DueBadge label={due.text} tone={due.tone} />
        )}
      </TableCell>
      <TableCell>
        {editing ? (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={autopayEnabled}
              onChange={(e) => setAutopayEnabled(e.target.checked)}
              className="size-4"
              aria-label={`${card.name} autopay`}
            />
            <span>On</span>
          </label>
        ) : card.autopayEnabled ? (
          <Badge variant="secondary" className="gap-1 text-xs">
            <Zap className="size-3" aria-hidden="true" />
            {card.autopayType ?? 'on'}
          </Badge>
        ) : (
          <span className="text-muted-foreground text-xs">Off</span>
        )}
      </TableCell>
      <TableCell className="text-right whitespace-nowrap">
        {editing ? (
          <div className="flex justify-end gap-1">
            <Button size="sm" onClick={save} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-end gap-1">
            <NativeSelect
              value={strategy}
              onChange={(e) => setStrategy(e.target.value as CardPaymentStrategy)}
              className="h-8 w-36"
              aria-label={`${card.name} payment amount`}
            >
              {(['statement', 'minimum', 'current'] as const).map((s) => (
                <NativeSelectOption key={s} value={s}>
                  {STRATEGY_LABEL[s]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <Button size="sm" variant="outline" onClick={planPayment} disabled={busy} title="Add this payment to your forecast">
              <CalendarClock className="mr-1 size-3" aria-hidden="true" />
              Plan
            </Button>
            <Button size="sm" variant="ghost" onClick={markPaid} disabled={busy} title="Mark the planned payment paid">
              Paid
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)} aria-label={`Edit ${card.name}`}>
              <Pencil className="size-3" aria-hidden="true" />
            </Button>
          </div>
        )}
      </TableCell>
    </TableRow>
  )
}

function DueBadge({ label, tone }: { label: string; tone: 'warn' | 'soon' | 'ok' }) {
  if (tone === 'warn') {
    return (
      <Badge variant="destructive" className="gap-1 text-xs">
        <AlertTriangle className="size-3" aria-hidden="true" />
        {label}
      </Badge>
    )
  }
  if (tone === 'soon') {
    return (
      <Badge className="gap-1 bg-warning-bg text-warning text-xs">
        <CalendarClock className="size-3" aria-hidden="true" />
        {label}
      </Badge>
    )
  }
  return <span className="text-muted-foreground text-xs">{label}</span>
}

type SummaryTileProps = {
  label: string
  value: string
  description?: string
  tone?: 'default' | 'warn'
  loading?: boolean
}

function SummaryTile({ label, value, description, tone, loading }: SummaryTileProps) {
  return (
    <StatCard
      className="p-3"
      label={label}
      value={
        <span className={cn('tabular-nums', tone === 'warn' && 'text-warning')}>
          {loading ? '…' : value}
        </span>
      }
      hint={description}
    />
  )
}
