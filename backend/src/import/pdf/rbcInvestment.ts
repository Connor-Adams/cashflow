import type { PdfLine, PdfParser, PdfParseResult, PdfStatementHeader, PdfTextSpan } from './types';
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
 *   Account:      "Your account number  435516430"  (number, no dash)
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
const PERIOD_HEADER_RE = /^([A-Z][a-z]+\s+\d{1,2},\s+\d{4})\s+to\s+([A-Z][a-z]+\s+\d{1,2},\s+\d{4})/;
const FUND_HEADING_RE = /^(.+?)\s+\(([A-Z]{3,4}\d{3,5})\)$/;
const ISO_DATE_RE = /^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{4})\b/; // "Dec 23 2025"
const MONEY_TOKEN_RE = /^-?[\d,]+\.\d{2,8}$/; // unit prices can have many decimals

function isProductTfsa(lines: PdfLine[]): boolean {
  return lines.some((l) => /Tax-Free Savings Account/i.test(l.text));
}

function isProductRdsp(lines: PdfLine[]): boolean {
  return lines.some((l) => /Registered Disability Savings Plan/i.test(l.text));
}

export function parseRbcInvestmentHeader(lines: PdfLine[]): PdfStatementHeader {
  const page1 = lines.filter((l) => l.page === 1);

  let accountNumber: string | null = null;
  for (const l of page1) {
    const m = ACCOUNT_RE.exec(l.text);
    if (m) {
      accountNumber = m[1];
      break;
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

  let inSection = false;
  let pendingFund: { name: string; symbol: string } | null = null;

  for (const l of lines) {
    const text = l.text.trim();
    if (/Your investment details with Royal Mutual Funds Inc\./i.test(text)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (/Your investment activity with Royal Mutual Funds Inc\./i.test(text)) break;
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
    // Numeric row: collect money tokens left-to-right.
    const items = l.items ?? [];
    const tokens: PdfTextSpan[] = items.length > 0
      ? items.filter((it) => MONEY_TOKEN_RE.test(it.str))
      : text.split(/\s{2,}/).filter((t) => MONEY_TOKEN_RE.test(t)).map((t, i) => ({ x: i * 100, width: 0, str: t }));
    if (tokens.length < 4) continue;
    const values = tokens.map((t) => parseMoney(t.str));
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
 * Mutual Funds Inc." section. Each fund subsection lists per-date rows like:
 *
 *   "Dec 23 2025  Income Reinvested  4,717.78  42.9500  109.844  2,299.066  98,744.88"
 *   "(2.1550000 per Unit)  0.0000  0.000"
 *
 * Skipped row labels: Opening Balance, Closing Balance, Income Record Date Holdings,
 * "(<per-unit-detail>)".
 */
function parseInvestmentActivity(
  lines: PdfLine[],
  defaultCurrency: string,
): Omit<NormalizedInvestmentActivity, 'sourceRowFingerprint'>[] {
  const activities: Omit<NormalizedInvestmentActivity, 'sourceRowFingerprint'>[] = [];

  let inSection = false;
  let currentFund: { name: string; symbol: string } | null = null;

  for (const l of lines) {
    const text = l.text.trim();
    if (/Your investment activity with Royal Mutual Funds Inc\./i.test(text)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    // End markers: next major section or page footer.
    if (/How to reach us|Information about your account|News you can use/i.test(text)) break;

    const fundHeading = FUND_HEADING_RE.exec(text);
    if (fundHeading) {
      currentFund = { name: fundHeading[1].trim(), symbol: fundHeading[2].trim() };
      continue;
    }
    if (!currentFund) continue;

    if (/^Opening Balance|^Closing Balance|Income Record Date Holdings/i.test(text)) continue;
    if (/^\(.*per Unit\)/i.test(text)) continue;

    const dateMatch = ISO_DATE_RE.exec(text);
    if (!dateMatch) continue;
    const tradeDate = parseShortDate(text);
    if (!tradeDate) continue;

    // Remove the leading date token + transaction label, then collect money cols.
    const afterDate = text.replace(ISO_DATE_RE, '').trim();
    const labelMatch = /^([A-Za-z][A-Za-z\s/]+?)\s+(-?[\d,]+\.\d{2,8}|$)/.exec(afterDate);
    const txLabel = labelMatch ? labelMatch[1].trim() : afterDate.split(/\s{2,}/)[0];
    const moneyCols = (l.items ?? [])
      .filter((it) => MONEY_TOKEN_RE.test(it.str))
      .map((it) => parseMoney(it.str));
    const fallbackTokens = moneyCols.length === 0
      ? afterDate.split(/\s+/).filter((t) => MONEY_TOKEN_RE.test(t)).map(parseMoney)
      : moneyCols;
    // Columns per RBC: amount, unit_price, units, total_units, total_value
    const [amount, unitPrice, units] = fallbackTokens;
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
  let inSection = false;
  for (const l of lines) {
    const text = l.text.trim();
    if (/Your savings deposit activity/i.test(text)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (/Your investment activity|Information about your account/i.test(text)) break;
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
