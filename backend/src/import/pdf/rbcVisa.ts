import type { PdfLine, PdfParser, PdfParseResult, PdfStatementHeader } from './types';
import { normalizeMerchant } from '../normalizeMerchant';
import { MONTHS_SHORT, parseLongDate, parseMoney, toIso, type Period } from './dateHelpers';

/**
 * RBC Visa (Signature RBC Rewards Visa, RBC Avion, etc) statement parser.
 *
 * Layout markers:
 *   Title:   "Signature® RBC Rewards® Visa‡"  (or other Visa product title)
 *   Account: "CONNOR ADAMS 4510 15** **** 5234"  (last 4 = account suffix)
 *   Period:  "STATEMENT FROM NOV 08 TO DEC 8, 2025"
 *   Header:  "TRANSACTION DATE POSTING DATE ACTIVITY DESCRIPTION AMOUNT ($)"
 *
 * Row format (1-2 lines per txn):
 *   "NOV 07  NOV 10  SPOTIFY P3C3196378 STOCKHOLM"
 *   "74987505311002642493068" (optional reference)
 *   "$14.34"  (amount; sometimes on the same line as description)
 *
 * Or:
 *   "DEC 01  DEC 01  ANNUAL FEE  $39.00"  (single line)
 *
 * Sign convention (cashflow side):
 *   Charge ("$14.34") → negative
 *   Payment ("-$34.17") → positive
 */

const ACCOUNT_RE = /(45\d{2})\s+15\*{2}\s+\*{4}\s+(\d{4})/;
const PERIOD_RE = /STATEMENT FROM\s+([A-Z]{3}\s+\d{1,2})\s+TO\s+([A-Z]{3}\s+\d{1,2},\s+\d{4})/i;
const MONEY_TOKEN_RE = /-?\$[\d,]+\.\d{2}/;
// The AMOUNT ($) column is the RIGHTMOST column, so the row amount is the
// trailing money token. An unanchored first-match would let a $-figure inside
// a free-form merchant descriptor (e.g. Shopify "SP * $9.99 SOCKS") steal the
// amount — same end-anchored convention as amex.ts / cibcCostcoMastercard.ts.
const TRAILING_MONEY_RE = /(-?\$[\d,]+\.\d{2})\s*$/;

function normalizeMonth(monStr: string): string {
  return monStr.charAt(0).toUpperCase() + monStr.slice(1).toLowerCase();
}

function parseShortMonthDay(raw: string, year: number): string | null {
  const m = /^([A-Z]{3})\s+(\d{1,2})$/i.exec(raw.trim());
  if (!m) return null;
  const month = MONTHS_SHORT[normalizeMonth(m[1])];
  if (month === undefined) return null;
  return toIso(year, month, Number(m[2]));
}

export function parseRbcVisaHeader(lines: PdfLine[]): PdfStatementHeader {
  const page1 = lines.filter((l) => l.page === 1);

  let accountSuffix: string | null = null;
  for (const l of page1) {
    const m = ACCOUNT_RE.exec(l.text);
    if (m) {
      accountSuffix = m[2];
      break;
    }
  }
  if (!accountSuffix) {
    throw new Error('RBC Visa header: could not find account suffix');
  }

  let period: Period | null = null;
  for (const l of page1) {
    const m = PERIOD_RE.exec(l.text);
    if (!m) continue;
    const endIso = parseLongDate(
      m[2].replace(/^([A-Z]{3})/i, (_w, mon) => {
        // Expand 3-letter month to full month name so parseLongDate accepts it.
        const full: Record<string, string> = {
          Jan: 'January', Feb: 'February', Mar: 'March', Apr: 'April', May: 'May', Jun: 'June',
          Jul: 'July', Aug: 'August', Sep: 'September', Oct: 'October', Nov: 'November', Dec: 'December',
        };
        return full[normalizeMonth(mon)] ?? mon;
      }),
    );
    if (!endIso) continue;
    const endYear = Number(endIso.slice(0, 4));
    const startIso = parseShortMonthDay(m[1], endYear);
    if (!startIso) continue;
    // If start > end, period crossed year boundary — back off start year by 1.
    period = startIso > endIso
      ? { start: parseShortMonthDay(m[1], endYear - 1)!, end: endIso }
      : { start: startIso, end: endIso };
    break;
  }
  if (!period) {
    throw new Error('RBC Visa header: could not parse statement period');
  }

  // Pull the product label (best-effort, falls back to a generic name).
  let productLabel = 'RBC Visa';
  for (const l of page1) {
    if (/Signature.{0,3}\s*RBC\s+Rewards.{0,3}\s*Visa/i.test(l.text)) {
      productLabel = 'Signature RBC Rewards Visa';
      break;
    }
    if (/RBC\s+Avion\s+Visa/i.test(l.text)) {
      productLabel = 'RBC Avion Visa';
      break;
    }
  }

  return {
    accountSuffix,
    productLabel,
    accountType: 'credit_card',
    periodStart: period.start,
    periodEnd: period.end,
  };
}

type VisaRow = { date: string; description: string; amount: number };

export function parseRbcVisaActivity(
  lines: PdfLine[],
  period: Period,
): { rows: VisaRow[]; parseErrors: { rowIndex: number; message: string }[] } {
  const rows: VisaRow[] = [];
  const parseErrors: { rowIndex: number; message: string }[] = [];

  // Activity section starts after "ACTIVITY DESCRIPTION" header line and ends
  // at "TOTAL ACCOUNT BALANCE" or "INTEREST RATE CHART".
  let inSection = false;
  const activityLines: PdfLine[] = [];
  for (const l of lines) {
    if (/ACTIVITY DESCRIPTION/.test(l.text)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (/TOTAL ACCOUNT BALANCE/i.test(l.text)) break;
    if (/INTEREST RATE CHART|Time to Pay/i.test(l.text)) break;
    activityLines.push(l);
  }

  // Walk lines and emit one txn per "TRANS POST DESCRIPTION ... [AMOUNT]" group.
  // Each txn opens with a TRANS_DATE+POST_DATE prefix; description continues on
  // dateless lines until the amount is found (often on the same line, sometimes
  // on a subsequent line with just the amount).
  const DATE_PREFIX = /^([A-Z]{3}\s+\d{1,2})\s+([A-Z]{3}\s+\d{1,2})\s+(.*)$/;
  type Pending = { transDateRaw: string; descParts: string[]; amount: number | null };
  let pending: Pending | null = null;

  const flush = (idx: number): void => {
    if (!pending) return;
    if (pending.amount == null) {
      parseErrors.push({
        rowIndex: idx + 1,
        message: `RBC Visa row missing amount: ${pending.descParts.join(' ')}`,
      });
      pending = null;
      return;
    }
    const periodEndYear = Number(period.end.slice(0, 4));
    let iso = parseShortMonthDay(pending.transDateRaw, periodEndYear);
    if (iso && iso > period.end) {
      iso = parseShortMonthDay(pending.transDateRaw, periodEndYear - 1);
    }
    if (!iso) {
      parseErrors.push({
        rowIndex: idx + 1,
        message: `RBC Visa: could not resolve transaction date ${pending.transDateRaw}`,
      });
      pending = null;
      return;
    }
    const desc = pending.descParts.join(' ').replace(/\s+/g, ' ').trim();
    if (!desc) {
      parseErrors.push({ rowIndex: idx + 1, message: 'RBC Visa: empty description' });
      pending = null;
      return;
    }
    // Sign flip: PDF positive = charge → cashflow negative.
    rows.push({ date: iso, description: desc, amount: -pending.amount });
    pending = null;
  };

  for (let i = 0; i < activityLines.length; i++) {
    const text = activityLines[i].text.trim();
    if (!text) continue;
    // Skip cardholder header line ("CONNOR ADAMS 4510 ...") and primary label.
    if (ACCOUNT_RE.test(text) && /PRIMARY|CARDHOLDER/i.test(text)) continue;

    const dm = DATE_PREFIX.exec(text);
    if (dm) {
      // New row — flush previous if any.
      flush(i);
      pending = { transDateRaw: dm[1], descParts: [], amount: null };
      let remainder = dm[3];
      const amtMatch = TRAILING_MONEY_RE.exec(remainder);
      if (amtMatch) {
        pending.amount = parseMoney(amtMatch[1].replace('$', ''));
        remainder = remainder.slice(0, amtMatch.index).trim();
      }
      // No trailing token → leave amount null; the continuation-line /
      // flush-error paths handle it (explicit parseError, never a silent
      // wrong value).
      if (remainder) pending.descParts.push(remainder);
      continue;
    }

    if (!pending) continue;

    // Continuation line. Could be: reference number (digits only), more description,
    // or just the amount on its own line.
    const amtMatch = MONEY_TOKEN_RE.exec(text);
    if (amtMatch && text === amtMatch[0]) {
      // Only attach when the row is still missing its amount: a stray later
      // amount line (e.g. from a swallowed neighbouring row) must never
      // overwrite an amount already captured from the date line — the
      // reconciliation gate surfaces the underlying swallow instead.
      if (pending.amount == null) {
        pending.amount = parseMoney(amtMatch[0].replace('$', ''));
      }
      continue;
    }
    if (/^\d{15,}$/.test(text)) {
      // Pure reference number — skip from description.
      continue;
    }
    pending.descParts.push(text);
  }
  flush(activityLines.length);

  return { rows, parseErrors };
}

/** Last money-looking token on a line, or null (mirrors rbcBusinessBanking). */
function lastMoneyToken(text: string): number | null {
  const tokens = text.split(/\s+/);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const v = parseMoney(tokens[i]);
    if (Number.isFinite(v)) return v;
  }
  return null;
}

/**
 * Printed statement totals for the reconciliation gate:
 *   previous — "PREVIOUS STATEMENT BALANCE $X" (CALCULATING YOUR BALANCE box)
 *   total    — "TOTAL ACCOUNT BALANCE $X" / "NEW BALANCE $X" (last occurrence)
 */
function extractStatementTotals(lines: PdfLine[]): {
  previous: number | null;
  total: number | null;
} {
  let previous: number | null = null;
  let total: number | null = null;
  for (const l of lines) {
    if (previous == null && /PREVIOUS\s+(?:STATEMENT|ACCOUNT)\s+BALANCE/i.test(l.text)) {
      previous = lastMoneyToken(l.text);
    }
    if (/TOTAL ACCOUNT BALANCE|NEW BALANCE/i.test(l.text)) {
      const v = lastMoneyToken(l.text);
      if (v != null) total = v;
    }
  }
  return { previous, total };
}

export const rbcVisaParser: PdfParser = {
  id: 'rbc_visa',
  label: 'RBC Visa',
  sniff: (lines) =>
    lines.some((l) =>
      /Signature.{0,3}\s*RBC\s+Rewards.{0,3}\s*Visa/i.test(l.text) ||
      /RBC\s+Avion\s+Visa/i.test(l.text),
    ),
  parse: (lines, ctx): PdfParseResult => {
    const header = parseRbcVisaHeader(lines);
    const period: Period = { start: header.periodStart, end: header.periodEnd };
    const { rows, parseErrors } = parseRbcVisaActivity(lines, period);

    const transactions: PdfParseResult['transactions'] = rows.map((row) => ({
      date: row.date,
      merchantRaw: row.description,
      merchantClean: normalizeMerchant(row.description),
      amount: row.amount,
      currency: ctx.defaultCurrency,
      sourceReference: null,
    }));

    // ── Reconciliation gate ─────────────────────────────────────────────────
    // Verify previous + Σ(statement-sign amounts) ≈ printed total, so rows
    // silently swallowed by extraction glitches (the pdfjs glued-row class
    // that already hit the sibling RBC parsers) surface as a parseError
    // instead of importing a partial statement with zero signal.
    const warnings: string[] = [];
    const { previous, total } = extractStatementTotals(lines);
    if (previous == null || total == null) {
      warnings.push(
        'reconciliation: could not extract printed statement totals; gate skipped',
      );
    } else {
      // Cashflow flips signs (charge → negative), so Σ in the statement's own
      // convention is the negated transaction sum.
      const sumStatement = transactions.reduce((acc, t) => acc - t.amount, 0);
      const recomputed = previous + sumStatement;
      if (Math.abs(recomputed - total) > 0.015) {
        parseErrors.push({
          rowIndex: -1,
          message:
            `statement does not reconcile: previous ${previous} + activity ${sumStatement.toFixed(2)} = ${recomputed.toFixed(2)}, expected total ${total}`,
        });
      }
    }
    // ───────────────────────────────────────────────────────────────────────

    return {
      transactions,
      header,
      warnings,
      parseErrors,
    };
  },
};
