import { stableFingerprint } from './fingerprint';
import type { NormalizedInvestmentActivity } from './statementTypes';

/**
 * Per-row parser for Wealthsimple's unified activities-export CSV.
 *
 * Header layout (14 columns):
 *   transaction_date, settlement_date, account_id, account_type,
 *   activity_type, activity_sub_type, direction, symbol, name, currency,
 *   quantity, unit_price, commission, net_cash_amount
 *
 * Trailing footer row "As of YYYY-MM-DD ..." must be stripped by the caller
 * before passing rows in.
 *
 * Unlike the per-account monthly statement, this file:
 *   - Covers ALL Wealthsimple accounts in one file (account_id column)
 *   - Has structured symbol/quantity/price/commission columns (no regex)
 *   - Carries an explicit settlement_date column (often = transaction_date for
 *     trades; NULL for dividends, interest, MoneyMovement)
 *   - INCLUDES CryptoStakingReward rows that the monthly parser drops
 *
 * Cross-source dedup against monthly-statement rows is handled outside this
 * parser by `findExistingInvestmentByFuzzyMatch` — the monthly parser stores
 * "executed at" as `tradeDate` and leaves `settlementDate` NULL, so a direct
 * fingerprint match is impossible.
 */

export type WsActivitiesExportRow = {
  transaction_date: string;
  settlement_date: string;
  account_id: string;
  account_type: string;
  activity_type: string;
  activity_sub_type: string;
  direction: string;
  symbol: string;
  name: string;
  currency: string;
  quantity: string;
  unit_price: string;
  commission: string;
  net_cash_amount: string;
};

export type ParsedActivitiesExportRow =
  | {
      kind: 'investment';
      accountShortCode: string;
      activity: NormalizedInvestmentActivity;
    }
  | {
      kind: 'skip';
      accountShortCode: string;
      reason: string;
      activityType: string;
      activitySubType: string;
    };

type ActivityType = NormalizedInvestmentActivity['activityType'];

function num(raw: string): number | null {
  const s = String(raw ?? '').trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function normalizeSymbol(raw: string): string | null {
  const s = String(raw ?? '').trim().toUpperCase();
  return s === '' ? null : s;
}

function normalizeCurrency(raw: string, fallback: string): string {
  const v = String(raw || fallback || 'CAD').trim().toUpperCase();
  return v.slice(0, 3) || 'CAD';
}

/**
 * Activity classification for activities-export rows.
 *
 * Returns null for MoneyMovement and BonusPayment — these are cash-side
 * events already imported via the per-account monthly statement parser
 * (which has richer merchantRaw text for the cash dedup path). Importing
 * them again here would produce duplicates with degraded merchantRaw.
 */
function classifyActivity(
  activityType: string,
  activitySubType: string,
): { type: ActivityType; reason?: never } | { type: null; reason: string } {
  const at = activityType.trim();
  const sub = activitySubType.trim().toUpperCase();

  if (at === 'Trade') {
    if (sub === 'BUY') return { type: 'buy' };
    if (sub === 'SELL') return { type: 'sell' };
    return { type: null, reason: `Unknown Trade sub-type: ${sub}` };
  }
  if (at === 'Dividend') return { type: 'dividend' };
  if (at === 'Interest') return { type: 'interest' };
  if (at === 'Fee') return { type: 'fee' };
  if (at === 'CryptoStakingReward') return { type: 'staking_reward' };
  if (at === 'SecurityTransfer') return { type: 'transfer' };
  if (at === 'Correction') return { type: 'other' };
  if (at === 'MoneyMovement') {
    return { type: null, reason: 'cash-side; imported via monthly statement' };
  }
  if (at === 'BonusPayment') {
    return { type: null, reason: 'cash-side; imported via monthly statement' };
  }
  return { type: null, reason: `Unrecognized activity_type: ${at}` };
}

function synthesizeDescription(row: WsActivitiesExportRow, type: ActivityType): string {
  const sym = normalizeSymbol(row.symbol);
  const name = row.name?.trim() || '';
  const subj = sym && name ? `${sym} ${name}` : sym ?? name ?? '';
  const qty = row.quantity?.trim() || '';
  const px = row.unit_price?.trim() || '';

  switch (type) {
    case 'buy':
      return subj
        ? `${subj}: Bought ${qty} shares${px ? ` at $${px} per share` : ''}`
        : 'BUY';
    case 'sell':
      return subj
        ? `${subj}: Sold ${qty} shares${px ? ` at $${px} per share` : ''}`
        : 'SELL';
    case 'dividend':
      return subj ? `${subj}: Cash dividend distribution` : 'Dividend';
    case 'interest':
      return 'Interest';
    case 'fee':
      return subj ? `${subj}: Fee` : 'Fee';
    case 'staking_reward':
      return subj
        ? `${subj}: Staking reward${qty ? ` ${qty}` : ''}`
        : 'Staking reward';
    case 'transfer':
    case 'transfer_in':
    case 'transfer_out':
      return subj ? `${subj}: Security transfer` : 'Transfer';
    case 'other':
      return `${row.activity_type}${row.activity_sub_type ? ` (${row.activity_sub_type})` : ''}${
        subj ? `: ${subj}` : ''
      }${qty ? ` ${qty}` : ''}`;
    default:
      return row.activity_type || 'Activity';
  }
}

/**
 * Wealthsimple account_type values for cash-style accounts. Interest/Fee
 * activity for these accounts lives in the Transaction table (via the
 * monthly cash-statement parser), not InvestmentActivity. Importing such
 * rows here would create orphan InvestmentActivity records with no
 * corresponding Transaction.
 */
const CASH_ACCOUNT_TYPES: ReadonlySet<string> = new Set([
  'Chequing',
  'Save for Business',
]);

export function parseActivitiesExportRow(
  row: WsActivitiesExportRow,
  defaultCurrency: string,
): ParsedActivitiesExportRow {
  const accountShortCode = row.account_id.trim();
  if (CASH_ACCOUNT_TYPES.has(row.account_type.trim())) {
    return {
      kind: 'skip',
      accountShortCode,
      reason: `cash account (${row.account_type.trim()}); handled by cash statement parser`,
      activityType: row.activity_type,
      activitySubType: row.activity_sub_type,
    };
  }
  const cls = classifyActivity(row.activity_type, row.activity_sub_type);

  if (cls.type == null) {
    return {
      kind: 'skip',
      accountShortCode,
      reason: cls.reason,
      activityType: row.activity_type,
      activitySubType: row.activity_sub_type,
    };
  }

  let activityType = cls.type;
  const tradeDate = row.transaction_date.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
    return {
      kind: 'skip',
      accountShortCode,
      reason: `Invalid transaction_date: ${tradeDate}`,
      activityType: row.activity_type,
      activitySubType: row.activity_sub_type,
    };
  }
  const settlementDate = row.settlement_date.trim();
  const currency = normalizeCurrency(row.currency, defaultCurrency);
  const symbol = normalizeSymbol(row.symbol);

  // The activities-export `quantity` column means different things by row
  // type. For Trade and CryptoStakingReward and SecurityTransfer rows it is
  // the actual share/coin count. For Dividend, Interest, Fee, and Correction
  // rows it duplicates `net_cash_amount` (Wealthsimple data quirk). The
  // monthly-statement parser stores these as quantity=NULL, so emit NULL
  // here too to keep the cross-source identity tuple comparable.
  const QUANTITY_TYPES: ReadonlySet<ActivityType> = new Set([
    'buy',
    'sell',
    'staking_reward',
    'transfer',
  ]);
  // Activities-export signs `quantity` negative for SELL (shares leaving
  // the account) but positive for BUY. The monthly-statement parser stores
  // abs(quantity) for both — direction is already in `activityType`. Strip
  // the sign so cross-source identity matches.
  const rawQty = QUANTITY_TYPES.has(activityType) ? num(row.quantity) : null;
  const quantity = rawQty == null ? null : Math.abs(rawQty);
  // Fold SecurityTransfer to the directional vocabulary the monthly-statement
  // PDF parser emits (transfer_in / transfer_out). The fuzzy cross-source
  // matcher keys on activityType, so a security transfer present in BOTH the
  // activities-export CSV and the monthly PDF would otherwise miss dedup
  // ('transfer' vs 'transfer_in') and double-count. Direction is the sign of
  // the share quantity: the export signs shares leaving the account negative.
  if (activityType === 'transfer' && rawQty != null && rawQty !== 0) {
    activityType = rawQty < 0 ? 'transfer_out' : 'transfer_in';
  }
  const price = num(row.unit_price);
  const commission = num(row.commission);
  const amount = num(row.net_cash_amount);
  const description = synthesizeDescription(row, activityType);

  const security =
    symbol == null
      ? null
      : {
          symbol,
          name: row.name?.trim() || symbol,
          assetType: row.account_type === 'Crypto' ? 'cryptocurrency' : null,
          currency,
        };

  // sourceRowFingerprint is the audit hash + last-line-of-defense unique key.
  // Cross-source dedup uses the fuzzy-match helper; this hash only needs to
  // be (a) stable for re-imports of THIS export format and (b) distinct
  // between any two rows in the source file.
  //
  // Including the raw CSV quantity string (NOT the normalized abs/null one)
  // is essential for Correction/ANOMALY cancel-pairs which emit the same
  // (date, symbol, type) tuple with opposite signs — their normalized
  // quantity is nulled but the raw string differs.
  const sourceRowFingerprint = stableFingerprint({
    kind: 'ws_activities_export',
    accountShortCode,
    tradeDate,
    settlementDate: settlementDate || null,
    activityType,
    activitySubType: row.activity_sub_type.trim(),
    symbol,
    rawQuantity: row.quantity.trim(),
    rawUnitPrice: row.unit_price.trim(),
    rawCommission: row.commission.trim(),
    rawNetCashAmount: row.net_cash_amount.trim(),
    currency,
  });

  return {
    kind: 'investment',
    accountShortCode,
    activity: {
      activityType,
      tradeDate,
      settlementDate: settlementDate && /^\d{4}-\d{2}-\d{2}$/.test(settlementDate)
        ? settlementDate
        : null,
      description,
      security,
      quantity,
      price,
      amount,
      fees: commission,
      currency,
      sourceReference: null,
      sourceRowFingerprint,
    },
  };
}

const AS_OF_RE = /^["']?\s*As of\s+\d{4}-\d{2}-\d{2}/i;

/**
 * Header sniff for activities-export CSVs. Activities-export is distinct from
 * the per-account monthly statement (which has a 6-column layout).
 */
export function isActivitiesExportHeaders(headers: string[]): boolean {
  if (!headers || headers.length < 14) return false;
  const lower = new Set(headers.map((h) => String(h).trim().toLowerCase()));
  return (
    lower.has('transaction_date') &&
    lower.has('settlement_date') &&
    lower.has('account_id') &&
    lower.has('activity_type') &&
    lower.has('activity_sub_type') &&
    lower.has('net_cash_amount')
  );
}

/**
 * Strip the trailing "As of YYYY-MM-DD" footer line if present. csv-parse
 * surfaces it as a row with a single populated cell — we treat any row whose
 * transaction_date field begins with "As of" as the footer and drop it.
 */
export function isAsOfFooterRow(row: WsActivitiesExportRow): boolean {
  return AS_OF_RE.test(row.transaction_date || '');
}
