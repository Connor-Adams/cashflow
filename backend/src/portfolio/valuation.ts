/**
 * Holding valuation with a quote-vs-broker sanity guard.
 *
 * Background (issue #549): a HoldingSnapshot carries a broker-imported market
 * value (and often a per-unit price) straight from the statement. Separately we
 * fetch live quotes from Yahoo keyed by the bare symbol. When a bare symbol is
 * ambiguous, Yahoo can resolve it to a *different* security — e.g. "GOLD"
 * (Wealthsimple "Physically backed gold", priced per troy ounce) resolves to
 * `GOLD.TO` (GoldMining Inc, a ~$1.56 penny stock). Substituting that quote
 * collapsed the holding from its true ~$3,150 to $0.79 (-99.98%).
 *
 * The mapper now refuses to resolve precious-metal/commodity symbols, but that
 * is symbol-specific. This guard is the general backstop: if a live quote's
 * per-unit price diverges from the broker-imported per-unit price by more than
 * an order of magnitude, distrust the quote and keep the broker value.
 *
 * Why per-unit (not total market value): comparing total MV would false-positive
 * whenever the quantity legitimately changed since the broker snapshot. Per-unit
 * isolates the price collision. Why a wide ratio band (not a tight ±50%): a
 * broker snapshot can be months/years stale, so a single security can legitimately
 * move several-fold; only an order-of-magnitude gap reliably signals a collision.
 */

/** A quote is distrusted when its per-unit price is < broker/RATIO or > broker*RATIO. */
export const QUOTE_DIVERGENCE_RATIO = 4;

export interface HoldingValuationInput {
  /** Position size. */
  quantity: number;
  /** Broker-imported total market value, if present. */
  importedValue: number | null;
  /** Broker-imported per-unit price, if present. */
  importedPrice: number | null;
  /** Latest live quote per-unit price, if available. */
  quotePrice: number | null;
}

export interface HoldingValuation {
  marketValue: number;
  /** True when the live quote was used; false when the broker value was kept. */
  usedQuote: boolean;
}

/**
 * Resolve the per-unit broker reference price: prefer the imported per-unit
 * price, else derive it from importedValue / quantity. Returns null when no
 * positive reference can be established (so the guard cannot fire).
 */
function brokerPerUnit(input: HoldingValuationInput): number | null {
  if (input.importedPrice != null && input.importedPrice > 0) {
    return input.importedPrice;
  }
  if (
    input.importedValue != null &&
    input.importedValue > 0 &&
    input.quantity !== 0
  ) {
    const derived = input.importedValue / input.quantity;
    return derived > 0 ? derived : null;
  }
  return null;
}

/**
 * Decide a holding's current market value, preferring the live quote but
 * falling back to the broker-imported value when the quote is missing OR
 * diverges implausibly from the broker-imported per-unit price.
 */
export function resolveHoldingMarketValue(
  input: HoldingValuationInput
): HoldingValuation {
  const { quantity, importedValue, quotePrice } = input;

  if (quotePrice == null) {
    return { marketValue: importedValue ?? 0, usedQuote: false };
  }

  const reference = brokerPerUnit(input);
  if (reference != null && quotePrice > 0) {
    const low = reference / QUOTE_DIVERGENCE_RATIO;
    const high = reference * QUOTE_DIVERGENCE_RATIO;
    if (quotePrice < low || quotePrice > high) {
      // Implausible divergence — treat as a symbol→quote collision and keep
      // the broker-imported value (falling back to the quote only if there is
      // no usable broker value, which shouldn't happen since reference exists).
      return { marketValue: importedValue ?? quantity * quotePrice, usedQuote: false };
    }
  }

  return { marketValue: quantity * quotePrice, usedQuote: true };
}
