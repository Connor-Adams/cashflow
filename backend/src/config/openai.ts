/** Optional OpenAI integration — no key means AI routes return 503. */

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/**
 * Where chat-completion requests go. Defaults to OpenAI directly; set
 * OPENAI_BASE_URL to route through an OpenAI-compatible proxy (the LiteLLM
 * instance on the Dokploy host) for per-key budgets and spend tracking.
 *
 * Validated rather than interpolated: this value becomes the request URL, so
 * accepting anything string-shaped would turn a config typo — or an injected
 * env var — into a request-forgery primitive. Only absolute http(s) URLs pass,
 * and plain http is allowed because the proxy is reached over the LAN.
 */
function resolveBaseUrl(): string {
  const raw = process.env.OPENAI_BASE_URL?.trim();
  if (!raw) return DEFAULT_BASE_URL;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`OPENAI_BASE_URL is not a valid absolute URL: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`OPENAI_BASE_URL must use http or https, got: ${parsed.protocol}`);
  }
  return raw.replace(/\/+$/, '');
}

export function getOpenAiConfig(): { apiKey: string; model: string; baseUrl: string } | null {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;
  const model = process.env.OPENAI_MODEL?.trim() || 'gpt-4o-mini';
  return { apiKey, model, baseUrl: resolveBaseUrl() };
}

export function getVisionModel(): string {
  return process.env.OPENAI_VISION_MODEL?.trim() || 'gpt-4o-mini';
}
