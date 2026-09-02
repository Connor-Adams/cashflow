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

/**
 * Deposit-account (WS Cash / Chequing / Save) "Transaction" code → `TxnType`.
 *
 * On a deposit account EVERY row is a cash-ledger event, so this covers the
 * brokerage-taxonomy codes too — they are cash movements when they land on a
 * chequing account, not investment activity. Wealthsimple proved the code list
 * alone cannot separate the two: the same recurring AMEX pre-authorized debit
 * carried AFT_OUT in the 2026-06 statement and WD in 2026-07, and an incoming
 * Interac e-Transfer moved from E_TRFIN to CONT.
 *
 * A code absent from this map still routes to the cash ledger — it just falls
 * through to the narrative detector for typing rather than being dropped.
 */
const DEPOSIT_CODE_TXN_TYPE: Record<string, TxnType> = {
  ...CASH_CODE_TXN_TYPE,
  // Deposits / withdrawals / contributions. 'transfer' matches the existing
  // convention for money moving between one's own accounts (AFT_IN "Direct
  // deposit" is already typed transfer), keeping them out of spend totals.
  DEP: 'transfer',
  WD: 'transfer',
  WDQ: 'transfer',
  CONT: 'transfer',
  TRFIN: 'transfer',
  TRFINTF: 'transfer',
  WIREIN: 'transfer',
  WIREINTF: 'transfer',
  TRFOUT: 'transfer',
  TRFOUTTF: 'transfer',
  // Interest received on a deposit balance. 'interest' is absent from
  // safeToSpend's INCOME_EXCLUDED_TXN_TYPES, so a positive row counts as
  // income; the sign carries the direction.
  INT: 'interest',
  FPLINT: 'interest',
  FEE: 'fee',
  DSCFEE: 'fee',
};

export function wsPdfDepositCodeToTxnType(code: string | null | undefined): TxnType | null {
  if (!code) return null;
  return DEPOSIT_CODE_TXN_TYPE[String(code).trim().toUpperCase()] ?? null;
}

/**
 * Codes whose TxnType the statement genuinely establishes, as opposed to ones
 * that only say which way the money went.
 *
 * SPEND is a card purchase, OBP is a bill payment, INT is interest, DCTFEE is a
 * fee — nothing in the narrative can outrank those. The movement codes are
 * different: Wealthsimple uses the SAME code for a plain withdrawal and for a
 * credit-card bill payment (WD, AFT_OUT), and for both an account funding
 * transfer and a payroll direct deposit (DEP, AFT_IN). Their TxnType is
 * therefore emitted as `txnTypeHint`, which the narrative detector may beat —
 * without that, "Pre-authorized Debit to AMEX BILL PYMT" is filed as a
 * transfer, which is what prod holds for 38 rows.
 */
const AUTHORITATIVE_CODES = new Set<string>([
  'SPEND', 'OBP', 'CASHBACK', 'GIVEAWAY', 'DCTFEE', 'FEE', 'DSCFEE', 'INT', 'FPLINT',
]);

export function wsPdfCodeTypeIsAuthoritative(code: string | null | undefined): boolean {
  if (!code) return false;
  return AUTHORITATIVE_CODES.has(String(code).trim().toUpperCase());
}
