import { getOpenAiConfig } from '../config/openai';

type ChatMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | {
      role: 'user';
      content: Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
      >;
    };

export async function openaiJson(
  messages: ChatMessage[],
): Promise<Record<string, unknown>> {
  return (await openaiJsonWithMeta(messages)).json;
}

export type OpenAiJsonResult = {
  json: Record<string, unknown>;
  model: string;
  temperature: number;
  latencyMs: number;
  providerRequestId: string | null;
  rawTextPreview: string;
};

export async function openaiJsonWithMeta(
  messages: ChatMessage[],
  options: { temperature?: number; maxTokens?: number; model?: string } = {},
): Promise<OpenAiJsonResult> {
  const cfg = getOpenAiConfig();
  if (!cfg) {
    const err = new Error('OpenAI is not configured (set OPENAI_API_KEY)') as Error & {
      status?: number;
    };
    err.status = 503;
    throw err;
  }

  const started = Date.now();
  const temperature = options.temperature ?? 0.2;
  const model = options.model ?? cfg.model;
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      response_format: { type: 'json_object' },
      temperature,
      ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
    }),
  });
  const latencyMs = Date.now() - started;

  if (!res.ok) {
    const t = await res.text();
    const err = new Error(
      `OpenAI error ${res.status}: ${t.slice(0, 500)}`,
    ) as Error & { status?: number };
    err.status = res.status === 429 ? 429 : 502;
    throw err;
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = data.choices?.[0]?.message?.content;
  if (!text || typeof text !== 'string') {
    throw new Error('OpenAI returned no message content');
  }
  try {
    return {
      json: JSON.parse(text) as Record<string, unknown>,
      model,
      temperature,
      latencyMs,
      providerRequestId: res.headers.get('x-request-id'),
      rawTextPreview: text.slice(0, 500),
    };
  } catch {
    throw new Error('OpenAI returned invalid JSON');
  }
}
