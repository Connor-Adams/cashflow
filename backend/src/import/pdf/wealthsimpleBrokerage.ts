import type { PdfLine, PdfParser, PdfParseResult, PdfStatementHeader } from './types';
import type { NormalizedHoldingSnapshot } from '../statementTypes';

/**
 * Wealthsimple brokerage Account Statement parser — handles all Wealthsimple
 * Investments Inc. account types (self-directed + managed TFSA / FHSA / RRSP /
 * RESP / Non-Registered Margin) under one sniff. The layout is identical across
 * types; only the account-type label, the Portfolio-Equities quantity-column
 * count (3 for self-directed, 2 for managed), and whether the activity table is
 * a single "Activity" or split "CAD Activity"/"USD Activity" differ.
 *
 * Sniff (page 1):
 *   - "ORDER EXECUTION ONLY ACCOUNT"
 *   - "Wealthsimple"
 *   - NOT "Questrade" (Questrade statements ALSO say "order execution only
 *     account"; the Questrade parser requires /Questrade/i, so excluding it
 *     here is sufficient to avoid stealing Questrade PDFs).
 *
 * Header (page 1):
 *   Label line:  " Account No.   Owner   Statement Period"   (scanned past)
 *   Value line:  " HQ6LMLTK8CAD   Connor Adams   2025-05-01 - 2025-05-31"
 *   Account-type label:  " Tax-Free Savings SDI Cash Account"
 *
 * Holdings ("Portfolio Equities" table) — RIGHT-anchored. The quantity-column
 * count varies, so the last three money cells (price, market value, book cost)
 * are read from the end and the first numeric column is the total quantity.
 *
 * Activities ("Activity - Current period" / "CAD Activity"/"USD Activity") —
 * accumulate-until-next-row. Wrapped descriptions span 1-2 following buckets
 * and the wrap tail OFTEN starts with a date (e.g. "2025-05-01)"), so a
 * y-window does not work; instead every non-row line after a row is appended to
 * that row's description until the next row or section end.
 */

// Account value line, e.g. " HQ6LMLTK8CAD   Connor Adams   2025-05-01 - 2025-05-31".
// Account id = 2 letters + 4-12 alnum + currency suffix (CAD|USD). The label
// line "Account No. Owner Statement Period" has no dates so it never matches.
const ACCOUNT_LINE_RE =
  /\b([A-Z]{2}[A-Z0-9]{4,12}(?:CAD|USD))\b\s+(.+?)\s+(\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})/;

function detectProductLabel(lines: PdfLine[]): string {
  const all = lines.map((l) => l.text).join(' ');
  // Order matters: registered-account markers win over the generic
  // Margin/Non-Registered fallback.
  if (/Tax-Free Savings|\bTFSA\b/i.test(all)) return 'Wealthsimple TFSA';
  if (/First Home Savings|\bFHSA\b/i.test(all)) return 'Wealthsimple FHSA';
  if (/Retirement Savings|\bRRSP\b/i.test(all)) return 'Wealthsimple RRSP';
  if (/Registered Education|\bRESP\b/i.test(all)) return 'Wealthsimple RESP';
  if (/Margin|Non-Registered/i.test(all)) return 'Wealthsimple Investing';
  return 'Wealthsimple Investing';
}

export function parseWsBrokerageHeader(lines: PdfLine[]): PdfStatementHeader {
  let accountSuffix: string | null = null;
  let holder: string | null = null;
  let periodStart: string | null = null;
  let periodEnd: string | null = null;
  for (const l of lines) {
    const m = ACCOUNT_LINE_RE.exec(l.text);
    if (m) {
      accountSuffix = m[1];
      holder = m[2].trim();
      periodStart = m[3];
      periodEnd = m[4];
      break;
    }
  }
  if (!accountSuffix || !periodStart || !periodEnd) {
    throw new Error(
      'WS brokerage header: could not parse Account No. / Statement Period line',
    );
  }
  const currency = accountSuffix.endsWith('USD') ? 'USD' : 'CAD';
  return {
    accountSuffix,
    productLabel: detectProductLabel(lines),
    accountType: 'investment',
    periodStart,
    periodEnd,
    currency,
    accountHolder: holder ?? undefined,
  };
}

type Holding = Omit<NormalizedHoldingSnapshot, 'sourceRowFingerprint'>;

const TICKER_RE = /^[A-Z][A-Z0-9.]{0,9}$/;
// A money cell: optional $, optional leading -, digits w/ commas, optional
// decimals, optional trailing " CAD"/" USD".
const MONEY_CELL_RE = /^\$?-?[\d,]+(?:\.\d+)?(?:\s*(?:CAD|USD))?$/;

/** Strip $, commas, currency suffix, spaces → Number. */
function num(s: string): number {
  return Number(s.replace(/[$,]/g, '').replace(/\s*(?:CAD|USD)\s*$/i, '').trim());
}

/** Currency suffix on a money cell, e.g. "$27.08 USD" → "USD"; else null. */
function cellCurrency(cell: string): string | null {
  const m = /\b(CAD|USD)\b/.exec(cell);
  return m ? m[1] : null;
}

function tokenize(text: string): string[] {
  return text
    .trim()
    .split(/\s{2,}/)
    .map((c) => c.trim())
    .filter(Boolean);
}

/**
 * Parse the "Portfolio Equities" table. RIGHT-anchored: the table's
 * quantity-column count varies (3 for self-directed, 2 for managed), so the
 * last three cells (price, market value, book cost) are read from the end and
 * the first numeric column is the total quantity.
 */
function parseHoldings(
  lines: PdfLine[],
  statementDate: string,
  accountCurrency: string,
): Holding[] {
  const out: Holding[] = [];
  const STOP_RE = /^Activity\b|Current period|Stock Lending|STATEMENT NOTES/i;
  let currency = accountCurrency;
  let inHoldings = false;

  for (const l of lines) {
    const t = l.text.trim();
    if (/^Portfolio Equities/i.test(t)) {
      inHoldings = true;
      continue;
    }
    if (!inHoldings) continue;
    if (STOP_RE.test(t)) break;

    // Section-currency tracking.
    if (/^(US|United States)\s+Equities/i.test(t)) {
      currency = 'USD';
      continue;
    }
    if (/^Canadian\s+Equities/i.test(t)) {
      currency = 'CAD';
      continue;
    }
    // Header / footer / section-name noise — skip explicitly (they also fail
    // the ticker+3-money test below, but skipping early is cheaper + clearer).
    if (/^Total\b/i.test(t) || /^Symbol\b/i.test(t)) continue;

    const cols = tokenize(t);
    if (cols.length < 6) continue;
    if (!TICKER_RE.test(cols[1])) continue;
    const last = cols.length - 1;
    const priceCell = cols[last - 2];
    if (
      !MONEY_CELL_RE.test(priceCell) ||
      !MONEY_CELL_RE.test(cols[last - 1]) ||
      !MONEY_CELL_RE.test(cols[last])
    ) {
      continue;
    }

    const rowCurrency = cellCurrency(priceCell) ?? currency;
    out.push({
      statementDate,
      security: {
        symbol: cols[1],
        name: cols[0],
        assetType: null,
        currency: rowCurrency,
      },
      quantity: num(cols[2]),
      price: num(priceCell),
      marketValue: num(cols[last - 1]),
      costBasis: num(cols[last]),
      unrealizedGainLoss: null,
      currency: rowCurrency,
      sourceReference: null,
    });
  }

  return out;
}

export const wealthsimpleBrokerageParser: PdfParser = {
  id: 'wealthsimple_brokerage',
  label: 'Wealthsimple Brokerage Statement',
  crossSourceDedup: 'fuzzy-window-5d',
  holdingFingerprint: 'ws_holding',
  sniff: (lines) => {
    let orderExec = false;
    let ws = false;
    let questrade = false;
    for (const l of lines) {
      if (/ORDER EXECUTION ONLY ACCOUNT/i.test(l.text)) orderExec = true;
      if (/Wealthsimple/i.test(l.text)) ws = true;
      if (/Questrade/i.test(l.text)) questrade = true;
    }
    return orderExec && ws && !questrade;
  },
  // activities implemented in Task 8
  parse: (lines): PdfParseResult => {
    const header = parseWsBrokerageHeader(lines);
    const holdings = parseHoldings(
      lines,
      header.periodEnd,
      header.currency ?? 'CAD',
    );
    return {
      transactions: [],
      investmentActivities: [],
      holdings,
      header,
      warnings: [],
      parseErrors: [],
    };
  },
};
