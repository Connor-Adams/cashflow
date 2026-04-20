/** Optional OpenAI integration — no key means AI routes return 503. */

export function getOpenAiConfig(): { apiKey: string; model: string } | null {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;
  const model = process.env.OPENAI_MODEL?.trim() || 'gpt-4o-mini';
  return { apiKey, model };
}

export function getVisionModel(): string {
  return process.env.OPENAI_VISION_MODEL?.trim() || 'gpt-4o-mini';
}
