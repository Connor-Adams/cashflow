import type { PdfLine, PdfParser, PdfParseResult, PdfStatementHeader } from './types';
import { normalizeMerchant } from '../normalizeMerchant';
import { parseLongDate, toIso } from './dateHelpers';
import type { NormalizedHoldingSnapshot, NormalizedInvestmentActivity } from '../statementTypes';

/**
 * Questrade Account Statement parser — handles all Questrade individual
 * account types (Margin, FHSA, TFSA, RRSP, Cash) under one sniff. Layout
 * markers are identical across types; only the "Type:" label and which
 * sections appear differ.
 *
 * Sniff:
 *   - "QUESTRADE" logo text on page 1
 *   - "Order execution only account" on page 1
 *
 * Header (page 1):
 *   "Account #: 28852545   Current month: October 31, 2023"
 *   "Type: Individual Margin" / "Type: Individual Tax-Free First Home Savings"
 *
 * Holdings (section 03 — "Stocks owned" / "Exchange-traded funds (ETFs) owned"):
 *   Subsection headers "Securities held in CAD" / "Securities held in USD"
 *   gate the row currency. Each row is whitespace-delimited:
 *     <SYMBOL> <NAME...> <CB-CODE> <qty> <segr> <cost/share> <pos.cost>
 *     <mkt.price> <mkt.value> <P&L> <%return> <%port>
 *   CB-CODE is BK / HMV / ND.
 *
 * Activities (section 04 — "Transactions"):
 *   Each row is whitespace-delimited:
 *     <mm-dd-yyyy trans> <mm-dd-yyyy settle> [activity] [symbol] [inline-desc]
 *     <qty> <CAD: price gross com net> <USD: price gross com net>
 *   Multi-line descriptions wrap onto adjacent y-buckets (±~3.4 units).
 *   Currency per row is whichever Net column has a value.
 */

const ACCOUNT_RE = /Account #:\s*(\d{6,12})/;
const CURRENT_MONTH_RE = /Current month:\s*([A-Z][a-z]+\s+\d{1,2},\s+\d{4})/;
const TXN_DATE_PREFIX_RE = /^(\d{2})-(\d{2})-(\d{4})\s+(\d{2})-(\d{2})-(\d{4})\b/;
const TXN_DATE_RE = /^(\d{2})-(\d{2})-(\d{4})$/;
// Accept whole-dollar amounts (qty=2), parenthesized negatives ((206.24)),
// decimals (50.010), and bare dashes for empty cells.
const MONEY_OR_DASH_RE = /^(?:-|-?\(?[\d,]+(?:\.\d{1,8})?\)?)$/;
const CB_CODE_RE = /^(BK|HMV|ND)$/;
const NUMERIC_RE = /^-?\(?[\d,]+(?:\.\d{1,8})?\)?$/;
const ACTIVITY_END_RE = /Glossary|For your information|^\s*05\.|^\s*06\./i;

// y-bucket spacing inside a wrapped activity row is ~3.4 units (the row's
// own line plus one above + one below) and ~6.7 units for two-bucket gaps
// (e.g. a section name preceding a date row). Date-to-date row spacing is
// ~17 units, so we keep the tolerance below that with a margin.
const NEIGHBOR_Y_TOLERANCE = 8;

function parseQuestradeDate(mmddyyyy: string): string {
  const m = TXN_DATE_RE.exec(mmddyyyy);
  if (!m) throw new Error(`Bad Questrade date: ${mmddyyyy}`);
  return toIso(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
}

function parseMoneyOrNull(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '-') return null;
  const cleaned = trimmed.replace(/[\s$,]/g, '');
  if (cleaned.startsWith('(') && cleaned.endsWith(')')) {
    const n = Number(cleaned.slice(1, -1));
    return Number.isFinite(n) ? -n : null;
  }
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function detectProductLabel(page1: PdfLine[]): string {
  const all = page1.map((l) => l.text).join(' ');
  if (/Tax-Free First Home Savings|FHSA/i.test(all)) return 'Individual FHSA';
  if (/Individual Margin/i.test(all)) return 'Individual Margin';
  if (/Tax-Free Savings|\bTFSA\b/i.test(all)) return 'Individual TFSA';
  if (/Retirement Savings|\bRRSP\b/i.test(all)) return 'Individual RRSP';
  if (/Individual Cash/i.test(all)) return 'Individual Cash';
  return 'Questrade Investment';
}

export function parseQuestradeHeader(lines: PdfLine[]): PdfStatementHeader {
  const page1 = lines.filter((l) => l.page === 1);

  let accountNumber: string | null = null;
  for (const l of page1) {
    const m = ACCOUNT_RE.exec(l.text);
    if (m) {
      accountNumber = m[1];
      break;
    }
  }
  if (!accountNumber) throw new Error('Questrade header: account number missing');

  let periodEnd: string | null = null;
  for (const l of page1) {
    const m = CURRENT_MONTH_RE.exec(l.text);
    if (!m) continue;
    const iso = parseLongDate(m[1]);
    if (iso) {
      periodEnd = iso;
      break;
    }
  }
  if (!periodEnd) throw new Error('Questrade header: current-month date missing');

  // Period start = first day of the calendar month of periodEnd. Questrade
  // statements are monthly; activity rows from late prior month can appear
  // (e.g. trade-date Sep 28 in an Oct statement) but month-of-end is the
  // canonical window used for fingerprinting.
  const periodStart = `${periodEnd.slice(0, 8)}01`;

  return {
    accountSuffix: accountNumber.slice(-4),
    productLabel: detectProductLabel(page1),
    accountType: 'investment',
    periodStart,
    periodEnd,
  };
}

function* iterSection(
  lines: PdfLine[],
  startRe: RegExp,
  endRe: RegExp,
): Generator<PdfLine> {
  let inside = false;
  for (const l of lines) {
    if (!inside) {
      if (startRe.test(l.text)) inside = true;
      continue;
    }
    if (endRe.test(l.text)) return;
    yield l;
  }
}

function guessAssetType(sectionLabel: string, _symbol: string): NormalizedHoldingSnapshot['security']['assetType'] {
  void _symbol;
  if (/Exchange-traded funds|ETFs/i.test(sectionLabel)) return 'etf';
  if (/Mutual funds/i.test(sectionLabel)) return 'mutual_fund';
  if (/Bonds/i.test(sectionLabel)) return 'bond';
  if (/Options/i.test(sectionLabel)) return 'option';
  return 'stock';
}

function parseHoldingRow(text: string): {
  symbol: string;
  name: string;
  numerics: number[];
} | null {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 11) return null;
  // Find the first BK/HMV/ND cost-basis code that has 9 contiguous numeric
  // tokens immediately following it. Symbol = parts[0]; name spans the gap.
  // Trailing non-numeric tokens (right-side glossary text that pdfjs merges
  // into the same y-bucket) are ignored.
  let cbIdx = -1;
  for (let i = 1; i <= parts.length - 10; i++) {
    if (!CB_CODE_RE.test(parts[i])) continue;
    const tail = parts.slice(i + 1, i + 10);
    if (tail.every((t) => NUMERIC_RE.test(t))) {
      cbIdx = i;
      break;
    }
  }
  if (cbIdx === -1) return null;
  const symbol = parts[0];
  const name = parts.slice(1, cbIdx).join(' ');
  const numerics = parts.slice(cbIdx + 1, cbIdx + 10).map((t) => parseMoneyOrNull(t) ?? NaN);
  if (numerics.some((n) => !Number.isFinite(n))) return null;
  return { symbol, name, numerics };
}

function parseHoldings(
  lines: PdfLine[],
  statementDate: string,
): Omit<NormalizedHoldingSnapshot, 'sourceRowFingerprint'>[] {
  const holdings: Omit<NormalizedHoldingSnapshot, 'sourceRowFingerprint'>[] = [];

  // The "03. INVESTMENT DETAILS" banner appears split across y-buckets ("03.
  // INVESTMENT" + "DETAILS") AND repeats on the page-1 table-of-contents, so
  // gating on it is unreliable. Instead, scan the whole document, track the
  // current section (Stocks / ETFs / Mutual funds…) and the current currency
  // subsection ("Securities held in CAD/USD"), and stop the moment we hit
  // the activities table or its preceding "Cash changes" recap.
  //
  // Section title text is split across y-buckets ("Exchange-traded funds
  // (ETFs)" then "owned"), so don't anchor on the "owned" suffix.
  const SECTION_HEADERS_RE = /^(Stocks|Exchange-traded funds|Mutual funds|Bonds|Options)\b/i;
  const SUBSECTION_RE = /^Securities held in (CAD|USD)\b/i;
  const STOP_RE = /Cash changes|^\s*Transactions\s*$|04\.\s*ACTIVITY DETAILS/i;

  let currentSection: string | null = null;
  let currentCurrency = 'CAD';

  for (const l of lines) {
    const text = l.text.trim();
    if (STOP_RE.test(text)) break;
    const sectionMatch = SECTION_HEADERS_RE.exec(text);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      continue;
    }
    const subMatch = SUBSECTION_RE.exec(text);
    if (subMatch) {
      currentCurrency = subMatch[1].toUpperCase();
      continue;
    }
    if (!currentSection) continue;
    if (/^Market Value/i.test(text)) continue;
    if (/^Symbol\s+Description/i.test(text)) continue;

    const row = parseHoldingRow(text);
    if (!row) continue;

    const [qty, _segr, _costPerShare, posCost, mktPrice, mktValue, pl] = row.numerics;
    void _segr; void _costPerShare;
    holdings.push({
      statementDate,
      security: {
        symbol: row.symbol,
        name: row.name,
        assetType: guessAssetType(currentSection, row.symbol),
        currency: currentCurrency,
      },
      quantity: qty,
      price: Number.isFinite(mktPrice) ? mktPrice : null,
      marketValue: Number.isFinite(mktValue) ? mktValue : null,
      costBasis: Number.isFinite(posCost) ? posCost : null,
      unrealizedGainLoss: Number.isFinite(pl) ? pl : null,
      currency: currentCurrency,
      sourceReference: null,
    });
  }

  return holdings;
}

function classifyActivity(
  activityCell: string | null,
  description: string,
): NormalizedInvestmentActivity['activityType'] {
  if (activityCell) {
    const a = activityCell.toLowerCase();
    if (a === 'buy') return 'buy';
    if (a === 'sell') return 'sell';
    if (a === 'wdr') return 'transfer';
    if (a === 'dep') return 'cash_movement';
    if (a === 'contribution') return 'cash_movement';
    if (a === 'div' || a === 'dividend') return 'dividend';
    if (a === 'drip' || a.includes('reinvest')) return 'reinvestment';
    if (a === 'trf') return 'transfer';
    if (a === 'int' || a === 'interest') return 'interest';
    if (a === 'fee' || a === 'com') return 'fee';
  }
  const d = description.toLowerCase();
  if (/^int\s|^int\b/.test(d)) return 'interest';
  if (/contribution|deposit/.test(d)) return 'cash_movement';
  if (/deregistration|transfer/.test(d)) return 'transfer';
  if (/dividend/.test(d)) return 'dividend';
  if (/reinvest/.test(d)) return 'reinvestment';
  if (/fee|commission/.test(d)) return 'fee';
  return 'other';
}

type ActivityRow = {
  tradeDate: string;
  settlementDate: string;
  activityCell: string | null;
  symbolCell: string | null;
  inlineDesc: string;
  qty: number | null;
  cad: { price: number | null; gross: number | null; com: number | null; net: number | null };
  usd: { price: number | null; gross: number | null; com: number | null; net: number | null };
};

function parseActivityRow(text: string): ActivityRow | null {
  const cells = text.split(/\s{2,}/).map((s) => s.trim()).filter((s) => s.length > 0);
  if (cells.length < 11) return null;
  const dateMatch = TXN_DATE_PREFIX_RE.exec(text);
  if (!dateMatch) return null;
  const tradeDate = parseQuestradeDate(cells[0]);
  const settlementDate = parseQuestradeDate(cells[1]);

  // Walk from the end collecting up to 9 numeric/dash tokens.
  const tail: string[] = [];
  let i = cells.length - 1;
  while (i >= 2 && tail.length < 9 && MONEY_OR_DASH_RE.test(cells[i])) {
    tail.unshift(cells[i]);
    i--;
  }
  // Pad-left with '-' if fewer than 9 found (some interest-only rows are
  // missing the leading Activity/Symbol dashes, which the y-bucket layout
  // sometimes drops entirely).
  while (tail.length < 9) tail.unshift('-');

  const middle = cells.slice(2, i + 1);
  const activityCell = middle[0] && middle[0] !== '-' ? middle[0] : null;
  const symbolCell = middle[1] && middle[1] !== '-' ? middle[1] : null;
  const inlineDesc = middle.slice(2).join(' ').trim();

  const [qtyS, cadPS, cadGS, cadCS, cadNS, usdPS, usdGS, usdCS, usdNS] = tail;
  return {
    tradeDate,
    settlementDate,
    activityCell,
    symbolCell,
    inlineDesc,
    qty: parseMoneyOrNull(qtyS),
    cad: {
      price: parseMoneyOrNull(cadPS),
      gross: parseMoneyOrNull(cadGS),
      com: parseMoneyOrNull(cadCS),
      net: parseMoneyOrNull(cadNS),
    },
    usd: {
      price: parseMoneyOrNull(usdPS),
      gross: parseMoneyOrNull(usdGS),
      com: parseMoneyOrNull(usdCS),
      net: parseMoneyOrNull(usdNS),
    },
  };
}

function collectNeighborDesc(
  sectionLines: PdfLine[],
  row: PdfLine,
): string {
  const above: string[] = [];
  const below: string[] = [];
  for (const n of sectionLines) {
    if (n === row) continue;
    if (n.page !== row.page) continue;
    const dy = n.y - row.y;
    if (Math.abs(dy) > NEIGHBOR_Y_TOLERANCE) continue;
    if (TXN_DATE_PREFIX_RE.test(n.text)) continue;
    if (/Opening balance|Closing balance/.test(n.text)) continue;
    const t = n.text.trim();
    if (!t) continue;
    if (dy > 0) above.push(t);
    else below.push(t);
  }
  return [...above, ...below].join(' ').replace(/\s+/g, ' ').trim();
}

function parseActivities(
  lines: PdfLine[],
): {
  activities: Omit<NormalizedInvestmentActivity, 'sourceRowFingerprint'>[];
  transactions: PdfParseResult['transactions'];
} {
  const activities: Omit<NormalizedInvestmentActivity, 'sourceRowFingerprint'>[] = [];
  const transactions: PdfParseResult['transactions'] = [];

  const sectionLines: PdfLine[] = [];
  for (const l of iterSection(lines, /04\.\s*ACTIVITY DETAILS.*Transactions|^\s*Transactions\s*$/i, ACTIVITY_END_RE)) {
    sectionLines.push(l);
  }
  // Some statements split the header across pages; fall back to a simpler
  // start anchor if the combined "04. ACTIVITY DETAILS" + "Transactions"
  // marker wasn't seen.
  if (sectionLines.length === 0) {
    for (const l of iterSection(lines, /Trans Date\.?\s+Settle Date/i, ACTIVITY_END_RE)) {
      sectionLines.push(l);
    }
  }

  for (const row of sectionLines) {
    if (!TXN_DATE_PREFIX_RE.test(row.text)) continue;
    const parsed = parseActivityRow(row.text);
    if (!parsed) continue;

    const desc = [
      collectNeighborDesc(sectionLines, row),
      parsed.inlineDesc,
    ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

    const usdLeg = parsed.usd.net !== null;
    const cadLeg = parsed.cad.net !== null;
    const currency = usdLeg ? 'USD' : cadLeg ? 'CAD' : 'CAD';
    const leg = currency === 'USD' ? parsed.usd : parsed.cad;

    const cleanSymbol = parsed.symbolCell ? parsed.symbolCell.replace(/^\./, '') : null;
    const activityType = classifyActivity(parsed.activityCell, desc);
    const security =
      cleanSymbol && /^[A-Z][A-Z0-9.]{0,9}$/.test(cleanSymbol)
        ? {
            symbol: cleanSymbol,
            name: desc || cleanSymbol,
            assetType: null,
            currency,
          }
        : null;

    activities.push({
      activityType,
      tradeDate: parsed.tradeDate,
      settlementDate: parsed.settlementDate,
      description: desc || parsed.activityCell || 'Questrade activity',
      security,
      quantity: parsed.qty,
      price: leg.price,
      amount: leg.net,
      fees: leg.com,
      currency,
      sourceReference: null,
    });

    // Cash-side mirror for deposit/withdrawal-like activities so they appear
    // in the cashflow ledger.
    if (
      (activityType === 'cash_movement' || activityType === 'transfer') &&
      leg.net !== null
    ) {
      const merchant = desc || parsed.activityCell || 'Questrade transfer';
      transactions.push({
        date: parsed.tradeDate,
        merchantRaw: merchant,
        merchantClean: normalizeMerchant(merchant),
        amount: leg.net,
        currency,
        sourceReference: null,
      });
    }
  }

  return { activities, transactions };
}

export const questradeParser: PdfParser = {
  id: 'questrade',
  label: 'Questrade Account Statement',
  sniff: (lines) => {
    // Require a Questrade-specific LAYOUT marker ("Account #: <digits>") in
    // addition to the brand + order-execution markers. A Wealthsimple
    // brokerage statement can mention "Questrade" (e.g. a transfer-in line)
    // and carry "Order execution only account"; the WS layout uses
    // "Account number", never "Account #:", so this header anchor keeps a WS
    // statement from being mis-claimed (the WS brokerage parser is registered
    // after questrade and excludes Questrade-mentioning statements itself).
    let hasQuestrade = false;
    let hasOrderExec = false;
    let hasAccountHeader = false;
    for (const l of lines) {
      if (/Questrade/i.test(l.text)) hasQuestrade = true;
      if (/Order execution only account/i.test(l.text)) hasOrderExec = true;
      if (ACCOUNT_RE.test(l.text)) hasAccountHeader = true;
      if (hasQuestrade && hasOrderExec && hasAccountHeader) return true;
    }
    return false;
  },
  parse: (lines, _ctx): PdfParseResult => {
    void _ctx;
    const header = parseQuestradeHeader(lines);
    const holdings = parseHoldings(lines, header.periodEnd);
    const { activities, transactions } = parseActivities(lines);
    return {
      transactions,
      investmentActivities: activities,
      holdings,
      header,
      warnings: [],
      parseErrors: [],
    };
  },
};
