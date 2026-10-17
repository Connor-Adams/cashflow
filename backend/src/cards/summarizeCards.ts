import type { CadConverter } from '../fx/cadConverter';
import { toUnits, fromUnits } from '../util/numbers';

export type CardTotalsInput = {
  currency: string;
  currentBalance: number;
  statementBalance: number | null;
  minimumPayment: number;
  /** Closed on or before asOf — dimmed in the UI and left out of totals. */
  closed: boolean;
};

export type CardTotals = {
  /** Totals are always CAD, never "the first card's currency". */
  currency: 'CAD';
  /** Σ (statementBalance ?? currentBalance), FX-converted to CAD. */
  statementOwed: number;
  /** Σ minimumPayment, FX-converted to CAD. */
  minimumDue: number;
  /** Currencies with no resolvable FX rate, left out of the totals. */
  unconvertedCurrencies: string[];
};

/**
 * CAD totals for the credit-card planner summary tiles. Each card's owed and
 * minimum are converted at asOf before summing, so a USD 2,000 card plus a CAD
 * 10,000 card is not rendered as "CA$12,000". A card whose currency has no FX
 * rate is excluded and its currency flagged rather than summed as CAD.
 */
export async function summarizeCards(
  cards: CardTotalsInput[],
  toCad: CadConverter,
): Promise<CardTotals> {
  let owedU = 0;
  let minU = 0;
  const unconverted = new Set<string>();
  for (const c of cards) {
    if (c.closed) continue;
    const owed = await toCad(c.statementBalance ?? c.currentBalance, c.currency);
    const min = await toCad(c.minimumPayment, c.currency);
    if (owed == null || min == null) {
      unconverted.add(c.currency);
      continue;
    }
    owedU += toUnits(owed);
    minU += toUnits(min);
  }
  return {
    currency: 'CAD',
    statementOwed: Math.round(fromUnits(owedU) * 100) / 100,
    minimumDue: Math.round(fromUnits(minU) * 100) / 100,
    unconvertedCurrencies: Array.from(unconverted).sort(),
  };
}
