import type { NormalizedInvestmentActivity } from '../statementTypes';
import type { TxnType } from '../enrichment/types';

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
  // DCTFEE (debit-card transaction fee) is deliberately NOT here: it is a
  // cash-account code (CASH_TXN_CODES / CASH_CODE_TXN_TYPE below) and a MAP
  // entry would intercept it before the brokerage parser's cash-Transaction
  // routing, dropping the fee from the cash ledger.
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

/**
 * Cash-account "Transaction" code → authoritative `TxnType`. These are the
 * codes the brokerage parser routes to `transactions` (CASH_TXN_CODES in
 * wealthsimpleBrokerage.ts), which the InvestmentActivity taxonomy does not
 * map. Stamped onto NormalizedCashTransaction.overrideTxnType so the commit
 * pipeline types them by the WS code instead of letting the narrative
 * detector guess (e.g. a negative AFT_OUT would otherwise default to
 * 'purchase' and inflate dashboard spend).
 *
 * Mirrors the inter-account/inter-party → 'transfer' convention in
 * wealthsimpleTxnType.ts (the CSV path's wsTxCodeToTxnType).
 */
const CASH_CODE_TXN_TYPE: Record<string, TxnType> = {
  SPEND: 'purchase',
  OBP: 'payment',
  CASHBACK: 'reward',
  GIVEAWAY: 'reward',
  DCTFEE: 'fee',
  AFT_IN: 'transfer',
  AFT_OUT: 'transfer',
  P2P_IN: 'transfer',
  P2P_OUT: 'transfer',
  E_TRFIN: 'transfer',
  E_TRFOUT: 'transfer',
  EFT: 'transfer',
};

export function wsPdfCashCodeToTxnType(code: string | null | undefined): TxnType | null {
  if (!code) return null;
  return CASH_CODE_TXN_TYPE[String(code).trim().toUpperCase()] ?? null;
}
