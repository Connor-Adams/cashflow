import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { streamChat, type StreamEvent } from './openaiClient';

beforeEach(() => {
  process.env.OPENAI_API_KEY = 'test-key';
});

/** Helper: assemble an SSE-style response body from JSON chunks. */
function sseBody(chunks: Array<Record<string, unknown> | string>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const text = chunks
    .map((c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`)
    .join('');
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(text));
      controller.close();
    },
  });
}

function stubFetch(body: ReadableStream<Uint8Array>, status = 200): typeof fetch {
  return async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      body,
      text: async () => '',
    }) as unknown as Response;
}

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

test('streamChat yields text_delta events for content chunks', async () => {
  const body = sseBody([
    { choices: [{ delta: { content: 'Hello' } }] },
    { choices: [{ delta: { content: ' world' } }] },
    '[DONE]',
  ]);
  const events = await collect(
    streamChat({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: stubFetch(body),
    })
  );
  const texts = events.filter((e) => e.type === 'text_delta').map((e: any) => e.text);
  assert.deepEqual(texts, ['Hello', ' world']);
});

test('streamChat yields tool_call_delta events with accumulating arguments', async () => {
  const body = sseBody([
    {
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: 'call_1', function: { name: 'query_transactions' } },
            ],
          },
        },
      ],
    },
    {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '{"limit":' } }],
          },
        },
      ],
    },
    {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '5}' } }],
          },
        },
      ],
    },
    '[DONE]',
  ]);
  const events = await collect(
    streamChat({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          type: 'function',
          function: { name: 'query_transactions', description: '', parameters: {} },
        },
      ],
      fetchImpl: stubFetch(body),
    })
  );
  const deltas = events.filter((e) => e.type === 'tool_call_delta');
  assert.equal(deltas.length, 3);
  assert.equal((deltas[0] as any).id, 'call_1');
  assert.equal((deltas[0] as any).name, 'query_transactions');
  assert.equal((deltas[1] as any).argumentsDelta, '{"limit":');
  assert.equal((deltas[2] as any).argumentsDelta, '5}');
});

test('streamChat yields usage event when present', async () => {
  const body = sseBody([
    { choices: [{ delta: { content: 'ok' } }] },
    { choices: [], usage: { prompt_tokens: 42, completion_tokens: 7 } },
    '[DONE]',
  ]);
  const events = await collect(
    streamChat({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: stubFetch(body),
    })
  );
  const usage = events.find((e) => e.type === 'usage') as any;
  assert.ok(usage);
  assert.equal(usage.promptTokens, 42);
  assert.equal(usage.completionTokens, 7);
});

test('streamChat yields error event on non-2xx HTTP status', async () => {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(''));
      c.close();
    },
  });
  const events = await collect(
    streamChat({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: stubFetch(body, 429),
    })
  );
  const err = events.find((e) => e.type === 'error') as any;
  assert.ok(err);
  assert.equal(err.status, 429);
});

test('streamChat yields error when OpenAI not configured', async () => {
  delete process.env.OPENAI_API_KEY;
  const events = await collect(
    streamChat({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: stubFetch(sseBody(['[DONE]'])),
    })
  );
  const err = events.find((e) => e.type === 'error') as any;
  assert.ok(err);
  assert.equal(err.status, 503);
});

test('streamChat handles chunks split across read() boundaries', async () => {
  // Simulate a chunk arriving as two halves of a single SSE event.
  const enc = new TextEncoder();
  const part1 = enc.encode('data: {"choices":[{"delta":{"content":"hel');
  const part2 = enc.encode('lo"}}]}\n\ndata: [DONE]\n\n');
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(part1);
      c.enqueue(part2);
      c.close();
    },
  });
  const events = await collect(
    streamChat({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: stubFetch(body),
    })
  );
  const texts = events.filter((e) => e.type === 'text_delta').map((e: any) => e.text);
  assert.deepEqual(texts, ['hello']);
});

test('streamChat skips malformed JSON chunks silently', async () => {
  const enc = new TextEncoder();
  // Mix of a malformed chunk and a valid one — parser must skip the bad one.
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode('data: not-json\n\n'));
      c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  });
  const events = await collect(
    streamChat({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: stubFetch(body),
    })
  );
  const texts = events.filter((e) => e.type === 'text_delta').map((e: any) => e.text);
  assert.deepEqual(texts, ['ok']);
  const errors = events.filter((e) => e.type === 'error');
  assert.equal(errors.length, 0);
});

test('streamChat deduplicates done events (finish_reason chunk + [DONE])', async () => {
  const body = sseBody([
    { choices: [{ delta: { content: 'hi' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    '[DONE]',
  ]);
  const events = await collect(
    streamChat({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: stubFetch(body),
    })
  );
  const dones = events.filter((e) => e.type === 'done');
  assert.equal(dones.length, 1);
  assert.equal((dones[0] as any).finishReason, 'stop');
});

test('streamChat yields error event when underlying stream errors mid-read', async () => {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
      c.error(new Error('upstream connection terminated'));
    },
  });
  const events = await collect(
    streamChat({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: stubFetch(body),
    })
  );
  const errors = events.filter((e) => e.type === 'error') as any[];
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /terminated|connection/i);
});
