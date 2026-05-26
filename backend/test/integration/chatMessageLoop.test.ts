/**
 * Integration tests for POST /api/chat/threads/:id/messages (PR2 Task 11).
 *
 * Drives the SSE message endpoint end-to-end via supertest and asserts on the
 * raw event stream that the HTTP layer produces. We stub the OpenAI streamer
 * at the module boundary using `__setStreamChatForTest` (from
 * backend/src/ai/chat/loop.ts) so the loop runs over scripted events without
 * hitting the network.
 *
 * Supertest collects the full response body as text; SSE blocks are parsed
 * locally (split on \n\n) since supertest doesn't expose a streaming API.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

import type { StreamEvent } from '../../src/ai/chat/openaiClient';

let app: import('express').Express;
let agent: ReturnType<typeof request.agent>;
let models: typeof import('../../src/models/index.js');
let setStreamChatForTest: typeof import('../../src/ai/chat/loop.js').__setStreamChatForTest;
let testDb: PgTestDb;

before(async () => {
  testDb = await setupPgTestDb('chat-message-loop');

  const appMod = await import('../../src/app.js');
  app = appMod.default;

  // First-registered user becomes superadmin; we don't use that agent.
  const bootstrap = request.agent(app);
  const register = await bootstrap.post('/api/auth/register').send({
    email: 'superadmin@example.com',
    displayName: 'Super Admin',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  models = await import('../../src/models');
  const { hashPassword, hashToken } = await import('../../src/auth/password.js');
  const loopMod = await import('../../src/ai/chat/loop.js');
  setStreamChatForTest = loopMod.__setStreamChatForTest;

  // Build a fully-wired User + Household + Session cookie agent.
  const pw = await hashPassword('password123');
  const user = await models.User.create({
    email: `chat-msg-${Date.now()}@example.com`,
    displayName: 'Chat Msg User',
    globalRole: 'user',
    passwordHash: pw.hash,
    passwordSalt: pw.salt,
    passwordParams: pw.params,
  });
  const household = await models.Household.create({ name: 'Chat Msg House' });
  await models.HouseholdMember.create({
    householdId: household.id,
    userId: user.id,
    role: 'owner',
  });
  // Also create an Account in the household so seeded transactions have a
  // place to land.
  await models.Account.create({
    name: 'Checking',
    owner: 'me',
    householdId: household.id,
  } as never);
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);
  await models.Session.create({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt,
  });
  agent = request.agent(app);
  agent.jar.setCookie(`cashflow_session=${token}; Path=/`);
});

after(async () => {
  delete process.env.CHAT_MAX_TOOL_CALLS_PER_TURN;
  setStreamChatForTest?.(null);
  await teardownPgTestDb(testDb);
});

beforeEach(async () => {
  delete process.env.CHAT_MAX_TOOL_CALLS_PER_TURN;
  setStreamChatForTest(null);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ParsedSseEvent {
  event: string;
  data: unknown;
}

/**
 * Parse the raw SSE body that supertest returns as `res.text`. The writer
 * (src/ai/chat/sse.ts) emits "event: <name>\n" then "data: <json>\n\n" per
 * event, so splitting on "\n\n" gives one block per event.
 */
function parseSseFromResponse(text: string): ParsedSseEvent[] {
  const out: ParsedSseEvent[] = [];
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue;
    let event = '';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!event) continue;
    out.push({ event, data: data ? JSON.parse(data) : null });
  }
  return out;
}

/**
 * Build a stub `streamChat` whose Nth invocation yields `scripts[N]` events.
 * Out-of-bounds invocations yield a single `done` event so the loop terminates
 * cleanly with no text and no tool calls.
 */
function stubStream(
  scripts: StreamEvent[][]
): typeof import('../../src/ai/chat/openaiClient.js').streamChat {
  let i = 0;
  return async function* () {
    const script = scripts[i++] ?? [
      { type: 'done' as const, finishReason: 'stop' },
    ];
    for (const ev of script) yield ev;
  };
}

async function newThread(): Promise<number> {
  const res = await agent.post('/api/chat/threads').send({});
  assert.equal(res.status, 201);
  return res.body.id as number;
}

async function seedTxnInHousehold(
  overrides: Record<string, unknown> = {}
): Promise<number> {
  // Find the (single) household + account in this DB.
  const household = await models.Household.findOne({
    where: { name: 'Chat Msg House' },
  });
  assert.ok(household, 'household must exist');
  const account = await models.Account.findOne({
    where: { householdId: household!.id },
  });
  assert.ok(account, 'account must exist');
  const row = await models.Transaction.create({
    accountId: account!.id,
    householdId: household!.id,
    visibility: 'shared',
    importBatch: 'seed',
    date: '2026-05-10',
    merchantRaw: 'COFFEE SHOP',
    merchantClean: 'COFFEE SHOP',
    amount: '5.00',
    currency: 'CAD',
    sourceRowFingerprint: `fp-${Math.random().toString(16).slice(2)}`,
    sourceIdentityFingerprint: `sid-${Math.random()}`,
    finalCategory: 'Dining',
    finalSplitType: 'me',
    finalBusiness: false,
    myShareAmount: '5.00',
    partnerShareAmount: '0',
    businessAmount: '0',
    reviewFlag: false,
    ...overrides,
  } as never);
  return row.id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('POST /threads/:id/messages: single-shot text reply streams tokens and persists user + assistant', async () => {
  const threadId = await newThread();
  setStreamChatForTest(
    stubStream([
      [
        { type: 'text_delta', text: 'Hi ' },
        { type: 'text_delta', text: 'there' },
        { type: 'usage', promptTokens: 12, completionTokens: 4 },
        { type: 'done', finishReason: 'stop' },
      ],
    ])
  );

  const res = await agent
    .post(`/api/chat/threads/${threadId}/messages`)
    .send({ message: 'hello' });
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'] ?? '', /text\/event-stream/);

  const events = parseSseFromResponse(res.text);
  const tokens = events.filter((e) => e.event === 'assistant_token');
  assert.deepEqual(
    tokens.map((e) => (e.data as { text: string }).text),
    ['Hi ', 'there']
  );
  const doneEv = events.find((e) => e.event === 'assistant_done');
  assert.ok(doneEv, 'assistant_done event present');
  assert.ok(
    typeof (doneEv!.data as { messageId: number }).messageId === 'number'
  );

  // Subsequent GET surfaces the persisted user + assistant messages.
  const after = await agent.get(`/api/chat/threads/${threadId}`);
  assert.equal(after.status, 200);
  const msgs = after.body.messages as Array<{
    role: string;
    contentText: string | null;
  }>;
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[0].contentText, 'hello');
  assert.equal(msgs[1].role, 'assistant');
  assert.equal(msgs[1].contentText, 'Hi there');
});

test('POST /threads/:id/messages: propose_bulk_patch tool call yields proposal event + persists ChatProposal', async () => {
  const threadId = await newThread();
  // Seed a row the bulk_patch filter will match (no createdByUserId set means
  // the shared-only branch of visibilityOr() picks it up).
  await seedTxnInHousehold({
    merchantClean: 'GROCER MART',
    visibility: 'shared',
  });

  setStreamChatForTest(
    stubStream([
      // Round 0: model asks for propose_bulk_patch.
      [
        {
          type: 'tool_call_delta',
          index: 0,
          id: 'call_p1',
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
      // Round 1: model summarizes.
      [
        { type: 'text_delta', text: 'Drafted a proposal.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ])
  );

  const res = await agent
    .post(`/api/chat/threads/${threadId}/messages`)
    .send({ message: 'tag grocer as Groceries' });
  assert.equal(res.status, 200);

  const events = parseSseFromResponse(res.text);
  const types = events.map((e) => e.event);
  assert.ok(types.includes('tool_call_start'), 'tool_call_start present');
  assert.ok(types.includes('tool_call_result'), 'tool_call_result present');
  const startEv = events.find((e) => e.event === 'tool_call_start');
  assert.equal(
    (startEv!.data as { toolName: string }).toolName,
    'propose_bulk_patch'
  );
  const resultEv = events.find((e) => e.event === 'tool_call_result');
  assert.equal((resultEv!.data as { ok: boolean }).ok, true);

  const propEv = events.find((e) => e.event === 'proposal');
  assert.ok(propEv, 'proposal event yielded');
  const prop = propEv!.data as {
    proposalId: number;
    kind: string;
    preview: { matched_count?: number };
  };
  assert.equal(prop.kind, 'bulk_patch');
  assert.ok(typeof prop.proposalId === 'number');
  assert.equal(prop.preview.matched_count, 1);

  // assistant_done arrived at the end (no error).
  assert.ok(
    events.find((e) => e.event === 'assistant_done'),
    'assistant_done present'
  );
  assert.equal(
    events.filter((e) => e.event === 'error').length,
    0,
    'no error events'
  );

  // ChatProposal row was persisted for this thread.
  const proposals = await models.ChatProposal.findAll({
    where: { threadId },
  });
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].kind, 'bulk_patch');
  assert.equal(proposals[0].status, 'pending');
});

test('POST /threads/:id/messages: CHAT_MAX_TOOL_CALLS_PER_TURN=1 caps the loop and emits assistant_done', async () => {
  process.env.CHAT_MAX_TOOL_CALLS_PER_TURN = '1';
  const threadId = await newThread();
  // Need a row so the (cap-bounded) round 0 dispatch can synthesize a real
  // proposal_id from propose_bulk_patch.
  await seedTxnInHousehold({
    merchantClean: 'COSTCO',
    visibility: 'shared',
  });

  // Stub always returns a tool_call. With max=1, round 0 dispatches; round 1
  // is the forced summarize-only call (loop passes tools: undefined so the
  // round 1 tool_call_delta from the stub is parsed but never dispatched —
  // see chatLoop.test.ts "forced-summarize round does not dispatch tools"
  // for the unit-level coverage of this guard).
  setStreamChatForTest(
    stubStream([
      [
        {
          type: 'tool_call_delta',
          index: 0,
          id: 'cap_c1',
          name: 'propose_bulk_patch',
        },
        {
          type: 'tool_call_delta',
          index: 0,
          argumentsDelta: JSON.stringify({
            filter: {},
            patch: { split_override: 'shared' },
          }),
        },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        {
          type: 'tool_call_delta',
          index: 0,
          id: 'cap_c2',
          name: 'propose_bulk_patch',
        },
        {
          type: 'tool_call_delta',
          index: 0,
          argumentsDelta: JSON.stringify({
            filter: {},
            patch: { split_override: 'me' },
          }),
        },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      // Defensive: out-of-bounds rounds return done so even an over-run
      // wouldn't hang.
    ])
  );

  const res = await agent
    .post(`/api/chat/threads/${threadId}/messages`)
    .send({ message: 'go' });
  assert.equal(res.status, 200);

  const events = parseSseFromResponse(res.text);
  const dones = events.filter((e) => e.event === 'assistant_done');
  assert.equal(dones.length, 1, 'assistant_done emitted exactly once');
  assert.equal(
    events.filter((e) => e.event === 'error').length,
    0,
    'no error events'
  );

  // Cap means only one tool_call_result (round 0); round 1's "model returned
  // a tool call despite tools: undefined" is ignored by the loop guard.
  assert.equal(
    events.filter((e) => e.event === 'tool_call_result').length,
    1,
    'only the pre-cap round dispatched a tool'
  );

  // Only one proposal persisted (round 1 ignored).
  const proposals = await models.ChatProposal.findAll({
    where: { threadId },
  });
  assert.equal(proposals.length, 1);
});

test('POST /threads/:id/messages: invalid body (missing message) returns 400', async () => {
  const threadId = await newThread();
  const res = await agent
    .post(`/api/chat/threads/${threadId}/messages`)
    .send({});
  assert.equal(res.status, 400);
});
