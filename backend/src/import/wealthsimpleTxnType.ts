import type { TxnType } from './enrichment/types';

/**
 * Map a Wealthsimple monthly-statement TX code (the `transaction` column on
 * cash / invest / crypto / save-for-business statements) to the authoritative
 * `txnType` we stamp on the resulting Transaction row.
 *
 * This is the single source of truth used at import time
 * (`parseStatementFile` → `NormalizedCashTransaction.overrideTxnType`) and at
 * backfill time (`scripts/backfill-ws-txn-types.ts`).
 *
 * Codes outside this map return `null`, meaning "let the enrichment pipeline
 * decide" — typically those are codes the narrative regexes already match
 * (REFUND/RWD/etc.), or codes we don't have a stable opinion on.
 *
 * The cash-leg of investment activity (BUY/SELL) maps to `'investment'`;
 * cash dividends from holdings map to `'dividend'`. All inter-account /
 * inter-party cash flows (CONT, AFT_*, P2P_*, E_TRF*) map to `'transfer'`
 * because they are NOT spend even though the amount can be negative.
 */
export function wsTxCodeToTxnType(code: string | null | undefined): TxnType | null {
  if (!code) return null;
  const c = String(code).trim().toUpperCase();
  switch (c) {
    case 'BUY':
    case 'SELL':
      return 'investment';
    case 'DIV':
      return 'dividend';
    case 'CONT':
    case 'AFT_IN':
    case 'AFT_OUT':
    case 'P2P_RECEIVED':
    case 'P2P_SENT':
    case 'E_TRFIN':
    case 'E_TRFOUT':
      return 'transfer';
    case 'INT':
    case 'FPLINT':
      return 'interest';
    case 'FEE':
      return 'fee';
    default:
      return null;
  }
}

/**
 * Best-effort extractor for the WS TX code embedded in a saved Transaction's
 * `merchantRaw` field. The bundle importer historically stamped the WS
 * description into `merchantRaw`, so we can re-derive the TX code only when
 * the description is unambiguous.
 *
 * Returns the corresponding `txnType`, or `null` when no narrative cue
 * is recognized — the backfill script then falls back to narrative regex
 * detection.
 *
 * Patterns matched (case-insensitive):
 *   - "Bought N shares ..."                 → investment
 *   - "Sold N shares ..."                   → investment
 *   - "Cash dividend distribution"          → dividend
 *   - "Pre-authorized Debit ..."            → transfer
 *   - "Pre-authorized Credit ..."           → transfer
 *   - "Cash sent"                           → transfer
 *   - "Cash received"                       → transfer
 *   - "Direct deposit ..."                  → transfer
 *   - "EFT in" / "EFT out"                  → transfer
 *   - "Contribution ..."                    → transfer  (CONT — Save→Investing rebalance)
 *   - "Money transfer (to|out of) ..."      → transfer
 *   - "Online bill payment for <CC> ..."    → payment   (CC statement payment from chequing)
 *   - "Subscription fee paid ..."           → fee
 *   - "Staking reward fee ..."              → fee
 *   - "Wealthsimple ... fee"                → fee
 *   - "Stock lending monthly interest"      → interest
 *   - "Interest (received|earned|paid)"     → interest
 *   - "Cash dividend"                       → dividend
 *   - "Giveaway received"                   → reward
 */
export function inferWsTxnTypeFromNarrative(merchantRaw: string | null | undefined): TxnType | null {
  if (!merchantRaw) return null;
  const s = String(merchantRaw);
  if (/\b(bought|sold)\s+[\d.]+\s+shares\b/i.test(s)) return 'investment';
  if (/\bcash\s+dividend\s+distribution\b/i.test(s)) return 'dividend';
  if (/\bcash\s+dividend\b/i.test(s)) return 'dividend';
  if (/\bpre-?authorized\s+(debit|credit)\b/i.test(s)) return 'transfer';
  if (/\bcash\s+(sent|received)\b/i.test(s)) return 'transfer';
  if (/\bdirect\s+deposit\b/i.test(s)) return 'transfer';
  if (/\beft\s+(in|out)\b/i.test(s)) return 'transfer';
  if (/\baft\b/i.test(s)) return 'transfer';
  if (/\bcontribution\b/i.test(s)) return 'transfer';
  if (/\bmoney\s+transfer\b/i.test(s)) return 'transfer';
  if (/\bonline\s+bill\s+payment\b/i.test(s)) return 'payment';
  if (/\bsubscription\s+fee\b/i.test(s)) return 'fee';
  if (/\bstaking\s+reward\s+fee\b/i.test(s)) return 'fee';
  if (/\bwealthsimple\b[^.]*\bfee\b/i.test(s)) return 'fee';
  if (/\bstock\s+lending\s+monthly\s+interest\b/i.test(s)) return 'interest';
  if (/\binterest\s+(received|earned|paid)\b/i.test(s)) return 'interest';
  if (/\bgiveaway\s+received\b/i.test(s)) return 'reward';
  return null;
}
