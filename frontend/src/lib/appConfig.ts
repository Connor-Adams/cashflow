import { getJson } from './api'
import type { AppConfig } from '../types/api'

declare global {
  interface Window {
    __APP_CONFIG__?: AppConfig;
  }
}

let cached: Promise<AppConfig> | null = null

export function loadAppConfig(): Promise<AppConfig> {
  if (cached) return cached
  cached = getJson<AppConfig>('/api/config')
    .then((cfg) => {
      window.__APP_CONFIG__ = cfg
      return cfg
    })
    .catch((err) => {
      // Fail open: degrade to nulls so the app still renders without /api/config.
      const fallback: AppConfig = {
        logoDevToken: null,
        quoteProviderConfigured: false,
        vapidPublicKey: null,
      }
      window.__APP_CONFIG__ = fallback
      console.warn('[appConfig] failed to load, degrading:', err)
      return fallback
    })
  return cached
}

export function getAppConfig(): AppConfig | null {
  return window.__APP_CONFIG__ ?? null
}

/** Reset cache + window state — test-only. */
export function _resetAppConfigForTest(): void {
  cached = null
  delete window.__APP_CONFIG__
}
