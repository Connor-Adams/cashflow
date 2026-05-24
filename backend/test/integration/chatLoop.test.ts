/**
 * Integration tests for the tool-calling chat loop (PR2 Task 10).
 *
 * Each test stubs `streamChat` via `runChatTurn`'s `streamChatImpl` arg so we
 * can replay scripted OpenAI stream events without hitting the network. The
 * loop exercises real Sequelize models (ChatThread/ChatMessage/ChatProposal),
 * so this lives under test/integration with the in-memory SQLite setup.
 *
 * Tests cover:
 *   1. single-shot text reply persists user + assistant messages
 *   2. single tool call dispatches, persists a role=tool row, then a final
 *      assistant message with the summary text
 *   3. propose_* tool call yields a `proposal` LoopEvent with proposalId
 *   4. tool-call cap (CHAT_MAX_TOOL_CALLS_PER_TURN) — final call has
 *      tools: undefined and the loop terminates with assistant_done
 *   5. stream error on the very first call yields an `error` LoopEvent and
 *      does not persist an extra assistant message
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  setupChatTestDb,
  teardownChatTestDb,
  wipeChatTestTables,
  seedHousehold,
  seedUser,
  seedTxn,
} from './chat/_helpers';

import type { StreamEvent } from '../../src/ai/chat/openaiClient';
import type { LoopEvent } from '../../src/ai/chat/loop';

let models: Awaited<ReturnType<typeof setupChatTestDb>>['models'];
let dbPath: string;
let runChatTurn: typeof import('../../src/ai/chat/loop.js').runChatTurn;
let setStreamChatForTest: typeof import('../../src/ai/chat/loop.js').__setStreamChatForTest;

before(async () => {
  const setup = await setupChatTestDb('test-integration-chat-loop.sqlite');
  models = setup.models;
  dbPath = setup.dbPath;
  const loopMod = await import('../../src/ai/chat/loop.js');
  runChatTurn = loopMod.runChatTurn;
  setStreamChatForTest = loopMod.__setStreamChatForTest;
});

after(async () => {
  delete process.env.CHAT_MAX_TOOL_CALLS_PER_TURN;
  setStreamChatForTest(null);
  await teardownChatTestDb(models, dbPath);
});

beforeEach(async () => {
  delete process.env.CHAT_MAX_TOOL_CALLS_PER_TURN;
  setStreamChatForTest(null);
  await wipeChatTestTables(models);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SeedCtx {
  userId: number;
  householdId: number;
  accountId: number;
  threadId: number;
  thread: InstanceType<typeof models.ChatThread>;
}

async function seedThread(label: string): Promise<SeedCtx> {
  const { householdId, accountId } = await seedHousehold(models);
  const userId = await seedUser(models, label);
  const thread = await models.ChatThread.create({
    userId,
    title: 'Loop test thread',
    archivedAt: null,
    lastMessageAt: null,
  } as never);
  return { userId, householdId, accountId, threadId: thread.id, thread };
}

/**
 * Build a stub `streamChat` whose Nth call emits `scripts[N]` events. Out of
 * bounds → emits only a `done` event so the loop terminates with no tool
 * calls and no text content.
 */
function makeStubStream(
  scripts: StreamEvent[][]
): typeof import('../../src/ai/chat/openaiClient.js').streamChat {
  let i = 0;
  return async function* (
    _args
  ): AsyncGenerator<StreamEvent> {
    const script = scripts[i++] ?? [{ type: 'done', finishReason: 'stop' }];
    for (const ev of script) yield ev;
  };
}

/** Tracker for the stub that records each call's args + returns scripted events. */
interface StubCall {
  toolsPresent: boolean;
  messageCount: number;
}
function makeRecordingStubStream(
  scripts: StreamEvent[][],
  calls: StubCall[]
): typeof import('../../src/ai/chat/openaiClient.js').streamChat {
  let i = 0;
  return async function* (args): AsyncGenerator<StreamEvent> {
    calls.push({
      toolsPresent: Array.isArray(args.tools) && args.tools.length > 0,
      messageCount: args.messages.length,
    });
    const script = scripts[i++] ?? [{ type: 'done', finishReason: 'stop' }];
    for (const ev of script) yield ev;
  };
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('runChatTurn: single-shot text reply persists user + assistant messages', async () => {
  const ctx = await seedThread('single');
  const events = await collect(
    runChatTurn({
      thread: ctx.thread,
      userMessage: 'hello',
      userId: ctx.userId,
      householdId: ctx.householdId,
      promptContext: {
        todayIso: '2026-05-24',
        defaultCurrency: 'CAD',
        contacts: [],
      },
      streamChatImpl: makeStubStream([
        [
          { type: 'text_delta', text: 'Hi ' },
          { type: 'text_delta', text: 'there' },
          {
            type: 'usage',
            promptTokens: 10,
            completionTokens: 3,
          },
          { type: 'done', finishReason: 'stop' },
        ],
      ]),
    })
  );

  // Token events streamed in order, then assistant_done with messageId.
  const tokens = events.filter((e) => e.type === 'assistant_token');
  assert.deepEqual(
    tokens.map((e) => (e as { text: string }).text),
    ['Hi ', 'there']
  );
  const doneEv = events.find((e) => e.type === 'assistant_done') as
    | { type: 'assistant_done'; messageId: number }
    | undefined;
  assert.ok(doneEv, 'assistant_done event yielded');
  assert.ok(events.every((e) => e.type !== 'error'), 'no error events');

  // Persistence.
  const rows = await models.ChatMessage.findAll({
    where: { threadId: ctx.threadId },
    order: [['id', 'ASC']],
  });
  assert.equal(rows.length, 2, 'user + assistant rows persisted');
  assert.equal(rows[0].role, 'user');
  assert.equal(rows[0].contentText, 'hello');
  assert.equal(rows[1].role, 'assistant');
  assert.equal(rows[1].contentText, 'Hi there');
  assert.equal(rows[1].promptTokens, 10);
  assert.equal(rows[1].completionTokens, 3);
  assert.equal(rows[1].toolCalls, null);
  assert.equal(rows[1].id, doneEv!.messageId);

  // Thread lastMessageAt bumped.
  const reloaded = await models.ChatThread.findByPk(ctx.threadId);
  assert.ok(reloaded?.lastMessageAt);
});

test('runChatTurn: single tool call dispatches query_transactions, persists role=tool row, then final assistant message', async () => {
  const ctx = await seedThread('single-tool');
  // Seed two txns the tool will find.
  await seedTxn(models, ctx.accountId, ctx.householdId, {
    createdByUserId: ctx.userId,
    visibility: 'shared',
    merchantClean: 'COFFEE A',
    sourceRowFingerprint: 'loop-tc-1',
  });
  await seedTxn(models, ctx.accountId, ctx.householdId, {
    createdByUserId: ctx.userId,
    visibility: 'shared',
    merchantClean: 'COFFEE B',
    sourceRowFingerprint: 'loop-tc-2',
  });

  const events = await collect(
    runChatTurn({
      thread: ctx.thread,
      userMessage: 'find my coffee transactions',
      userId: ctx.userId,
      householdId: ctx.householdId,
      promptContext: {
        todayIso: '2026-05-24',
        defaultCurrency: 'CAD',
        contacts: [],
      },
      streamChatImpl: makeStubStream([
        // Round 1: model asks for query_transactions.
        [
          {
            type: 'tool_call_delta',
            index: 0,
            id: 'call_q1',
            name: 'query_transactions',
          },
          {
            type: 'tool_call_delta',
            index: 0,
            argumentsDelta: '{"merchant_pattern":"coffee"}',
          },
          { type: 'done', finishReason: 'tool_calls' },
        ],
        // Round 2: model summarizes for the user.
        [
          { type: 'text_delta', text: 'Found ' },
          { type: 'text_delta', text: '2 results.' },
          { type: 'done', finishReason: 'stop' },
        ],
      ]),
    })
  );

  const types = events.map((e) => e.type);
  assert.ok(types.includes('tool_call_start'), 'tool_call_start yielded');
  assert.ok(types.includes('tool_call_result'), 'tool_call_result yielded');
  const startEv = events.find((e) => e.type === 'tool_call_start') as
    | { type: 'tool_call_start'; toolName: string; argsPreview: string }
    | undefined;
  assert.equal(startEv?.toolName, 'query_transactions');
  const resultEv = events.find((e) => e.type === 'tool_call_result') as
    | {
        type: 'tool_call_result';
        toolName: string;
        ok: boolean;
        preview: unknown;
      }
    | undefined;
  assert.equal(resultEv?.toolName, 'query_transactions');
  assert.equal(resultEv?.ok, true);

  const doneEvs = events.filter((e) => e.type === 'assistant_done');
  assert.equal(doneEvs.length, 1, 'exactly one assistant_done yielded');

  // Persistence: user, assistant (tool-call), tool, assistant (summary).
  const rows = await models.ChatMessage.findAll({
    where: { threadId: ctx.threadId },
    order: [['id', 'ASC']],
  });
  assert.equal(rows.length, 4, 'four messages persisted');
  assert.equal(rows[0].role, 'user');
  assert.equal(rows[1].role, 'assistant');
  assert.ok(rows[1].toolCalls);
  assert.equal((rows[1].toolCalls as Array<{ id: string }>)[0].id, 'call_q1');
  assert.equal(rows[2].role, 'tool');
  assert.equal(rows[2].toolCallId, 'call_q1');
  assert.equal(rows[2].toolName, 'query_transactions');
  assert.ok(rows[2].contentText?.includes('matched_count'));
  assert.equal(rows[3].role, 'assistant');
  assert.equal(rows[3].contentText, 'Found 2 results.');
});

test('runChatTurn: propose_* tool call yields proposal event with proposalId + preview', async () => {
  const ctx = await seedThread('proposal');
  // Seed a row the bulk_patch filter will match.
  await seedTxn(models, ctx.accountId, ctx.householdId, {
    createdByUserId: ctx.userId,
    visibility: 'shared',
    merchantClean: 'GROCER ONE',
    categoryOverride: null,
    sourceRowFingerprint: 'loop-prop-1',
  });

  const events = await collect(
    runChatTurn({
      thread: ctx.thread,
      userMessage: 'tag grocer as Groceries',
      userId: ctx.userId,
      householdId: ctx.householdId,
      promptContext: {
        todayIso: '2026-05-24',
        defaultCurrency: 'CAD',
        contacts: [],
      },
      streamChatImpl: makeStubStream([
        // Round 1: propose_bulk_patch tool call.
        [
          {
            type: 'tool_call_delta',
            index: 0,
            id: 'call_prop',
            name: 'propose_bulk_patch',
          },
          {
            type: 'tool_call_delta',
            index: 0,
            argumentsDelta: JSON.stringify({
              filter: { merchant_pattern: 'grocer' },
              patch: { category_override: 'Groceries' },
            }),
          },
          { type: 'done', finishReason: 'tool_calls' },
        ],
        // Round 2: model confirms.
        [
          { type: 'text_delta', text: 'Drafted a proposal.' },
          { type: 'done', finishReason: 'stop' },
        ],
      ]),
    })
  );

  const propEv = events.find((e) => e.type === 'proposal') as
    | {
        type: 'proposal';
        proposalId: number;
        kind: string;
        preview: unknown;
      }
    | undefined;
  assert.ok(propEv, 'proposal event yielded');
  assert.equal(propEv!.kind, 'bulk_patch');
  assert.ok(typeof propEv!.proposalId === 'number');
  const preview = propEv!.preview as { matched_count?: number };
  assert.equal(preview.matched_count, 1);

  // Proposal row was persisted by the proposal builder.
  const proposal = await models.ChatProposal.findByPk(propEv!.proposalId);
  assert.ok(proposal);
  assert.equal(proposal!.kind, 'bulk_patch');
  assert.equal(proposal!.status, 'pending');
  assert.equal(proposal!.threadId, ctx.threadId);
});

test('runChatTurn: tool-call cap (CHAT_MAX_TOOL_CALLS_PER_TURN=2) — final call uses tools: undefined and emits assistant_done', async () => {
  process.env.CHAT_MAX_TOOL_CALLS_PER_TURN = '2';
  const ctx = await seedThread('cap');
  await seedTxn(models, ctx.accountId, ctx.householdId, {
    createdByUserId: ctx.userId,
    visibility: 'shared',
    sourceRowFingerprint: 'loop-cap-1',
  });

  // Stub always returns a tool call when given tools. When called without
  // tools (the forced summarize call), it returns a `done` so the loop exits.
  const calls: StubCall[] = [];
  const scripts: StreamEvent[][] = [
    // Round 0
    [
      {
        type: 'tool_call_delta',
        index: 0,
        id: 'c1',
        name: 'query_transactions',
      },
      {
        type: 'tool_call_delta',
        index: 0,
        argumentsDelta: '{}',
      },
      { type: 'done', finishReason: 'tool_calls' },
    ],
    // Round 1
    [
      {
        type: 'tool_call_delta',
        index: 0,
        id: 'c2',
        name: 'query_transactions',
      },
      {
        type: 'tool_call_delta',
        index: 0,
        argumentsDelta: '{}',
      },
      { type: 'done', finishReason: 'tool_calls' },
    ],
    // Round 2: forced summarize-only. Even if the model "wanted" tools,
    // we passed tools: undefined, so the round just returns text.
    [
      { type: 'text_delta', text: 'Summarized.' },
      { type: 'done', finishReason: 'stop' },
    ],
  ];

  const events = await collect(
    runChatTurn({
      thread: ctx.thread,
      userMessage: 'go',
      userId: ctx.userId,
      householdId: ctx.householdId,
      promptContext: {
        todayIso: '2026-05-24',
        defaultCurrency: 'CAD',
        contacts: [],
      },
      streamChatImpl: makeRecordingStubStream(scripts, calls),
    })
  );

  // Three stream calls: two with tools, one without.
  assert.equal(calls.length, 3, 'exactly 3 stream invocations');
  assert.equal(calls[0].toolsPresent, true);
  assert.equal(calls[1].toolsPresent, true);
  assert.equal(calls[2].toolsPresent, false, 'final call has no tools');

  // assistant_done emitted exactly once at the very end.
  const doneEvs = events.filter((e) => e.type === 'assistant_done');
  assert.equal(doneEvs.length, 1);
  assert.ok(events.every((e) => e.type !== 'error'));
});

test('runChatTurn: stream error on first call yields error LoopEvent and does not persist a second assistant message', async () => {
  const ctx = await seedThread('error');

  const events = await collect(
    runChatTurn({
      thread: ctx.thread,
      userMessage: 'will fail',
      userId: ctx.userId,
      householdId: ctx.householdId,
      promptContext: {
        todayIso: '2026-05-24',
        defaultCurrency: 'CAD',
        contacts: [],
      },
      streamChatImpl: makeStubStream([
        [
          {
            type: 'error',
            message: 'OpenAI error 503: service unavailable',
            status: 503,
          },
        ],
      ]),
    })
  );

  const errEv = events.find((e) => e.type === 'error') as
    | { type: 'error'; message: string; code?: string }
    | undefined;
  assert.ok(errEv, 'error event yielded');
  assert.match(errEv!.message, /service unavailable/);
  assert.equal(errEv!.code, '503');

  // No assistant_done.
  assert.equal(events.filter((e) => e.type === 'assistant_done').length, 0);

  // Persistence: only the user message — no assistant row was committed
  // because we returned before reaching ChatMessage.create for the assistant.
  const rows = await models.ChatMessage.findAll({
    where: { threadId: ctx.threadId },
    order: [['id', 'ASC']],
  });
  assert.equal(rows.length, 1, 'only the user message persisted');
  assert.equal(rows[0].role, 'user');
  assert.equal(rows[0].contentText, 'will fail');
});

test('runChatTurn: forced-summarize round does not dispatch tools even if model returns tool_calls', async () => {
  // Set max=1 so round 0 uses tools and round 1 is the forced summarize round.
  // The stub returns a propose_bulk_patch on BOTH rounds; round 1's tool call
  // must NOT be dispatched (no second proposal row, no second proposal event).
  process.env.CHAT_MAX_TOOL_CALLS_PER_TURN = '1';
  const ctx = await seedThread('forced-summarize-no-dispatch');
  // Seed one row the bulk_patch filter (empty {}) will match so the first
  // round's dispatch can actually create a proposal.
  await seedTxn(models, ctx.accountId, ctx.householdId, {
    createdByUserId: ctx.userId,
    visibility: 'shared',
    sourceRowFingerprint: 'loop-forced-1',
  });

  const scripts: StreamEvent[][] = [
    // Round 0: model asks for propose_bulk_patch (this one DOES dispatch).
    [
      {
        type: 'tool_call_delta',
        index: 0,
        id: 'call_1',
        name: 'propose_bulk_patch',
      },
      {
        type: 'tool_call_delta',
        index: 0,
        argumentsDelta:
          '{"filter":{},"patch":{"split_override":"shared"}}',
      },
      { type: 'done', finishReason: 'tool_calls' },
    ],
    // Round 1 (forced summarize): model misbehaves and returns ANOTHER tool
    // call despite tools: undefined. The loop MUST ignore it.
    [
      {
        type: 'tool_call_delta',
        index: 0,
        id: 'call_2',
        name: 'propose_bulk_patch',
      },
      {
        type: 'tool_call_delta',
        index: 0,
        argumentsDelta: '{"filter":{},"patch":{"split_override":"me"}}',
      },
      { type: 'done', finishReason: 'tool_calls' },
    ],
  ];

  const events: LoopEvent[] = [];
  for await (const ev of runChatTurn({
    thread: ctx.thread,
    userMessage: 'hi',
    userId: ctx.userId,
    householdId: ctx.householdId,
    promptContext: {
      todayIso: '2026-05-24',
      defaultCurrency: 'CAD',
      contacts: [],
    },
    streamChatImpl: makeStubStream(scripts),
  })) {
    events.push(ev);
  }

  // Exactly one proposal event from round 0's dispatch; round 1's tool call
  // is ignored.
  const proposals = events.filter((e) => e.type === 'proposal');
  assert.equal(
    proposals.length,
    1,
    'only round 0 propose should dispatch (round 1 tool call ignored)'
  );

  // Only one ChatProposal row created (not two).
  const proposalRows = await models.ChatProposal.findAll({
    where: { threadId: ctx.threadId },
  });
  assert.equal(
    proposalRows.length,
    1,
    'forced-summarize round must not create a second proposal'
  );

  // Only one tool_call_start / tool_call_result pair (from round 0).
  assert.equal(
    events.filter((e) => e.type === 'tool_call_start').length,
    1,
    'no tool_call_start emitted for the forced-summarize round'
  );
  assert.equal(
    events.filter((e) => e.type === 'tool_call_result').length,
    1,
    'no tool_call_result emitted for the forced-summarize round'
  );

  // Loop terminates with assistant_done (not error).
  assert.equal(events.at(-1)?.type, 'assistant_done');
  assert.ok(events.every((e) => e.type !== 'error'), 'no error events');

  // The round-1 assistant message IS persisted (with its tool_calls for
  // audit), but no role=tool row follows it.
  const rows = await models.ChatMessage.findAll({
    where: { threadId: ctx.threadId },
    order: [['id', 'ASC']],
  });
  // user, assistant(tool_call call_1), tool(call_1), assistant(call_2 — not dispatched)
  assert.equal(rows.length, 4);
  assert.equal(rows[0].role, 'user');
  assert.equal(rows[1].role, 'assistant');
  assert.equal(
    (rows[1].toolCalls as Array<{ id: string }>)[0].id,
    'call_1'
  );
  assert.equal(rows[2].role, 'tool');
  assert.equal(rows[2].toolCallId, 'call_1');
  assert.equal(rows[3].role, 'assistant');
  assert.ok(rows[3].toolCalls, 'round 1 toolCalls persisted for audit');
  assert.equal(
    (rows[3].toolCalls as Array<{ id: string }>)[0].id,
    'call_2'
  );
});
