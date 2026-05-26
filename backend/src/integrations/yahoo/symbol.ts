/**
 * Map a stored security symbol + currency to a Yahoo Finance ticker.
 *
 * Yahoo uses suffixes for non-US exchanges (.TO for TSX, .V for TSXV,
 * .CN for CSE, etc.). The portfolio importer stores the bare local
 * symbol (e.g. "XEQT") and the listing currency. CAD-quoted equities
 * are TSX-listed in virtually every retail case, so we map CAD → .TO
 * and accept that fringe CSE/NEO listings need their suffix written
 * into the stored symbol directly (e.g. "FOO.NE").
 *
 * Symbols already carrying an exchange suffix or a dash (crypto pairs
 * like BTC-USD) are passed through untouched.
 */
export function toYahooSymbol(symbol: string, currency: string): string {
  const trimmed = symbol.trim();
  if (trimmed === '') return trimmed;
  if (trimmed.includes('.') || trimmed.includes('-')) return trimmed;
  if (currency.trim().toUpperCase() === 'CAD') return `${trimmed}.TO`;
  return trimmed;
}
