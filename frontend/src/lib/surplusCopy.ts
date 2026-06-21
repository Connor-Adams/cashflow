/**
 * Copy helpers for the safe-to-spend surplus decision hub (#654).
 *
 * Pure string builders so the exact winning-side sentence (AC #6) is
 * unit-testable without rendering the tile.
 */
import { formatMoney } from './formatMoney'
import type { SurplusPayoffVsInvest } from '@/types/api'

/** Format a decimal rate (0.05) as a percent label ("5%", "7.5%"). */
export function formatRatePct(rate: number): string {
  const pct = rate * 100
  const str = Number.isInteger(pct) ? String(pct) : String(Math.round(pct * 100) / 100)
  return `${str}%`
}

/**
 * The payoff-vs-invest result sentence. Mirrors the issue copy exactly,
 * branching on `recommendation`:
 *  - payoff wins  → lead with interest saved.
 *  - invest wins  → lead with projected growth.
 *  - tie          → neutral phrasing (both sides shown).
 */
export function payoffVsInvestSentence(
  pvi: SurplusPayoffVsInvest,
  currency: string,
): string {
  const interest = formatMoney(pvi.interestSaved, currency)
  const gain = formatMoney(pvi.investGain, currency)
  const ratePct = formatRatePct(pvi.assumedAnnualReturnRate)
  const horizon = pvi.horizonYears

  if (pvi.recommendation === 'payoff') {
    return `Paying down debt saves ~${interest} in interest — more than the ~${gain} this might earn invested at ${ratePct} over ${horizon} years.`
  }
  if (pvi.recommendation === 'invest') {
    return `Invested at ${ratePct}, this surplus could grow ~${gain} over ${horizon} years — vs. ~${interest} saved by paying down debt.`
  }
  return `Paying down debt saves ~${interest} in interest, about the same as the ~${gain} this might earn invested at ${ratePct} over ${horizon} years.`
}
