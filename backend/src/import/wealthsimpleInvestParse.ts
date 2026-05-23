import { stableFingerprint } from './fingerprint';
import type { NormalizedInvestmentActivity } from './statementTypes';

/**
 * Per-row parser for Wealthsimple's monthly investment statement CSVs.
 *
 * Header layout: `date,transaction,description,amount,balance,currency`. The
 * `transaction` field is a stable Wealthsimple TX code (BUY/SELL/DIV/INT/CONT/
 * FEE/FPLINT/etc.); the `description` field contains a free-text string that
 * for BUY/SELL/DIV rows encodes ticker, name, and (importantly) a more
 * accurate executed-at / received-on date than the row date.
 *
 * Returns null for TX codes outside the supported set — including P2P_*,
 * AFT_*, CRYPTORWD, LOAN, RECALL, etc. — so callers can drop them silently
 * (they're either irrelevant or surfaced through the cash-transaction path).
 */

export type WsRow = {
  date: string;
  transaction: string;
  description: string;
  amount: string;
  balance: string;
  currency: string;
};

type ActivityType = NormalizedInvestmentActivity['activityType'];

const TX_TO_ACTIVITY: Record<string, ActivityType> = {
  BUY: 'buy',
  SELL: 'sell',
  DIV: 'dividend',
  FPLINT: 'interest',
  INT: 'interest',
  CONT: 'transfer',
  FEE: 'fee',
};

// Match BUY/SELL descriptions in either format Wealthsimple emits:
//   "<TICKER> - <Name>: Bought 0.0485 shares (executed at 2025-01-06)"
//   "<TICKER> - <Name>: Sold 187.4063 shares at $40.02 per share (executed at 2025-12-31)"
// The optional " at $X per share" segment lives between `shares` and the
// `(executed at YYYY-MM-DD)` anchor, so allow any non-newline content there.
const BUYSELL_RE =
  /^([A-Z0-9.]+)\s*-\s*(.+?):\s*(Bought|Sold)\s+([\d.]+)\s+shares?[^()\n]*\(executed at (\d{4}-\d{2}-\d{2})\)/i;

const DIV_RE =
  /^([A-Z0-9.]+)\s*-\s*(.+?):\s*Cash dividend distribution,\s*received on (\d{4}-\d{2}-\d{2})/i;

function parseAmount(raw: string): number {
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

function normalizeCurrency(rowCurrency: string, fallback: string): string {
  const v = String(rowCurrency || fallback || 'CAD').trim().toUpperCase();
  return v || 'CAD';
}

export function parseWsInvestRow(
  row: WsRow,
  accountId: number,
  defaultCurrency: string,
): NormalizedInvestmentActivity | null {
  const code = String(row.transaction || '').trim().toUpperCase();
  const activityType = TX_TO_ACTIVITY[code];
  if (!activityType) return null;

  const currency = normalizeCurrency(row.currency, defaultCurrency);
  const amount = parseAmount(row.amount);
  const desc = String(row.description ?? '');

  let security: NormalizedInvestmentActivity['security'] = null;
  let quantity: number | null = null;
  let tradeDate = row.date;

  if (activityType === 'buy' || activityType === 'sell') {
    const m = desc.match(BUYSELL_RE);
    if (m) {
      const symbol = m[1].trim().toUpperCase();
      const name = m[2].trim();
      const qty = parseFloat(m[4]);
      const execDate = m[5];
      security = { symbol, name, assetType: null, currency };
      quantity = Number.isFinite(qty) ? qty : null;
      tradeDate = execDate;
    }
  } else if (activityType === 'dividend') {
    const m = desc.match(DIV_RE);
    if (m) {
      const symbol = m[1].trim().toUpperCase();
      const name = m[2].trim();
      const receivedOn = m[3];
      security = { symbol, name, assetType: null, currency };
      // Dividends have no share quantity — leave null.
      tradeDate = receivedOn;
    }
  }

  const fingerprint = stableFingerprint({
    kind: 'ws_invest',
    accountId,
    tradeDate,
    txCode: code,
    description: desc,
    amount,
  });

  return {
    activityType,
    tradeDate,
    settlementDate: null,
    description: desc,
    security,
    quantity,
    price: null,
    amount,
    fees: null,
    currency,
    sourceReference: null,
    sourceRowFingerprint: fingerprint,
  };
}
