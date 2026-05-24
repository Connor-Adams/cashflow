/**
 * `runChatTurn` — server-side tool-calling loop for the chat backend (PR2 Task 10).
 *
 * Orchestrates one user turn end-to-end:
 *   1. Persist the incoming user message + bump the thread's lastMessageAt.
 *   2. Replay the last N messages as context for the model.
 *   3. Stream events from OpenAI (or the test stub), accumulating text +
 *      tool-call deltas; persist the resulting assistant message.
 *   4. If the assistant requested tool_calls, dispatch each one sequentially,
 *      persist a role=tool message, push the result into history, loop.
 *   5. Cap at `maxToolCallsPerTurn` iterations of tool-use; the final
 *      iteration is forced to `tools: undefined` so the model summarizes
 *      without requesting another tool, and we always exit via
 *      `assistant_done` (or `error`).
 *
 * Yields `LoopEvent` values the HTTP layer (Task 11) forwards as SSE.
 *
 * Test seams:
 * - `args.streamChatImpl` lets unit tests inject a scripted stream stub.
 * - `__setStreamChatForTest` is for Task 13 integration tests that need to
 *   stub the stream from the HTTP boundary (where they can't pass args in).
 */
import {
  ChatMessage,
  type ChatThread,
} from '../../models';
import type { StoredToolCall } from '../../models/ChatMessage';
import { getChatConfig } from '../../config/chat';
import { buildSystemPrompt, type SystemPromptContext } from './systemPrompt';
import {
  streamChat,
  type ChatMessageForApi,
} from './openaiClient';
import {
  getToolDefinitions,
  dispatchTool,
  type ToolContext,
} from './tools';

export interface RunChatTurnArgs {
  thread: ChatThread;
  userMessage: string;
  userId: number;
  /** Household scoping. Required — every tool needs a real household id. */
  householdId: number;
  promptContext: SystemPromptContext;
  signal?: AbortSignal;
  /** Test seam: replace the OpenAI streamer with a stub for this call. */
  streamChatImpl?: typeof streamChat;
}

export type LoopEvent =
  | { type: 'assistant_token'; text: string }
  | { type: 'tool_call_start'; toolName: string; argsPreview: string }
  | { type: 'tool_call_result'; toolName: string; ok: boolean; preview: unknown }
  | { type: 'proposal'; proposalId: number; kind: string; preview: unknown }
  | { type: 'assistant_done'; messageId: number }
  | { type: 'error'; message: string; code?: string };

// ---------------------------------------------------------------------------
// Test seam for integration tests (Task 13) that drive the loop through the
// HTTP route and can't pass `streamChatImpl` via args. Unit tests should
// prefer `args.streamChatImpl` over this global setter.
// ---------------------------------------------------------------------------
let streamChatOverride: typeof streamChat | null = null;
export function __setStreamChatForTest(
  impl: typeof streamChat | null
): void {
  streamChatOverride = impl;
}

export async function* runChatTurn(
  args: RunChatTurnArgs
): AsyncGenerator<LoopEvent> {
  const cfg = getChatConfig();
  const stream = streamChatOverride ?? args.streamChatImpl ?? streamChat;

  // 1. Persist the user message
  await ChatMessage.create({
    threadId: args.thread.id,
    role: 'user',
    contentText: args.userMessage,
    toolCalls: null,
    toolCallId: null,
    toolName: null,
    model: null,
    promptTokens: null,
    completionTokens: null,
    latencyMs: null,
    providerRequestId: null,
  });
  args.thread.set('lastMessageAt', new Date());
  await args.thread.save();

  // 2. Build conversation history (last N messages, oldest first).
  // `loadHistory` already includes the user message we just persisted.
  const history = await loadHistory(
    args.thread.id,
    cfg.historyWindowMessages
  );
  const apiMessages: ChatMessageForApi[] = [
    { role: 'system', content: buildSystemPrompt(args.promptContext) },
    ...history,
  ];

  // 3. Tool-calling loop. `step <= cfg.maxToolCallsPerTurn` so the final
  // iteration runs with `tools: undefined` to force a summarize-only call.
  for (let step = 0; step <= cfg.maxToolCallsPerTurn; step++) {
    const useTools = step < cfg.maxToolCallsPerTurn;
    const assistantText: string[] = [];
    const toolCallSlots = new Map<
      number,
      { id: string; name: string; argsBuf: string }
    >();
    let usagePrompt = 0;
    let usageCompletion = 0;

    const started = Date.now();

    for await (const ev of stream({
      model: cfg.model,
      messages: apiMessages,
      tools: useTools ? getToolDefinitions() : undefined,
      signal: args.signal,
    })) {
      if (ev.type === 'error') {
        yield {
          type: 'error',
          message: ev.message,
          code: ev.status != null ? String(ev.status) : undefined,
        };
        return;
      }
      if (ev.type === 'text_delta') {
        assistantText.push(ev.text);
        yield { type: 'assistant_token', text: ev.text };
      } else if (ev.type === 'tool_call_delta') {
        const slot =
          toolCallSlots.get(ev.index) ?? { id: '', name: '', argsBuf: '' };
        if (ev.id) slot.id = ev.id;
        if (ev.name) slot.name = ev.name;
        if (ev.argumentsDelta) slot.argsBuf += ev.argumentsDelta;
        toolCallSlots.set(ev.index, slot);
      } else if (ev.type === 'usage') {
        usagePrompt = ev.promptTokens;
        usageCompletion = ev.completionTokens;
      }
      // `done` events are recorded implicitly by the stream ending; nothing
      // additional to do here.
    }

    const assistantContent = assistantText.join('');
    const storedToolCalls: StoredToolCall[] | null =
      toolCallSlots.size > 0
        ? [...toolCallSlots.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, slot]) => ({
              id: slot.id,
              type: 'function' as const,
              function: { name: slot.name, arguments: slot.argsBuf },
            }))
        : null;

    const assistantMsg = await ChatMessage.create({
      threadId: args.thread.id,
      role: 'assistant',
      contentText: assistantContent.length > 0 ? assistantContent : null,
      toolCalls: storedToolCalls,
      toolCallId: null,
      toolName: null,
      model: cfg.model,
      promptTokens: usagePrompt > 0 ? usagePrompt : null,
      completionTokens: usageCompletion > 0 ? usageCompletion : null,
      latencyMs: Date.now() - started,
      providerRequestId: null,
    });

    // Push the assistant turn into the in-memory conversation so subsequent
    // stream calls see it.
    apiMessages.push({
      role: 'assistant',
      content: assistantContent.length > 0 ? assistantContent : null,
      tool_calls: storedToolCalls ?? undefined,
    });

    if (!storedToolCalls || storedToolCalls.length === 0) {
      yield { type: 'assistant_done', messageId: assistantMsg.id };
      return;
    }

    // Dispatch each tool sequentially, persist a role=tool message, push the
    // result into history so the next iteration's prompt includes it.
    for (const tc of storedToolCalls) {
      yield {
        type: 'tool_call_start',
        toolName: tc.function.name,
        argsPreview: tc.function.arguments.slice(0, 200),
      };
      const ctx: ToolContext = {
        userId: args.userId,
        householdId: args.householdId,
        threadId: args.thread.id,
        messageId: assistantMsg.id,
      };
      const result = await dispatchTool(
        tc.function.name,
        tc.function.arguments,
        ctx
      );
      yield {
        type: 'tool_call_result',
        toolName: tc.function.name,
        ok: result.ok,
        preview: result.ok ? result.data : result.error,
      };
      if (result.ok && tc.function.name.startsWith('propose_')) {
        const d = result.data as {
          proposal_id?: number;
          preview?: unknown;
        };
        if (typeof d.proposal_id === 'number') {
          yield {
            type: 'proposal',
            proposalId: d.proposal_id,
            kind: tc.function.name.replace(/^propose_/, ''),
            preview: d.preview,
          };
        }
      }
      const toolContent = JSON.stringify(
        result.ok ? result.data : { error: result.error }
      );
      await ChatMessage.create({
        threadId: args.thread.id,
        role: 'tool',
        contentText: toolContent,
        toolCalls: null,
        toolCallId: tc.id,
        toolName: tc.function.name,
        model: null,
        promptTokens: null,
        completionTokens: null,
        latencyMs: null,
        providerRequestId: null,
      });
      apiMessages.push({
        role: 'tool',
        content: toolContent,
        tool_call_id: tc.id,
      });
    }

    if (!useTools) {
      // We ran the forced summarize-only iteration but it still asked for
      // tools (which we ignored by not registering any). Stop now so we
      // don't loop forever — emit assistant_done with the most recent
      // assistant message we managed to persist.
      yield { type: 'assistant_done', messageId: assistantMsg.id };
      return;
    }
  }
  // Defensive: should never reach here — the `step <= max` loop always
  // executes the `!useTools` branch which returns. If we somehow do, treat
  // it as an error rather than silently dropping the turn.
  yield {
    type: 'error',
    message: 'tool-call loop exited without resolution',
  };
}

async function loadHistory(
  threadId: number,
  limit: number
): Promise<ChatMessageForApi[]> {
  const rows = await ChatMessage.findAll({
    where: { threadId },
    order: [['id', 'DESC']],
    limit,
  });
  rows.reverse();
  return rows.map((r) => {
    const j = r.toJSON();
    if (j.role === 'tool') {
      return {
        role: 'tool',
        content: j.contentText ?? '',
        tool_call_id: j.toolCallId ?? '',
      };
    }
    if (j.role === 'assistant') {
      return {
        role: 'assistant',
        content: j.contentText,
        tool_calls:
          (j.toolCalls as StoredToolCall[] | null) ?? undefined,
      };
    }
    return { role: 'user', content: j.contentText ?? '' };
  });
}
