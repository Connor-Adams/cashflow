import type { NormalizedInvestmentActivity } from '../statementTypes';

type ActivityType = NormalizedInvestmentActivity['activityType'];

/**
 * Wealthsimple brokerage-statement "Transaction" code → cashflow activityType.
 *
 * Shared codes (BUY/SELL/DIV/INT/FPLINT/CONT/FEE/CRYPTORWD) are kept identical
 * to TX_TO_ACTIVITY in wealthsimpleInvestParse.ts, and the cash-movement /
 * transfer codes are reconciled with wealthsimpleActivitiesExportParse.ts, so a
 * PDF-sourced row and a CSV-sourced row for the same event classify the same —
 * required for the fuzzy matcher (keys on activityType) to dedup across sources.
 * Remaining codes come from the statement's "Information about Statement Codes"
 * legend.
 */
const MAP: Record<string, ActivityType> = {
  BUY: 'buy',
  SELL: 'sell',
  DIV: 'dividend',
  STKDIV: 'dividend',
  INT: 'interest',
  FPLINT: 'interest',
  FEE: 'fee',
  DCTFEE: 'fee',
  DSCFEE: 'fee',
  CONT: 'transfer',
  DEP: 'cash_movement',
  WD: 'cash_movement',
  WDQ: 'cash_movement',
  TRFIN: 'transfer_in',
  TRFINTF: 'transfer_in',
  WIREIN: 'transfer_in',
  WIREINTF: 'transfer_in',
  TRFOUT: 'transfer_out',
  TRFOUTTF: 'transfer_out',
  ROC: 'return_of_capital',
  CRYPTORWD: 'staking_reward',
};

/**
 * Zero-cash, zero-position-change events (stock lending, mark-to-market,
 * journals). We do NOT emit InvestmentActivity rows for them — the invest-CSV
 * path drops them too — but the parser counts them in warnings so nothing is
 * silently lost.
 */
export const WS_PDF_SKIP_CODES = new Set<string>([
  'LOAN', 'RECALL', 'STKDIS', 'STAKE', 'UNSTAKE', 'MTM', 'CORRECTION', 'JRL', 'STKREORG',
]);

export function wsPdfCodeToActivity(code: string | null | undefined): ActivityType | null {
  if (!code) return null;
  return MAP[String(code).trim().toUpperCase()] ?? null;
}
