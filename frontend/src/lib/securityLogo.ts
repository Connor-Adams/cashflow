import { getAppConfig } from './appConfig'

export type SecurityLogoOptions = {
  assetType?: string | null
  currency?: string | null
}

/**
 * Maps Canadian ETF ticker prefixes to issuer domains. logo.dev's
 * /ticker endpoint is US-centric and returns generic placeholders for
 * most TSX-listed funds, so we route ETFs to the issuer's brand logo
 * via /{domain} instead. Guarded by assetType==='etf' to avoid
 * misrouting tickers like V (Visa) or Z (Zillow).
 */
const ETF_ISSUER_DOMAIN: Array<readonly [RegExp, string]> = [
  [/^X[A-Z]/, 'ishares.com'],
  [/^V[A-Z]/, 'vanguard.com'],
  [/^Z[A-Z]/, 'bmo.com'],
  [/^H[A-Z]/, 'globalx.com'],
]

function etfIssuerDomain(upperSymbol: string): string | null {
  for (const [pattern, domain] of ETF_ISSUER_DOMAIN) {
    if (pattern.test(upperSymbol)) return domain
  }
  return null
}

/**
 * Builds the logo.dev image URL for a security, or returns null when
 * no token is configured.
 *
 * Routing:
 *   crypto                  → /crypto/{BASE}
 *   etf (matched issuer)    → /{issuer-domain}
 *   else                    → /ticker/{SYMBOL.EXCHANGE}
 *
 * Ticker symbols preserve their exchange suffix; for CAD-denominated
 * holdings with no suffix we infer `.TO` since logo.dev keys on the
 * fully-qualified ticker.
 */
export function securityLogoUrl(
  symbol: string,
  opts: SecurityLogoOptions = {},
): string | null {
  const token = getAppConfig()?.logoDevToken
  if (!token) return null
  if (!symbol) return null

  const upper = symbol.toUpperCase()
  const baseSymbol = upper.split('.')[0]
  if (!baseSymbol) return null
  const assetType = opts.assetType?.toLowerCase().trim() ?? ''
  const tokenParam = `?token=${encodeURIComponent(token)}`

  if (assetType === 'cryptocurrency' || assetType === 'crypto') {
    return `https://img.logo.dev/crypto/${encodeURIComponent(baseSymbol)}${tokenParam}`
  }

  if (assetType === 'etf') {
    const domain = etfIssuerDomain(upper)
    if (domain) {
      return `https://img.logo.dev/${encodeURIComponent(domain)}${tokenParam}`
    }
  }

  const hasSuffix = upper.includes('.')
  const tickerKey =
    hasSuffix
      ? upper
      : opts.currency?.toUpperCase() === 'CAD'
        ? `${upper}.TO`
        : upper
  return `https://img.logo.dev/ticker/${encodeURIComponent(tickerKey)}${tokenParam}`
}
