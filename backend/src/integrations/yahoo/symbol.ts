/**
 * Map a stored security symbol to one or more candidate Yahoo Finance
 * tickers.
 *
 * Yahoo uses different conventions per market:
 *   - Crypto pairs: `BTC-USD`, `BTC-CAD`
 *   - Canadian Depositary Receipts (CDRs): `NVDA.NE` (NEO/Cboe Canada)
 *   - TSX-listed: `XEQT.TO`
 *   - TSXV-listed small caps: `PLUR.V`
 *   - US-listed: bare symbol
 *
 * The importer stores the bare local symbol plus a `currency`, `assetType`,
 * and `name`. We use those three to enumerate the most-likely candidate
 * Yahoo tickers in order. The backfill layer tries each in turn and stops
 * on the first non-null result. Symbols already carrying an explicit
 * exchange suffix or a dash (crypto pairs) are passed through untouched.
 *
 * Cash placeholders cannot resolve on Yahoo. They produce an empty candidate
 * list so callers can short-circuit instead of burning round trips against a
 * symbol that will never resolve. A symbol is treated as a cash placeholder
 * when it equals its own currency code (e.g. symbol "USD", currency "USD")
 * or matches a well-known cash sentinel (CASH, $$, $$$).
 */

export interface SymbolContext {
  currency: string;
  assetType: string | null;
  name: string | null;
}

const CDR_NAME_RE = /\bCDR\b/i;
const CASH_SENTINELS = new Set(['CASH', '$$', '$$$']);

/**
 * Bullion / commodity holdings (e.g. Wealthsimple's "Physically backed gold",
 * asset_type `precious_metal`) have no clean Yahoo ticker. Their bare symbol
 * collides with unrelated equities — "GOLD" maps to GoldMining Inc. (GOLD.TO),
 * a penny stock — so resolving them produces wildly wrong prices. We return no
 * candidate; the quote picker then skips them and the portfolio route falls
 * back to the broker-imported market value, which is correct for bullion.
 */
const NON_RESOLVABLE_ASSET_TYPES = new Set(['precious_metal', 'commodity']);

export function isCashPlaceholder(symbol: string, currency: string): boolean {
  const upperSymbol = symbol.trim().toUpperCase();
  if (upperSymbol === '') return false;
  if (CASH_SENTINELS.has(upperSymbol)) return true;
  return upperSymbol === currency.trim().toUpperCase();
}

export function enumerateYahooSymbols(
  symbol: string,
  ctx: SymbolContext,
): string[] {
  const trimmed = symbol.trim();
  if (trimmed === '') return [];
  if (isCashPlaceholder(trimmed, ctx.currency)) return [];

  const assetType = ctx.assetType?.toLowerCase() ?? null;
  if (assetType != null && NON_RESOLVABLE_ASSET_TYPES.has(assetType)) return [];

  if (trimmed.includes('.') || trimmed.includes('-')) return [trimmed];

  const currency = ctx.currency.trim().toUpperCase();
  const isCrypto = assetType === 'cryptocurrency';
  const isCdr = ctx.name != null && CDR_NAME_RE.test(ctx.name);

  if (isCrypto) {
    // Yahoo uses `<COIN>-<QUOTE>`; CAD pairs exist for the majors, USD pairs
    // exist for everything. Try the listing currency first, fall back to USD.
    if (currency === 'USD') return [`${trimmed}-USD`];
    return [`${trimmed}-${currency}`, `${trimmed}-USD`];
  }

  if (isCdr) {
    // CDRs trade on NEO/Cboe Canada (`.NE`). A handful also trade on TSX,
    // so list `.NE` first and fall back to `.TO`.
    return [`${trimmed}.NE`, `${trimmed}.TO`];
  }

  if (currency === 'CAD') {
    // TSX primary, TSXV/CSE as fallbacks for small caps.
    return [`${trimmed}.TO`, `${trimmed}.V`, `${trimmed}.CN`];
  }

  return [trimmed];
}

/**
 * Convenience wrapper returning only the primary candidate, or '' when no
 * Yahoo lookup should be attempted (empty / cash placeholder). Retained for
 * call sites that don't yet thread `assetType` / `name` through.
 */
export function toYahooSymbol(
  symbol: string,
  currency: string,
  ctx: Partial<Omit<SymbolContext, 'currency'>> = {},
): string {
  const candidates = enumerateYahooSymbols(symbol, {
    currency,
    assetType: ctx.assetType ?? null,
    name: ctx.name ?? null,
  });
  return candidates[0] ?? '';
}
