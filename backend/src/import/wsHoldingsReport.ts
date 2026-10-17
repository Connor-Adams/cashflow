import crypto from 'node:crypto';
import { parseCsvRecords } from './csvParse';
import type { NormalizedHoldingSnapshot } from './statementTypes';

/**
 * Wealthsimple multi-account holdings report.
 *
 * Wealthsimple retired the per-account monthly statement exports; this report
 * is now the only file they produce. One row per position, every account in one
 * file, keyed by the WSID in `Account Number` — the same id that lives in
 * statement PDF filenames and in `Account.shortCode`.
 *
 *   Account Name,Account Type,...,Account Number,Symbol,...,Quantity,...
 *   "Corporate investing",...,"HQ8H0GZ07CAD","VFV",...,"200.8294","LONG",...
 *   "As of 2026-09-16 20:42 GMT-04:00"          <- trailer carries the date
 *
 * A holdings report is a SNAPSHOT: quantities and values at a moment. It
 * contains no buys, sells, dividends or interest, so it cannot feed ACB,
 * capital gains or investment income — those need the activity statement.
 *
 * Each row's fingerprint covers account + security + statement date, which the
 * `holdings_snapshots_account_fingerprint_unique` index turns into exactly the
 * behaviour we want: re-importing a file is a no-op, while the next report
 * inserts a fresh snapshot and the position history accumulates.
 */

export interface WsHoldingsSlice {
  /** Wealthsimple account id, matched against `Account.shortCode`. */
  wsid: string;
  /** Wealthsimple's own label, e.g. "Corporate investing" — for messages only. */
  accountLabel: string;
  holdings: NormalizedHoldingSnapshot[];
}

export interface WsHoldingsReport {
  /** ISO date the positions were measured, from the trailer row. */
  statementDate: string | null;
  slices: WsHoldingsSlice[];
  parseErrors: { rowIndex: number; message: string }[];
}

const AS_OF_RE = /As of\s+(\d{4}-\d{2}-\d{2})/i;

/** `costBasis` / `marketValue` are DECIMAL(14,4); WS prints ~30 decimals. */
function round(value: number, places: number): number {
  return Number(value.toFixed(places));
}

function num(raw: string | undefined): number | null {
  if (raw == null || raw.trim() === '') return null;
  const parsed = Number(raw.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseWsHoldingsReport(text: string): WsHoldingsReport {
  const parsed = parseCsvRecords(text);
  if (!parsed.ok) {
    return { statementDate: null, slices: [], parseErrors: [{ rowIndex: 0, message: parsed.error }] };
  }

  const parseErrors: { rowIndex: number; message: string }[] = [];

  // The as-of date lives in a trailer row whose only populated cell is the
  // first column. Without it every snapshot would be misdated, so this is a
  // hard error rather than a fallback to "today".
  let statementDate: string | null = null;
  for (const record of parsed.records) {
    const m = AS_OF_RE.exec(String(record['Account Name'] ?? ''));
    if (m) {
      statementDate = m[1];
      break;
    }
  }
  if (statementDate == null) {
    return {
      statementDate: null,
      slices: [],
      parseErrors: [{ rowIndex: 0, message: 'holdings report: no "As of <date>" trailer row' }],
    };
  }

  const byWsid = new Map<string, WsHoldingsSlice>();
  parsed.records.forEach((record, index) => {
    const wsid = String(record['Account Number'] ?? '').trim();
    const symbol = String(record['Symbol'] ?? '').trim();
    // The trailer, and any blank filler row, carries neither.
    if (wsid === '' || symbol === '') return;

    const rowIndex = index + 2; // 1-based, past the header
    const quantity = num(record['Quantity']);
    if (quantity == null) {
      parseErrors.push({
        rowIndex,
        message: `holdings report: unreadable quantity "${record['Quantity']}" for ${symbol} in ${wsid}`,
      });
      return;
    }
    // WS reports magnitudes and states the side separately.
    const signed = String(record['Position Direction'] ?? '').toUpperCase() === 'SHORT'
      ? -quantity
      : quantity;

    const currency = String(record['Market Value Currency'] ?? record['Market Price Currency'] ?? 'CAD').trim();
    const marketValue = num(record['Market Value']);
    const costBasis = num(record['Book Value (CAD)']);
    const unrealized = num(record['Market Unrealized Returns']);

    const slice = byWsid.get(wsid) ?? {
      wsid,
      accountLabel: String(record['Account Name'] ?? wsid).trim(),
      holdings: [],
    };
    slice.holdings.push({
      statementDate,
      security: {
        symbol,
        name: String(record['Name'] ?? '').trim() || null,
        assetType: String(record['Security Type'] ?? '').trim().toLowerCase() || null,
        currency: String(record['Market Price Currency'] ?? currency).trim(),
      },
      quantity: round(signed, 8),
      price: (() => {
        const p = num(record['Market Price']);
        return p == null ? null : round(p, 8);
      })(),
      marketValue: marketValue == null ? null : round(marketValue, 4),
      costBasis: costBasis == null ? null : round(costBasis, 4),
      unrealizedGainLoss: unrealized == null ? null : round(unrealized, 4),
      currency,
      sourceReference: null,
      // Account + security + date. The unique index on
      // (account_id, source_row_fingerprint) then makes a repeated upload a
      // no-op while a new report date lands as its own snapshot.
      sourceRowFingerprint: crypto
        .createHash('sha256')
        .update(JSON.stringify(['ws-holdings', wsid, symbol, statementDate]))
        .digest('hex'),
    });
    byWsid.set(wsid, slice);
  });

  return { statementDate, slices: [...byWsid.values()], parseErrors };
}
