import { getOpenAiConfig } from '../../config/openai';

export interface ChatToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

export interface ChatMessageForApi {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | {
      type: 'tool_call_delta';
      index: number;
      id?: string;
      name?: string;
      argumentsDelta?: string;
    }
  | {
      type: 'usage';
      promptTokens: number;
      completionTokens: number;
    }
  | { type: 'done'; finishReason: string | null }
  | { type: 'error'; message: string; status?: number };

export interface StreamChatArgs {
  model: string;
  messages: ChatMessageForApi[];
  tools?: ChatToolDefinition[];
  signal?: AbortSignal;
  /** Test seam: swap fetch for a stub. */
  fetchImpl?: typeof fetch;
}

/** Streams events from OpenAI Chat Completions. Caller iterates with `for await`. */
export async function* streamChat(args: StreamChatArgs): AsyncGenerator<StreamEvent> {
  const cfg = getOpenAiConfig();
  if (!cfg) {
    yield {
      type: 'error',
      message: 'OpenAI is not configured (set OPENAI_API_KEY)',
      status: 503,
    };
    return;
  }
  const fetchFn = args.fetchImpl ?? fetch;
  const res = await fetchFn('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    signal: args.signal,
    body: JSON.stringify({
      model: args.model,
      messages: args.messages,
      tools: args.tools,
      tool_choice: args.tools && args.tools.length > 0 ? 'auto' : undefined,
      stream: true,
      stream_options: { include_usage: true },
    }),
  });

  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => '');
    yield {
      type: 'error',
      message: `OpenAI error ${res.status}: ${errText.slice(0, 500)}`,
      status: res.status,
    };
    return;
  }

  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let buf = '';

  try {
    // Loop: pull chunks, split on \n\n, parse each SSE event.
    // OpenAI's SSE events look like:  data: {...}\n\n   or   data: [DONE]\n\n
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 2);
        if (!raw.startsWith('data:')) continue;
        const payload = raw.slice(5).trim();
        if (payload === '[DONE]') {
          yield { type: 'done', finishReason: null };
          return;
        }
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(payload) as Record<string, unknown>;
        } catch {
          continue; // skip malformed chunk
        }
        yield* extractEvents(parsed);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function* extractEvents(chunk: Record<string, unknown>): Generator<StreamEvent> {
  const usage = chunk.usage as
    | { prompt_tokens?: number; completion_tokens?: number }
    | undefined;
  if (usage && (usage.prompt_tokens != null || usage.completion_tokens != null)) {
    yield {
      type: 'usage',
      promptTokens: usage.prompt_tokens ?? 0,
      completionTokens: usage.completion_tokens ?? 0,
    };
  }
  const choices = chunk.choices as
    | Array<{
        delta?: {
          content?: string | null;
          tool_calls?: Array<{
            index: number;
            id?: string;
            type?: 'function';
            function?: { name?: string; arguments?: string };
          }>;
        };
        finish_reason?: string | null;
      }>
    | undefined;
  if (!choices || choices.length === 0) return;
  const choice = choices[0];
  const delta = choice.delta ?? {};
  if (typeof delta.content === 'string' && delta.content.length > 0) {
    yield { type: 'text_delta', text: delta.content };
  }
  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      yield {
        type: 'tool_call_delta',
        index: tc.index,
        id: tc.id,
        name: tc.function?.name,
        argumentsDelta: tc.function?.arguments,
      };
    }
  }
  if (choice.finish_reason) {
    yield { type: 'done', finishReason: choice.finish_reason };
  }
}
