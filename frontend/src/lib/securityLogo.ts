import { getAppConfig } from './appConfig'

/**
 * Builds the logo.dev image URL for a given ticker, or returns null
 * when no token is configured. Symbol normalization strips the
 * exchange suffix (`XEQT.TO` → `XEQT`) — logo.dev keys off the base
 * ticker.
 */
export function securityLogoUrl(symbol: string): string | null {
  const token = getAppConfig()?.logoDevToken
  if (!token) return null
  const base = symbol.split('.')[0].toUpperCase()
  if (!base) return null
  return `https://img.logo.dev/ticker/${encodeURIComponent(base)}?token=${encodeURIComponent(token)}`
}
