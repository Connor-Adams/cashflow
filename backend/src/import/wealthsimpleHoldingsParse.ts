import { parseCsvRecords } from './csvParse';

/**
 * Parsed shape of a Wealthsimple holdings/positions report CSV.
 *
 * Header layout (21 columns):
 *   Account Name, Account Type, Account Classification, Account Number,
 *   Symbol, Exchange, MIC, Name, Security Type, Quantity, Position Direction,
 *   Market Price, Market Price Currency, Book Value (CAD),
 *   Book Value Currency (CAD), Book Value (Market),
 *   Book Value Currency (Market), Market Value, Market Value Currency,
 *   Market Unrealized Returns, Market Unrealized Returns Currency
 *
 * Gotcha: the statement date is in a TRAILING single-column row at the very
 * end of the file:  "As of 2026-05-23 10:14 GMT-04:00".  We strip it out
 * before letting csv-parse run over the rest, and surface only the
 * YYYY-MM-DD portion as `statementDate`.  Empty Exchange/MIC are normal for
 * crypto + precious-metal rows.
 */
export type ParsedWsHoldingRow = {
  accountShortCode: string;
  symbol: string;
  name: string;
  assetType: string;
  currency: string;
  quantity: number;
  price: number | null;
  marketValue: number | null;
  costBasis: number | null;
  unrealizedGainLoss: number | null;
};

export type ParsedWsHoldings = {
  statementDate: string; // YYYY-MM-DD
  rows: ParsedWsHoldingRow[];
  warnings: string[];
};

const AS_OF_RE = /^["']?\s*As of\s+(\d{4}-\d{2}-\d{2})\b/i;

/** Strip a quoted CSV cell to its inner value. */
function unquote(s: string): string {
  const t = (s ?? '').trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/""/g, '"');
  }
  return t;
}

function parseNumeric(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === '' || s === '-') return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Split raw text into (data CSV text, "As of …" trailer line).
 *
 * Walks lines from the bottom skipping blanks; the first non-blank line that
 * matches the As-of regex is consumed and removed.  Everything else stays in
 * the CSV body for csv-parse to chew on.  If no trailer is found we return
 * `asOf=null` and let the caller decide whether to error or warn — we don't
 * want to silently invent a statement date.
 */
function splitAsOfTrailer(text: string): { body: string; asOf: string | null } {
  // Drop BOM up front so the As-of regex doesn't trip over it on tiny inputs.
  const cleaned = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = cleaned.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i] ?? '';
    if (raw.trim() === '') continue;
    const m = unquote(raw).match(AS_OF_RE);
    if (m) {
      // Remove this line and any trailing blanks after it.
      const body = lines.slice(0, i).join('\n');
      return { body, asOf: m[1] };
    }
    // First non-blank line from bottom is NOT an As-of trailer — stop scanning.
    break;
  }
  return { body: cleaned, asOf: null };
}

/**
 * Parse a Wealthsimple holdings/positions CSV.
 *
 * Returns `{error}` on:
 *   - CSV parse failure (malformed quoting, etc.)
 *   - Missing required header columns
 *   - Missing trailing "As of …" line
 *
 * Returns `{statementDate, rows, warnings}` on success.  Rows with empty
 * Symbol or empty Account Number are silently skipped with a warning rather
 * than aborting the whole import.
 */
export function parseWsHoldingsCsv(
  text: string,
): ParsedWsHoldings | { error: string } {
  const { body, asOf } = splitAsOfTrailer(text);
  if (!asOf) {
    return {
      error:
        'Could not find trailing "As of YYYY-MM-DD …" line — is this a Wealthsimple holdings report?',
    };
  }

  const parsed = parseCsvRecords(body);
  if (!parsed.ok) {
    return { error: parsed.error };
  }
  const { records, headers } = parsed;

  const REQUIRED = [
    'Account Number',
    'Symbol',
    'Name',
    'Security Type',
    'Quantity',
    'Market Value Currency',
  ];
  const missing = REQUIRED.filter((c) => !headers.includes(c));
  if (missing.length > 0) {
    return {
      error: `Missing required column(s): ${missing.join(', ')}`,
    };
  }

  const warnings: string[] = [];
  const rows: ParsedWsHoldingRow[] = [];

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const accountShortCode = (r['Account Number'] ?? '').trim();
    const symbol = (r['Symbol'] ?? '').trim().toUpperCase();
    if (!accountShortCode || !symbol) {
      warnings.push(
        `Skipped row ${i + 2}: missing ${!symbol ? 'Symbol' : 'Account Number'}`,
      );
      continue;
    }

    const name = (r['Name'] ?? '').trim();
    const assetType = (r['Security Type'] ?? '').trim().toLowerCase();
    const currency =
      ((r['Market Value Currency'] ?? '').trim() || 'CAD').toUpperCase().slice(0, 3);

    const quantity = parseNumeric(r['Quantity']);
    if (quantity == null) {
      warnings.push(
        `Skipped row ${i + 2}: invalid Quantity "${r['Quantity'] ?? ''}"`,
      );
      continue;
    }

    rows.push({
      accountShortCode,
      symbol,
      name,
      assetType,
      currency,
      quantity,
      price: parseNumeric(r['Market Price']),
      marketValue: parseNumeric(r['Market Value']),
      // Cost basis must be in the row's (market) currency — 'Book Value (CAD)'
      // is pre-converted to CAD and would be FX-converted a second time by
      // portfolio consumers (costBasisCad = costBasis * fxRate).
      costBasis: parseNumeric(r['Book Value (Market)'] ?? r['Book Value (CAD)']),
      unrealizedGainLoss: parseNumeric(r['Market Unrealized Returns']),
    });
  }

  return {
    statementDate: asOf,
    rows,
    warnings,
  };
}
