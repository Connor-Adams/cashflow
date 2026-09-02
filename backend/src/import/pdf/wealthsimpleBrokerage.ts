import type { PdfLine, PdfParser, PdfParseResult, PdfStatementHeader } from './types';
import type {
  NormalizedHoldingSnapshot,
  NormalizedInvestmentActivity,
} from '../statementTypes';
import { normalizeMerchant } from '../normalizeMerchant';
import {
  wsPdfCodeToActivity,
  WS_PDF_SKIP_CODES,
  wsPdfCashCodeToTxnType,
  wsPdfDepositCodeToTxnType,
  wsPdfCodeTypeIsAuthoritative,
} from './wealthsimpleActivityCodes';

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

/**
 * Find the account-type label line, e.g. "Tax-Free Savings SDI Cash Account"
 * or "Self-directed Non-Registered Cash Account". It reliably sits on page 1
 * as the line ending in "Account" immediately after the "Phone:" line (the
 * address block). We MUST scope to this line: a full-document scan picks up
 * the page-5 "Information about Statement Codes" legend (which contains code
 * descriptions like "WDQ - FHSA Qualifying withdrawal" and "Tax-free transfer
 * into the…"), mislabeling Non-Registered accounts as FHSA/TFSA.
 */
function findAccountTypeLabel(lines: PdfLine[]): string {
  const page1 = lines.filter((l) => l.page === 1);
  const phoneIdx = page1.findIndex((l) => /Phone:/i.test(l.text));
  const ACCOUNT_LABEL_RE = /Account$/;
  if (phoneIdx >= 0) {
    const after = page1
      .slice(phoneIdx + 1)
      .find((l) => ACCOUNT_LABEL_RE.test(l.text.trim()));
    if (after) return after.text.trim();
  }
  // Fallback: first page-1 line that both ends in "Account" and carries an
  // account-type keyword (avoids matching e.g. a stray "Account" heading).
  const fallback = page1.find(
    (l) =>
      ACCOUNT_LABEL_RE.test(l.text.trim()) &&
      /(Tax-Free|First Home|Retirement|Registered Education|Non-Registered|Margin|TFSA|FHSA|RRSP|RESP|Crypto|Chequing|Savings|Cash)/i.test(
        l.text,
      ),
  );
  return fallback ? fallback.text.trim() : '';
}

function detectProductLabel(lines: PdfLine[]): string {
  // Classify ONLY the account-type label line, not the whole document.
  const label = findAccountTypeLabel(lines);
  // Order matters: registered-account markers win over the generic
  // Margin/Non-Registered fallback.
  if (/Tax-Free Savings|\bTFSA\b/i.test(label)) return 'Wealthsimple TFSA';
  if (/First Home Savings|\bFHSA\b/i.test(label)) return 'Wealthsimple FHSA';
  if (/Retirement Savings|\bRRSP\b/i.test(label)) return 'Wealthsimple RRSP';
  if (/Registered Education|\bRESP\b/i.test(label)) return 'Wealthsimple RESP';
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

type Activity = Omit<NormalizedInvestmentActivity, 'sourceRowFingerprint'>;
type CashTxn = PdfParseResult['transactions'][number];

/**
 * Cash-account "Transaction" codes. WS Cash / Chequing / Savings accounts flow
 * through THIS brokerage parser (same sniff), and list debit-card spend, bill
 * payments, e-transfers and account funding in the same order-execution
 * activity table. These codes are NOT in the InvestmentActivity taxonomy
 * (wsPdfCodeToActivity returns null for them), so instead of warn-skipping them
 * as "unmapped", we emit them as cash Transaction rows. The activityType
 * taxonomy in wealthsimpleActivityCodes.ts is left untouched — this set is the
 * brokerage parser's local concern.
 */
const CASH_TXN_CODES = new Set<string>([
  'SPEND', 'DCTFEE', 'OBP', 'CASHBACK', 'GIVEAWAY',
  'AFT_IN', 'AFT_OUT', 'P2P_IN', 'P2P_OUT', 'E_TRFIN', 'E_TRFOUT', 'EFT',
]);

const DATE_CELL_RE = /^\d{4}-\d{2}-\d{2}$/;
// Activity code cell. WS codes are all-caps but some carry underscores
// (AFT_IN, AFT_OUT, P2P_IN, P2P_OUT, E_TRFIN, E_TRFOUT) — these must be
// recognized as code cells so their rows are detected and routed (the cash
// ones to Transactions via CASH_TXN_CODES, the rest to InvestmentActivity /
// skip), not silently dropped / merged into a neighbor's description.
const CODE_CELL_RE = /^[A-Z][A-Z0-9_]*$/;
const TRADE_DATE_RE = /(?:executed at|received on)\s+(\d{4}-\d{2}-\d{2})/i;
const QTY_RE = /\b(?:Bought|Sold)\s+([\d.]+)\s+shares?/i;
// Commodity trades quote a unit rather than "shares" ("Bought 0.02 ounces …").
const QTY_UNIT_RE = /\b(?:Bought|Sold)\s+([\d.]+)\s+(?:ounces?|units?)\b/i;
// Crypto trades have no "<TICKER> - <Name>:" prefix and no "shares" keyword
// ("Purchase of 0.029 ETH (executed at …)" / "Sale of 4.0 XRP …"). Mirrors
// CRYPTO_BUYSELL_RE in wealthsimpleInvestParse.ts.
const QTY_CRYPTO_RE = /\b(?:Purchase|Sale)\s+of\s+([\d.]+)\s+[A-Z0-9]+\b/i;
// "SYM - Some Security Name: ..." → symbol + name. Name is non-greedy up to
// the first colon (the colon separates the security from the action clause).
const SECURITY_RE = /^([A-Z0-9.]+)\s*-\s*(.+?):/;
// Crypto security form (no ticker/name prefix). Symbol doubles as the name,
// assetType is cryptocurrency — matches how wealthsimpleInvestParse.ts builds
// the crypto security from CRYPTO_BUYSELL_RE.
const SECURITY_CRYPTO_RE =
  /^(?:Purchase|Sale)\s+of\s+[\d.]+\s+([A-Z0-9]+)\s*\(executed at/i;
const ACTIVITY_STOP_RE =
  /LEVERAGE DISCLOSURE|STATEMENT NOTES|Information about Statement Codes/i;
// Per-page footer noise on amended statements ("Amended - Version: 2   3/6")
// and bare page-number lines ("3/6") that must NOT accumulate onto the pending
// activity's description (which would clobber its symbol/qty wrap tail).
const ACTIVITY_NOISE_RE = /Amended\s*-\s*Version|^\d+\/\d+$/i;

type PendingRow = {
  date: string;
  code: string;
  debit: number;
  credit: number;
  descParts: string[];
};

/** True when a tokenized line opens a new activity row. */
function isActivityRow(cols: string[]): boolean {
  if (cols.length < 4) return false;
  if (!DATE_CELL_RE.test(cols[0])) return false;
  if (!CODE_CELL_RE.test(cols[1])) return false;
  const last = cols.length - 1;
  return (
    MONEY_CELL_RE.test(cols[last - 2]) &&
    MONEY_CELL_RE.test(cols[last - 1]) &&
    MONEY_CELL_RE.test(cols[last])
  );
}

function buySell(code: string): boolean {
  const a = wsPdfCodeToActivity(code);
  return a === 'buy' || a === 'sell';
}

/**
 * Turn a WS code's TxnType into the right field on the emitted transaction:
 * an override when the code names what the row IS, a hint when it only names
 * the direction the money moved and the narrative may know better.
 */
function cashTyping(
  code: string,
  txnType: ReturnType<typeof wsPdfCashCodeToTxnType>,
): { overrideTxnType?: NonNullable<typeof txnType> } | { txnTypeHint?: NonNullable<typeof txnType> } {
  if (!txnType) return {};
  return wsPdfCodeTypeIsAuthoritative(code)
    ? { overrideTxnType: txnType }
    : { txnTypeHint: txnType };
}

/**
 * Security named by an activity description, or null for a cash-only row.
 * The "SYM - Name:" form covers equities + commodities (e.g. "GOLD -
 * Physically backed gold: …"); the crypto form has no such prefix, so the
 * symbol doubles as the name and is tagged cryptocurrency.
 */
function securityFromDescription(
  description: string,
  currency: string,
): Activity['security'] {
  const secMatch = SECURITY_RE.exec(description);
  if (secMatch) {
    return {
      symbol: secMatch[1].toUpperCase(),
      name: secMatch[2].trim(),
      assetType: null,
      currency,
    };
  }
  const cryptoMatch = SECURITY_CRYPTO_RE.exec(description);
  if (cryptoMatch) {
    const sym = cryptoMatch[1].toUpperCase();
    return { symbol: sym, name: sym, assetType: 'cryptocurrency', currency };
  }
  return null;
}

/**
 * Everything both routing branches need from a finished activity row, derived
 * once: the two money columns are Charged ($) and Credit ($), so
 * amount = credit − charged (SPEND/AFT_OUT/P2P_OUT are outflows → negative;
 * E_TRFIN/CASHBACK are inflows → positive), and the wrap-aware description
 * doubles as the merchant.
 */
type RowContext = {
  code: string;
  activityType: ReturnType<typeof wsPdfCodeToActivity>;
  description: string;
  tradeDate: string;
  amount: number;
  currency: string;
  security: Activity['security'];
};

function rowContext(row: PendingRow, currency: string): RowContext {
  const description = row.descParts.join(' ').replace(/\s+/g, ' ').trim();
  const tradeMatch = TRADE_DATE_RE.exec(description);
  return {
    code: row.code,
    activityType: wsPdfCodeToActivity(row.code),
    description,
    tradeDate: tradeMatch ? tradeMatch[1] : row.date,
    amount: Number((row.credit - row.debit).toFixed(4)),
    currency,
    security: securityFromDescription(description, currency),
  };
}

/**
 * A cash-ledger row. An unrecognized code still reaches the ledger — it just
 * carries no typing signal and falls through to the narrative detector,
 * instead of being dropped as "unmapped".
 */
function cashTxnFrom(ctx: RowContext, txnType: ReturnType<typeof wsPdfCashCodeToTxnType>): CashTxn {
  return {
    date: ctx.tradeDate,
    merchantRaw: ctx.description,
    merchantClean: normalizeMerchant(ctx.description),
    amount: ctx.amount,
    currency: ctx.currency,
    sourceReference: null,
    ...cashTyping(ctx.code, txnType),
  };
}

/**
 * Quantity is a position change only for trades. Equities quote "shares",
 * commodities quote "ounces/units", crypto uses "Purchase/Sale of N SYM".
 * Non-trade activity (dividend/interest/fee/etc.) keeps quantity null.
 */
const QTY_PATTERNS = [QTY_RE, QTY_UNIT_RE, QTY_CRYPTO_RE];

function tradeQuantity(ctx: RowContext): number | null {
  if (!buySell(ctx.code)) return null;
  for (const re of QTY_PATTERNS) {
    const m = re.exec(ctx.description);
    if (m) return Number(m[1]);
  }
  return null;
}

function activityFrom(ctx: RowContext, activityType: NonNullable<RowContext['activityType']>): Activity {
  return {
    activityType,
    tradeDate: ctx.tradeDate,
    settlementDate: null,
    description: ctx.description,
    security: ctx.security,
    quantity: tradeQuantity(ctx),
    price: null,
    amount: ctx.amount,
    fees: null,
    currency: ctx.currency,
    sourceReference: null,
  };
}

type CountBucket = 'skip' | 'unmapped';

/**
 * What to do with a finished activity row. Splitting the decision out of
 * `finalize` keeps the dispatch flat: the router owns the precedence, the
 * caller owns the three sinks.
 */
type Routing =
  | { kind: 'count'; bucket: CountBucket }
  | { kind: 'cash'; txnType: ReturnType<typeof wsPdfCashCodeToTxnType> }
  | { kind: 'activity'; activityType: NonNullable<RowContext['activityType']> };

function bump(counts: Record<string, number>, code: string): void {
  counts[code] = (counts[code] ?? 0) + 1;
}

/**
 * Zero-cash bookkeeping events (stock lending, mark-to-market, journals) carry
 * no ledger value on ANY account type. Checked before the deposit routing so
 * it cannot turn one into a $0.00 transaction. Every skip code is absent from
 * MAP, so the activityType guard preserves the original ordering exactly.
 */
function isZeroCashBookkeeping(ctx: RowContext): boolean {
  return ctx.activityType === null && WS_PDF_SKIP_CODES.has(ctx.code);
}

/**
 * Deposit accounts (WS Cash / Chequing / Save) share this parser and sniff with
 * brokerage accounts, but they are bank accounts: every row on one is a
 * cash-ledger event. This keys off the caller's account type rather than a code
 * list because WS renames the codes between statement cycles — the recurring
 * AMEX pre-authorized debit arrived as AFT_OUT in 2026-06 and WD in 2026-07,
 * and WD/DEP/WDQ/CONT sit in MAP, so they were intercepted as investment
 * activity and the July cash flow never reached the ledger.
 *
 * Security-bearing rows are the one exception: a deposit statement should never
 * carry one, but flattening it to a cash row would drop the security.
 */
function depositRouting(ctx: RowContext, isDepositAccount: boolean): Routing | null {
  if (!isDepositAccount) return null;
  if (ctx.security !== null) return null;
  return { kind: 'cash', txnType: wsPdfDepositCodeToTxnType(ctx.code) };
}

/**
 * Brokerage routing. Cash-account spend codes (SPEND / AFT_OUT / E_TRFIN / …)
 * are not in the InvestmentActivity taxonomy, so they become cash rows rather
 * than being warn-skipped as unmapped.
 */
function brokerageRouting(ctx: RowContext): Routing {
  if (ctx.activityType !== null) return { kind: 'activity', activityType: ctx.activityType };
  if (CASH_TXN_CODES.has(ctx.code)) {
    return { kind: 'cash', txnType: wsPdfCashCodeToTxnType(ctx.code) };
  }
  return { kind: 'count', bucket: 'unmapped' };
}

function routeRow(ctx: RowContext, isDepositAccount: boolean): Routing {
  if (isZeroCashBookkeeping(ctx)) return { kind: 'count', bucket: 'skip' };
  return depositRouting(ctx, isDepositAccount) ?? brokerageRouting(ctx);
}

/**
 * Parse the activity table(s). Single ("Activity - Current period") or split
 * ("CAD Activity"/"USD Activity") tables. Walks lines IN ORDER, starting a
 * pending row on each row line and accumulating every following non-row line
 * onto its description until the next row (or section/table boundary), so
 * date-prefixed wrap tails ("2025-05-01)") are captured rather than dropped.
 */
function parseActivities(
  lines: PdfLine[],
  accountCurrency: string,
  isDepositAccount: boolean,
): { activities: Activity[]; transactions: CashTxn[]; warnings: string[] } {
  const activities: Activity[] = [];
  const transactions: CashTxn[] = [];
  // Two tally buckets under one key so the dispatch below needs no branch to
  // pick between them.
  const counts: Record<CountBucket, Record<string, number>> = { skip: {}, unmapped: {} };

  let inSection = false;
  let currency = accountCurrency;
  let pending: PendingRow | null = null;

  const finalize = () => {
    if (!pending) return;
    const row = pending;
    pending = null;
    const ctx = rowContext(row, currency);
    const routed = routeRow(ctx, isDepositAccount);
    if (routed.kind === 'count') return bump(counts[routed.bucket], ctx.code);
    if (routed.kind === 'cash') return void transactions.push(cashTxnFrom(ctx, routed.txnType));
    activities.push(activityFrom(ctx, routed.activityType));
  };

  for (const l of lines) {
    const t = l.text.trim();

    // Currency-tagged table headers (margin accounts split into two tables).
    if (/CAD Activity/i.test(t)) {
      finalize();
      inSection = true;
      currency = 'CAD';
      continue;
    }
    if (/USD Activity/i.test(t)) {
      finalize();
      inSection = true;
      currency = 'USD';
      continue;
    }
    // Merged single table — denominated in the account currency.
    if (/Activity\s*-\s*Current period/i.test(t)) {
      finalize();
      inSection = true;
      currency = accountCurrency;
      continue;
    }
    if (!inSection) continue;
    if (ACTIVITY_STOP_RE.test(t)) {
      finalize();
      break;
    }
    // Column header line — not data.
    if (/^Date\s/i.test(t) && /Transaction/i.test(t) && /Description/i.test(t)) {
      continue;
    }

    const cols = tokenize(t);
    if (isActivityRow(cols)) {
      finalize();
      const last = cols.length - 1;
      pending = {
        date: cols[0],
        code: cols[1],
        debit: num(cols[last - 2]),
        credit: num(cols[last - 1]),
        descParts: cols.slice(2, last - 2),
      };
      continue;
    }
    // Continuation / wrap line — accumulate onto the pending row, but skip
    // per-page amended/page-number footer noise so it never clobbers the
    // description's symbol/qty wrap tail.
    if (pending && t && !ACTIVITY_NOISE_RE.test(t)) pending.descParts.push(t);
  }
  finalize();

  const warnings: string[] = [];
  const skipCounts = counts.skip;
  const unmappedCounts = counts.unmapped;
  const skipTotal = Object.values(skipCounts).reduce((a, b) => a + b, 0);
  const unmappedTotal = Object.values(unmappedCounts).reduce((a, b) => a + b, 0);
  if (skipTotal > 0 || unmappedTotal > 0) {
    const fmt = (m: Record<string, number>) =>
      Object.entries(m)
        .sort()
        .map(([c, n]) => `${c}×${n}`)
        .join(', ');
    const parts: string[] = [];
    if (skipTotal > 0) parts.push(`skipped ${skipTotal} zero-cash row(s) (${fmt(skipCounts)})`);
    if (unmappedTotal > 0) {
      parts.push(`skipped ${unmappedTotal} unmapped-code row(s) (${fmt(unmappedCounts)})`);
    }
    warnings.push(`WS brokerage activity: ${parts.join('; ')}`);
  }

  return { activities, transactions, warnings };
}

export const wealthsimpleBrokerageParser: PdfParser = {
  id: 'wealthsimple_brokerage',
  label: 'Wealthsimple Brokerage Statement',
  crossSourceDedup: 'fuzzy-window-5d',
  holdingFingerprint: 'ws_holding',
  sniff: (lines) => {
    // Require the Wealthsimple brand + order-execution markers. A genuine
    // Questrade statement lacks the "Wealthsimple" marker, so it is excluded
    // here; conversely a WS statement that merely *mentions* Questrade (e.g.
    // a transfer-in line) must still match — the questrade parser now requires
    // its own "Account #:" header anchor (which WS never has), so it no longer
    // mis-claims these.
    let orderExec = false;
    let ws = false;
    for (const l of lines) {
      if (/ORDER EXECUTION ONLY ACCOUNT/i.test(l.text)) orderExec = true;
      if (/Wealthsimple/i.test(l.text)) ws = true;
    }
    return orderExec && ws;
  },
  parse: (lines, ctx): PdfParseResult => {
    const header = parseWsBrokerageHeader(lines);
    const accountCurrency = header.currency ?? 'CAD';
    const holdings = parseHoldings(lines, header.periodEnd, accountCurrency);
    // WS Cash / Chequing / Save statements use this same layout. The caller
    // knows which account the upload targets; the statement body does not say
    // so reliably enough to key ledger routing off it.
    const isDepositAccount =
      ctx.accountType === 'checking' || ctx.accountType === 'savings';
    const { activities, transactions, warnings } = parseActivities(
      lines,
      accountCurrency,
      isDepositAccount,
    );
    return {
      transactions,
      investmentActivities: activities,
      holdings,
      header,
      warnings,
      parseErrors: [],
    };
  },
};
