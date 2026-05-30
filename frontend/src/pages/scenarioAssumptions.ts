import { formatMoney } from '../lib/formatMoney'
import type { ScenarioAssumption } from '../types/api'

// Pure helpers for the scenario builder (issue #213). Kept out of
// ScenariosPage.tsx so the page file only exports components — the
// react-refresh lint rule requires non-component exports live elsewhere.

export type AssumptionKind = ScenarioAssumption['kind']

export const KIND_LABEL: Record<AssumptionKind, string> = {
  income_pct: 'Income change (%)',
  expense_pct: 'Expense change (%)',
  savings_monthly: 'Extra monthly savings',
  one_off: 'One-off event',
}

/**
 * A draft assumption row in the builder. All fields are strings while editing
 * so partially-typed numbers don't fight the controlled inputs; they're
 * coerced on submit.
 */
export type DraftAssumption = {
  kind: AssumptionKind
  /** income_pct / expense_pct — whole-number percent in the UI (e.g. "-30"). */
  pct: string
  /** savings_monthly / one_off amount. */
  amount: string
  /** one_off only. */
  date: string
  direction: 'in' | 'out'
}

export function newDraft(): DraftAssumption {
  return { kind: 'income_pct', pct: '', amount: '', date: '', direction: 'out' }
}

/**
 * Coerce the draft rows into the API assumption shape. Percent inputs are
 * entered as whole numbers (e.g. "-30" → income drops 30%) and converted to
 * the fractional form (-0.3) the API expects. Invalid rows are dropped.
 */
export function draftsToAssumptions(drafts: DraftAssumption[]): ScenarioAssumption[] {
  const out: ScenarioAssumption[] = []
  for (const d of drafts) {
    if (d.kind === 'income_pct' || d.kind === 'expense_pct') {
      const whole = Number(d.pct)
      if (!Number.isFinite(whole) || d.pct.trim() === '') continue
      out.push({ kind: d.kind, pct: whole / 100 })
    } else if (d.kind === 'savings_monthly') {
      const amount = Number(d.amount)
      if (!Number.isFinite(amount) || amount < 0 || d.amount.trim() === '') continue
      out.push({ kind: 'savings_monthly', amount })
    } else if (d.kind === 'one_off') {
      const amount = Number(d.amount)
      if (!Number.isFinite(amount) || amount < 0 || d.amount.trim() === '') continue
      if (!d.date) continue
      out.push({ kind: 'one_off', date: d.date, amount, direction: d.direction })
    }
  }
  return out
}

export function describeAssumption(a: ScenarioAssumption, currency: string): string {
  switch (a.kind) {
    case 'income_pct':
      return `Income ${a.pct >= 0 ? '+' : ''}${(a.pct * 100).toFixed(0)}%`
    case 'expense_pct':
      return `Expenses ${a.pct >= 0 ? '+' : ''}${(a.pct * 100).toFixed(0)}%`
    case 'savings_monthly':
      return `Save ${formatMoney(a.amount, currency)} / month`
    case 'one_off':
      return `${a.direction === 'out' ? 'Spend' : 'Receive'} ${formatMoney(a.amount, currency)} on ${a.date}`
  }
}
