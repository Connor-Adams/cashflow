import { stableFingerprint } from './fingerprint';
import type { NormalizedInvestmentActivity } from './statementTypes';

/**
 * Per-row parser for Wealthsimple's monthly investment statement CSVs.
 *
 * Header layout: `date,transaction,description,amount,balance,currency`. The
 * `transaction` field is a stable Wealthsimple TX code (BUY/SELL/DIV/INT/CONT/
 * FEE/FPLINT/CRYPTORWD/etc.); the `description` field contains a free-text
 * string that for BUY/SELL/DIV rows encodes ticker, name, and (importantly)
 * a more accurate executed-at / received-on date than the row date.
 *
 * Returns null for TX codes outside the supported set — including P2P_*,
 * AFT_*, LOAN, RECALL, etc. — so callers can drop them silently (they're
 * either irrelevant or surfaced through the cash-transaction path).
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
  CRYPTORWD: 'staking_reward',
};

// Match BUY/SELL descriptions in either format Wealthsimple emits:
//   "<TICKER> - <Name>: Bought 0.0485 shares (executed at 2025-01-06)"
//   "<TICKER> - <Name>: Sold 187.4063 shares at $40.02 per share (executed at 2025-12-31)"
// The optional " at $X per share" segment lives between `shares` and the
// `(executed at YYYY-MM-DD)` anchor, so allow any non-newline content there.
const BUYSELL_RE =
  /^([A-Z0-9.]+)\s*-\s*(.+?):\s*(Bought|Sold)\s+([\d.]+)\s+shares?[^()\n]*\(executed at (\d{4}-\d{2}-\d{2})\)/i;

// Crypto BUY/SELL descriptions use a different shape — no ticker prefix, no
// security name, no "shares" keyword:
//   "Purchase of 0.0544286100 ETH (executed at 2024-10-23), FX Rate: 1.3877, Fee charged $3.94"
//   "Sale of 4.0000000000 XRP (executed at 2026-01-28), FX Rate: 1.3552"
// We have no security name here, so callers should treat the symbol as the
// display name too (findOrCreateSecurity will keep an existing better name
// if one already exists, e.g. from a holdings CSV import).
const CRYPTO_BUYSELL_RE =
  /^(Purchase|Sale)\s+of\s+([\d.]+)\s+([A-Z0-9]+)\s*\(executed at (\d{4}-\d{2}-\d{2})\)/i;

const DIV_RE =
  /^([A-Z0-9.]+)\s*-\s*(.+?):\s*Cash dividend distribution,\s*received on (\d{4}-\d{2}-\d{2})/i;

// Two crypto FEE descriptions appear on WS monthly invest CSVs:
//   "Trading fee for sale of 4.0000000000 XRP (executed at 2026-01-28), ..."
//   "Fee paid on DOT-Polkadot staking reward: 0.0005020227"
// In both cases we want the symbol so reports can attribute fees to a token;
// quantity here is informational (sold qty / reward qty), not a position
// change, so leave it null on the activity row.
const CRYPTO_TRADING_FEE_RE =
  /^Trading fee for (?:purchase|sale)\s+of\s+[\d.]+\s+([A-Z0-9]+)\s*\(executed at (\d{4}-\d{2}-\d{2})\)/i;
const CRYPTO_STAKING_FEE_RE =
  /^Fee paid on ([A-Z0-9]+)-([^:]+) staking reward:/i;

// CRYPTORWD descriptions on monthly statements take the shape:
//   "0.0020732867 of DOT rewards earned"
//   "0.0000714937 of ETH rewards earned"
// Captures (qty, symbol). The cash-leg of the staking reward emits with
// amount=0 in the CAD half (the USD half carries the dollar value but is
// filtered out by the zero-value-non-CAD noise filter upstream), so the
// emitted InvestmentActivity has amount=0 and quantity=coin received.
const CRYPTORWD_RE = /^([\d.]+)\s+of\s+([A-Z0-9]+)\s+rewards?\s+earned/i;

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
    } else {
      const c = desc.match(CRYPTO_BUYSELL_RE);
      if (c) {
        const qty = parseFloat(c[2]);
        const symbol = c[3].trim().toUpperCase();
        const execDate = c[4];
        security = { symbol, name: symbol, assetType: 'cryptocurrency', currency };
        quantity = Number.isFinite(qty) ? qty : null;
        tradeDate = execDate;
      }
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
  } else if (activityType === 'fee') {
    const t = desc.match(CRYPTO_TRADING_FEE_RE);
    if (t) {
      const symbol = t[1].trim().toUpperCase();
      const execDate = t[2];
      security = { symbol, name: symbol, assetType: 'cryptocurrency', currency };
      tradeDate = execDate;
    } else {
      const s = desc.match(CRYPTO_STAKING_FEE_RE);
      if (s) {
        const symbol = s[1].trim().toUpperCase();
        const name = s[2].trim();
        security = { symbol, name, assetType: 'cryptocurrency', currency };
      }
    }
  } else if (activityType === 'staking_reward') {
    const m = desc.match(CRYPTORWD_RE);
    if (m) {
      const qty = parseFloat(m[1]);
      const symbol = m[2].trim().toUpperCase();
      security = { symbol, name: symbol, assetType: 'cryptocurrency', currency };
      quantity = Number.isFinite(qty) ? qty : null;
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
