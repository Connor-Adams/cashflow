import type { PdfLine, PdfParser, PdfParseResult, PdfStatementHeader } from './types';
import { normalizeMerchant } from '../normalizeMerchant';
import { MONTHS_SHORT, parseLongDate, parseMoney, toIso, type Period } from './dateHelpers';
import type { NormalizedHoldingSnapshot, NormalizedInvestmentActivity } from '../statementTypes';

/**
 * RBC investment statement parser — handles both:
 *   - Tax-Free Savings Account (TFSA, savings-deposit-only)
 *   - Registered Disability Savings Plan (RDSP, mutual funds + activity)
 *
 * Layout markers:
 *   Title:        "Your investment statement"
 *   Period:       "January 1, 2025 to December 31, 2025"
 *   Account:      "Your account number  435516430" (TFSA: label + digits on
 *                 same line), OR label on one line and "468184346  ..." on the
 *                 next (RDSP: label sits next to "Your branch" in a header row).
 *   Product:      "Tax-Free Savings Account" OR "Registered Disability Savings Plan"
 *
 * RDSP emits 3 array types:
 *   - transactions (cash side, usually empty)
 *   - investmentActivities (from "Your investment activity with Royal Mutual Funds Inc.")
 *   - holdings (from "Your investment details with Royal Mutual Funds Inc.")
 *
 * TFSA emits ~empty arrays (Opening Balance = Closing Balance, no real activity).
 */

const ACCOUNT_RE = /Your account number\s+(\d{7,12})/;
const ACCOUNT_LABEL_RE = /Your account number/i;
const ACCOUNT_DIGITS_RE = /^\s*(\d{7,12})\b/;
const PERIOD_HEADER_RE = /^([A-Z][a-z]+\s+\d{1,2},\s+\d{4})\s+to\s+([A-Z][a-z]+\s+\d{1,2},\s+\d{4})/;
const FUND_HEADING_RE = /^(.+?)\s+\(([A-Z]{3,4}\d{3,5})\)$/;
const ISO_DATE_RE = /^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{4})\b/; // "Dec 23 2025"
const MONEY_TOKEN_RE = /^-?[\d,]+\.\d{2,8}$/; // unit prices can have many decimals

/**
 * Yield trimmed lines inside the section between the first match of
 * `sectionRe` and the first subsequent match of `endRe` (or end of input).
 * Used by all three body parsers (holdings, activity, savings deposit) to
 * avoid duplicating the "scan until section, then break on end marker" loop.
 */
function* iterSection(
  lines: PdfLine[],
  sectionRe: RegExp,
  endRe: RegExp,
): Generator<{ line: PdfLine; text: string }> {
  let inSection = false;
  for (const l of lines) {
    const text = l.text.trim();
    if (!inSection) {
      if (sectionRe.test(text)) inSection = true;
      continue;
    }
    if (endRe.test(text)) return;
    yield { line: l, text };
  }
}

function isProductTfsa(lines: PdfLine[]): boolean {
  return lines.some((l) => /Tax-Free Savings Account/i.test(l.text));
}

function isProductRdsp(lines: PdfLine[]): boolean {
  return lines.some((l) => /Registered Disability Savings Plan/i.test(l.text));
}

export function parseRbcInvestmentHeader(lines: PdfLine[]): PdfStatementHeader {
  const page1 = lines.filter((l) => l.page === 1);

  let accountNumber: string | null = null;
  for (let i = 0; i < page1.length; i++) {
    const sameLine = ACCOUNT_RE.exec(page1[i].text);
    if (sameLine) {
      accountNumber = sameLine[1];
      break;
    }
    // RDSP layout: label "Your account number" sits on one line, the digits
    // appear on the next line (e.g. "468184346   1005 SPEERS RD").
    if (ACCOUNT_LABEL_RE.test(page1[i].text)) {
      const next = page1[i + 1];
      const nextMatch = next && ACCOUNT_DIGITS_RE.exec(next.text);
      if (nextMatch) {
        accountNumber = nextMatch[1];
        break;
      }
    }
  }
  if (!accountNumber) {
    throw new Error('RBC investment header: could not find account number');
  }
  const accountSuffix = accountNumber.slice(-4);

  // Find period: try a line that holds "<Long date> to <Long date>" first.
  let period: Period | null = null;
  for (const l of page1) {
    const m = PERIOD_HEADER_RE.exec(l.text.trim());
    if (!m) continue;
    const startIso = parseLongDate(m[1]);
    const endIso = parseLongDate(m[2]);
    if (startIso && endIso) {
      period = { start: startIso, end: endIso };
      break;
    }
  }
  if (!period) {
    throw new Error('RBC investment header: could not parse statement period');
  }

  let productLabel = 'RBC Investment';
  if (isProductTfsa(lines)) productLabel = 'Tax-Free Savings Account';
  else if (isProductRdsp(lines)) productLabel = 'Registered Disability Savings Plan';

  return {
    accountSuffix,
    productLabel,
    accountType: 'investment',
    periodStart: period.start,
    periodEnd: period.end,
  };
}

function parseShortDate(raw: string): string | null {
  const m = ISO_DATE_RE.exec(raw);
  if (!m) return null;
  const month = MONTHS_SHORT[m[1]];
  if (month === undefined) return null;
  return toIso(Number(m[3]), month, Number(m[2]));
}

/**
 * Extract holdings from the "Your investment details with Royal Mutual Funds Inc."
 * section. Each fund row follows a heading line like
 * "RBC Select Growth Portfolio - Sr. A (RBF459)" and lists the numeric columns:
 *   [book cost per unit] [units] [unit price] [value] [book cost total]
 */
function parseInvestmentDetails(
  lines: PdfLine[],
  statementDate: string,
  defaultCurrency: string,
): Omit<NormalizedHoldingSnapshot, 'sourceRowFingerprint'>[] {
  const holdings: Omit<NormalizedHoldingSnapshot, 'sourceRowFingerprint'>[] = [];

  let pendingFund: { name: string; symbol: string } | null = null;

  for (const { text } of iterSection(
    lines,
    /Your investment details with Royal Mutual Funds Inc\./i,
    /Your investment activity with Royal Mutual Funds Inc\./i,
  )) {
    if (/Total\s*\$/i.test(text)) {
      pendingFund = null;
      continue;
    }
    const fundHeading = FUND_HEADING_RE.exec(text);
    if (fundHeading) {
      pendingFund = { name: fundHeading[1].trim(), symbol: fundHeading[2].trim() };
      continue;
    }
    if (!pendingFund) continue;
    // Numeric row: collect money tokens left-to-right. We split by whitespace on
    // the line text rather than by pdfjs `items` because pdfjs sometimes glues
    // a whole row of numbers into a single positioned item (string includes the
    // spaces), which would never match MONEY_TOKEN_RE.
    const tokenStrs = text.split(/\s+/).filter((t) => MONEY_TOKEN_RE.test(t));
    if (tokenStrs.length < 4) continue;
    const values = tokenStrs.map(parseMoney);
    // Columns (per the RBC RDSP example):
    //   [book cost/unit] [units] [unit price] [value] [book cost total]
    const [_bcPerUnit, units, unitPrice, marketValue, bookCostTotal] = values;
    void _bcPerUnit;
    if (!Number.isFinite(units) || !Number.isFinite(marketValue)) {
      pendingFund = null;
      continue;
    }
    holdings.push({
      statementDate,
      security: {
        symbol: pendingFund.symbol,
        name: pendingFund.name,
        assetType: 'mutual_fund',
        currency: defaultCurrency,
      },
      quantity: units,
      price: Number.isFinite(unitPrice) ? unitPrice : null,
      marketValue,
      costBasis: Number.isFinite(bookCostTotal) ? bookCostTotal : null,
      unrealizedGainLoss: null,
      currency: defaultCurrency,
      sourceReference: null,
    });
    pendingFund = null;
  }

  return holdings;
}

/**
 * Extract investment activities from "Your investment activity with Royal
 * Mutual Funds Inc." section.
 *
 * Layout note: pdfjs splits each visual row into two y-buckets — the numeric
 * columns sit on the line just above the "Dec 23 2025  Income Reinvested" date
 * label (gap is ~1.1 user-space units, above our Y_TOLERANCE). So we cache the
 * most recent numeric-only line as `pendingNumerics` and attach it to the next
 * date row.
 *
 *   numerics:  "4,717.78  42.9500  109.844  2,299.066  98,744.88"   (line above)
 *   date row:  " Dec 23 2025   Income Reinvested"                   (line below)
 *
 * Skipped row labels (consume pendingNumerics so it doesn't bleed into the
 * next real activity): Opening Balance, Closing Balance, Income Record Date
 * Holdings, "(<per-unit-detail>)".
 */
function parseInvestmentActivity(
  lines: PdfLine[],
  defaultCurrency: string,
): Omit<NormalizedInvestmentActivity, 'sourceRowFingerprint'>[] {
  const activities: Omit<NormalizedInvestmentActivity, 'sourceRowFingerprint'>[] = [];

  let currentFund: { name: string; symbol: string } | null = null;
  let pendingNumerics: number[] = [];

  for (const { text } of iterSection(
    lines,
    /Your investment activity with Royal Mutual Funds Inc\./i,
    /How to reach us|Information about your account|News you can use/i,
  )) {
    const fundHeading = FUND_HEADING_RE.exec(text);
    if (fundHeading) {
      currentFund = { name: fundHeading[1].trim(), symbol: fundHeading[2].trim() };
      pendingNumerics = [];
      continue;
    }
    if (!currentFund) continue;

    // Drop ^ anchor on Opening/Closing Balance because they sometimes appear
    // alone ("Opening Balance") and sometimes prefixed with a date
    // ("Mar 31 2025  Closing Balance") — both must be skipped.
    if (/Opening Balance|Closing Balance|Income Record Date Holdings/i.test(text)) {
      pendingNumerics = [];
      continue;
    }
    if (/^\(.*per Unit\)/i.test(text)) {
      pendingNumerics = [];
      continue;
    }

    const dateMatch = ISO_DATE_RE.exec(text);
    if (dateMatch) {
      const tradeDate = parseShortDate(text);
      if (!tradeDate) {
        pendingNumerics = [];
        continue;
      }
      const afterDate = text.replace(ISO_DATE_RE, '').trim();
      const inlineMoney = afterDate.split(/\s+/).filter((t) => MONEY_TOKEN_RE.test(t)).map(parseMoney);
      const moneyCols = inlineMoney.length > 0 ? inlineMoney : pendingNumerics;
      pendingNumerics = [];

      const labelMatch = /^([A-Za-z][A-Za-z\s/]+?)\s+(-?[\d,]+\.\d{2,8}|$)/.exec(afterDate);
      const txLabel = labelMatch ? labelMatch[1].trim() : afterDate.split(/\s{2,}/)[0];

      // Columns per RBC: amount, unit_price, units, total_units, total_value
      const [amount, unitPrice, units] = moneyCols;
      if (amount == null) continue;

      activities.push({
        activityType: classifyActivityType(txLabel),
        tradeDate,
        settlementDate: null,
        description: `${txLabel} — ${currentFund.name}`,
        security: {
          symbol: currentFund.symbol,
          name: currentFund.name,
          assetType: 'mutual_fund',
          currency: defaultCurrency,
        },
        quantity: Number.isFinite(units) ? units : null,
        price: Number.isFinite(unitPrice) ? unitPrice : null,
        amount: Number.isFinite(amount) ? amount : null,
        fees: null,
        currency: defaultCurrency,
        sourceReference: null,
      });
      continue;
    }

    // Numeric-only line: cache for the date row that follows on the next y-bucket.
    const parts = text.split(/\s+/).filter((t) => t.length > 0);
    const numericTokens = parts.filter((t) => MONEY_TOKEN_RE.test(t));
    if (parts.length > 0 && numericTokens.length === parts.length) {
      pendingNumerics = numericTokens.map(parseMoney);
    } else {
      pendingNumerics = [];
    }
  }

  return activities;
}

function classifyActivityType(label: string): NormalizedInvestmentActivity['activityType'] {
  const t = label.toLowerCase();
  if (/reinvest/.test(t)) return 'reinvestment';
  if (/income|dividend|distribution/.test(t)) return 'dividend';
  if (/interest/.test(t)) return 'interest';
  if (/buy|purchase/.test(t)) return 'buy';
  if (/sell|redemption/.test(t)) return 'sell';
  if (/fee|commission/.test(t)) return 'fee';
  if (/transfer/.test(t)) return 'transfer';
  return 'other';
}

/**
 * Parse the "Your savings deposit activity" cash-side rows (TFSA only).
 * Most TFSA statements show just Opening/Closing balance — no real txns.
 */
function parseSavingsDeposit(
  lines: PdfLine[],
  defaultCurrency: string,
  periodEnd: string,
): PdfParseResult['transactions'] {
  void periodEnd;
  const txns: PdfParseResult['transactions'] = [];
  for (const { line: l, text } of iterSection(
    lines,
    /Your savings deposit activity/i,
    /Your investment activity|Information about your account/i,
  )) {
    if (/^Opening Balance|^Closing Balance|^RBC Savings Deposit|^Transaction\b/i.test(text)) continue;
    // Real txn rows would look like "Dec 23 2025  Description  100.00  …" — none in our samples.
    const dateMatch = ISO_DATE_RE.exec(text);
    if (!dateMatch) continue;
    const date = parseShortDate(text);
    if (!date) continue;
    const moneyTokens = (l.items ?? [])
      .filter((it) => MONEY_TOKEN_RE.test(it.str))
      .map((it) => parseMoney(it.str));
    if (moneyTokens.length === 0) continue;
    const desc = text.replace(ISO_DATE_RE, '').trim().split(/\s{2,}/)[0]?.trim() ?? 'Savings deposit activity';
    const amount = moneyTokens[0];
    if (!Number.isFinite(amount)) continue;
    txns.push({
      date,
      merchantRaw: desc,
      merchantClean: normalizeMerchant(desc),
      amount,
      currency: defaultCurrency,
      sourceReference: null,
    });
  }
  return txns;
}

export const rbcInvestmentParser: PdfParser = {
  id: 'rbc_investment',
  label: 'RBC Investment (TFSA / RDSP)',
  sniff: (lines) => {
    const hasInvestmentTitle = lines.some((l) => /Your investment statement/i.test(l.text));
    if (!hasInvestmentTitle) return false;
    return isProductTfsa(lines) || isProductRdsp(lines);
  },
  parse: (lines, ctx): PdfParseResult => {
    const header = parseRbcInvestmentHeader(lines);
    const transactions = parseSavingsDeposit(lines, ctx.defaultCurrency, header.periodEnd);
    const investmentActivities = parseInvestmentActivity(lines, ctx.defaultCurrency);
    const holdings = parseInvestmentDetails(lines, header.periodEnd, ctx.defaultCurrency);

    return {
      transactions,
      investmentActivities,
      holdings,
      header,
      warnings: [],
      parseErrors: [],
    };
  },
};
