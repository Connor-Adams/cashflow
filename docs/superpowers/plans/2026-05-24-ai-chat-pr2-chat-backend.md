# AI Chat — PR2: Chat Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the full chat backend — schema, routes, OpenAI tool-calling loop, proposal preview/apply lifecycle — behind a feature flag. After this PR, a CURL-equipped human can have a working AI chat over their transactions; the React UI ships in PR3. Spec: `docs/superpowers/specs/2026-05-24-ai-chat-transactions-design.md`. Builds on PR1 ([#88](https://github.com/Connor-Adams/cashflow/pull/88)) which added date-scoped rules.

**Architecture:** Three new tables (`chat_threads`, `chat_messages`, `chat_proposals`). Per-user threads. Each user turn dispatches a server-side tool-calling loop against OpenAI Chat Completions (streamed). 10 tools — 5 read, 5 propose-only-mutation. Mutation tools create `ChatProposal` rows (status `pending`); the UI applies them via a separate `POST /api/chat/proposals/:id/apply` endpoint (not a tool — the model has no path to apply). SSE transport from `POST /api/chat/threads/:id/messages` carries assistant tokens, tool-call events, and proposal cards. Conversation history replayed verbatim per turn (last 20 messages). Tool-call cap per turn = 8.

**Tech Stack:** Node 20+, TypeScript 5.9, Sequelize 6, Express 4, OpenAI Chat Completions API (streaming via fetch + SSE parsing), `node:test` via `tsx`.

**Feature flag:** `CHAT_ENABLED` env var. When unset/false, the chat router 404s for all `/api/chat/*` routes. PR3 ships with this flipped on.

**Out of scope (deferred to PR3):** the React `/chat` page, components, route, nav item. Frontend code untouched in this PR.

**Bundled PR1 follow-ups:** (1) tighten `DATE_ONLY_RE` in `backend/src/routes/rules.ts` to reject calendar-invalid dates, (2) add a PATCH cross-field violation integration test in `backend/test/integration/rulesEffectiveDates.test.ts`.

---

## File Structure

**New:**
- `backend/src/migrations/20260525120000-chat-tables.js` — three tables
- `backend/src/models/ChatThread.ts`
- `backend/src/models/ChatMessage.ts`
- `backend/src/models/ChatProposal.ts`
- `backend/src/config/chat.ts` — env-var reading: `CHAT_ENABLED`, `CHAT_MODEL`, `CHAT_DAILY_TOKEN_BUDGET`, `CHAT_MAX_TOOL_CALLS_PER_TURN`, `CHAT_PROPOSAL_DRIFT_PCT`
- `backend/src/routes/chat.ts` — thread CRUD + message POST (SSE) + proposal apply/reject
- `backend/src/routes/chatRateLimit.ts` — per-thread limiter
- `backend/src/ai/chat/openaiClient.ts` — `streamChat({ messages, tools, signal })`: AsyncIterable of stream events
- `backend/src/ai/chat/systemPrompt.ts` — `buildSystemPrompt(ctx)`: per-turn prompt
- `backend/src/ai/chat/tools.ts` — tool definitions (OpenAI schema) + dispatcher
- `backend/src/ai/chat/proposals.ts` — preview builders + `applyProposal()`
- `backend/src/ai/chat/loop.ts` — `runChatTurn({ thread, userMessage, signal })`: AsyncIterable of SSE events
- `backend/src/ai/chat/sse.ts` — SSE event helpers
- `backend/src/ai/chat/tokenBudget.ts` — per-day token budget check + record
- `backend/test/chat/*.test.ts` — unit tests per module
- `backend/test/integration/chatThreadsCrud.test.ts`
- `backend/test/integration/chatMessageLoop.test.ts` — stubbed OpenAI client
- `backend/test/integration/chatProposalsApplyReject.test.ts`

**Modified:**
- `backend/src/models/index.ts` — register 3 new models
- `backend/src/app.ts` — register `/api/chat` router (gated on `CHAT_ENABLED`)
- `backend/src/routes/ai.ts` — `/api/ai/status` returns `{ openai, chat }` instead of `{ openai }`
- `backend/src/routes/rules.ts` — tighten `DATE_ONLY_RE` (PR1 follow-up)
- `backend/test/integration/rulesEffectiveDates.test.ts` — add PATCH cross-field test (PR1 follow-up)
- `shared/api-types.ts` — chat types: `ChatThread`, `ChatMessage`, `ChatProposal`, `ChatStreamEvent`

**Untouched:** frontend (entire), other routes.

---

## Dependency DAG

```
Task 1 (PR1 follow-ups, independent of everything else) ─────────┐
                                                                  │
Task 2 (migration) ──> Task 3 (models) ──> Task 4 (config + flag)│
                                              │                    │
                                              ├─> Task 5 (router skeleton + thread CRUD)
                                              │
                                              └─> Task 6 (openaiClient — independent)
                                              └─> Task 7 (systemPrompt — independent)
                                              └─> Task 8 (tools.ts — read tools)
                                              └─> Task 9 (tools.ts — mutation tools + proposals.ts)
                                                          │
                                              ┌───────────┴────────┐
                                              ▼                    ▼
                                       Task 10 (loop.ts)    Task 12 (apply endpoint)
                                              │                    │
                                              └──────┬─────────────┘
                                                     ▼
                                       Task 11 (message POST + SSE)
                                                     │
                                       Task 13 (integration tests with stubbed client)
                                                     │
                                       Task 14 (rate limits + token budget)
                                                     │
                                       Task 15 (api/ai/status update)
                                                     │
                                       Task 16 (E2E smoke + CI + PR)
```

**Parallelism:** Tasks 6, 7, 8 are mutually independent after Task 4 lands. In a single-worktree subagent execution, bundle them into one implementer dispatch rather than dispatching in parallel.

---

### Task 1: PR1 follow-ups — tighten date regex + add PATCH cross-field test

**Files:**
- Modify: `backend/src/routes/rules.ts` (tighten validator)
- Modify: `backend/test/integration/rulesEffectiveDates.test.ts` (one new test)

The current `DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/` accepts lex-valid but calendar-invalid dates (`2026-13-01`, `2026-02-30`). SQLite stores TEXT, so the bogus value round-trips silently and would later poison `findBestRule`'s lexicographic compare. We fix by adding a round-trip `new Date(...)` check.

- [ ] **Step 1: Tighten `parseEffectiveDate`**

Edit `backend/src/routes/rules.ts`. Replace the body of `parseEffectiveDate`:

```ts
function parseEffectiveDate(
  raw: unknown
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw == null) return { ok: true, value: null };
  if (typeof raw !== 'string' || !DATE_ONLY_RE.test(raw)) {
    return { ok: false, error: 'must be YYYY-MM-DD or null' };
  }
  // Round-trip through Date to reject calendar-invalid values like
  // 2026-13-01 or 2026-02-30 — the regex alone allows these because
  // SQLite stores DATEONLY as TEXT and won't reject them at insert.
  const parsed = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
    return { ok: false, error: 'must be a valid calendar date (YYYY-MM-DD)' };
  }
  return { ok: true, value: raw };
}
```

- [ ] **Step 2: Add new integration tests for the calendar-validity behavior**

In `backend/test/integration/rulesEffectiveDates.test.ts`, add two tests (use the same helpers/setup that the existing tests in this file use — match the style verbatim):

```ts
test('POST /api/rules rejects calendar-invalid effectiveFrom (2026-13-01)', async () => {
  const res = await agent
    .post('/api/rules')
    .send({ merchantPattern: 'X', effectiveFrom: '2026-13-01' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /effectiveFrom/);
  assert.match(res.body.error, /valid calendar date/);
});

test('POST /api/rules rejects calendar-invalid effectiveTo (2026-02-30)', async () => {
  const res = await agent
    .post('/api/rules')
    .send({ merchantPattern: 'X', effectiveTo: '2026-02-30' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /effectiveTo/);
  assert.match(res.body.error, /valid calendar date/);
});
```

- [ ] **Step 3: Add the missing PATCH cross-field violation test**

In the same file, also add:

```ts
test('PATCH /api/rules/:id rejects effectiveTo that crosses existing effectiveFrom', async () => {
  const created = await agent.post('/api/rules').send({
    merchantPattern: 'GROCER',
    effectiveFrom: '2026-06-01',
  });
  assert.equal(created.status, 201);
  const id = created.body.id;

  const patched = await agent
    .patch(`/api/rules/${id}`)
    .send({ effectiveTo: '2026-05-01' });
  assert.equal(patched.status, 400);
  assert.match(patched.body.error, /effectiveFrom must be < effectiveTo/);
});
```

- [ ] **Step 4: Run typecheck + tests + integration tests**

```
yarn workspace cashflow-backend run typecheck
yarn workspace cashflow-backend run test
yarn workspace cashflow-backend run test:integration
```

All three must PASS. The integration suite should show 3 more passing tests than before.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/rules.ts backend/test/integration/rulesEffectiveDates.test.ts
git commit -m "fix(rules): reject calendar-invalid effective dates + add PATCH cross-field test"
```

---

### Task 2: Migration for chat tables

**Files:**
- Create: `backend/src/migrations/20260525120000-chat-tables.js`

Three new tables in one migration. All FKs cascade-delete to keep cleanup automatic.

- [ ] **Step 1: Create the migration file**

```js
'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('chat_threads', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      title: { type: Sequelize.STRING(256), allowNull: true },
      archived_at: { type: Sequelize.DATE, allowNull: true },
      last_message_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('chat_threads', ['user_id', 'last_message_at'], {
      name: 'chat_threads_user_last_message',
    });

    await queryInterface.createTable('chat_messages', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      thread_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'chat_threads', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      role: { type: Sequelize.STRING(16), allowNull: false },
      content_text: { type: Sequelize.TEXT, allowNull: true },
      tool_calls: { type: Sequelize.JSON, allowNull: true },
      tool_call_id: { type: Sequelize.STRING(128), allowNull: true },
      tool_name: { type: Sequelize.STRING(64), allowNull: true },
      model: { type: Sequelize.STRING(64), allowNull: true },
      prompt_tokens: { type: Sequelize.INTEGER, allowNull: true },
      completion_tokens: { type: Sequelize.INTEGER, allowNull: true },
      latency_ms: { type: Sequelize.INTEGER, allowNull: true },
      provider_request_id: { type: Sequelize.STRING(128), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('chat_messages', ['thread_id', 'id'], {
      name: 'chat_messages_thread_id_id',
    });

    await queryInterface.createTable('chat_proposals', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      thread_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'chat_threads', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      message_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'chat_messages', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      kind: { type: Sequelize.STRING(32), allowNull: false },
      payload: { type: Sequelize.JSON, allowNull: false },
      preview: { type: Sequelize.JSON, allowNull: false },
      status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'pending' },
      expires_at: { type: Sequelize.DATE, allowNull: false },
      applied_at: { type: Sequelize.DATE, allowNull: true },
      applied_result: { type: Sequelize.JSON, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('chat_proposals', ['thread_id', 'status'], {
      name: 'chat_proposals_thread_status',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('chat_proposals', 'chat_proposals_thread_status');
    await queryInterface.dropTable('chat_proposals');
    await queryInterface.removeIndex('chat_messages', 'chat_messages_thread_id_id');
    await queryInterface.dropTable('chat_messages');
    await queryInterface.removeIndex('chat_threads', 'chat_threads_user_last_message');
    await queryInterface.dropTable('chat_threads');
  },
};
```

- [ ] **Step 2: Migrate up + verify schema**

```
yarn workspace cashflow-backend run db:migrate
sqlite3 backend/data/cashflow.sqlite ".schema chat_threads"
sqlite3 backend/data/cashflow.sqlite ".schema chat_messages"
sqlite3 backend/data/cashflow.sqlite ".schema chat_proposals"
```

Expected: all three tables present with the columns above.

- [ ] **Step 3: Migrate down + verify**

```
yarn workspace cashflow-backend run db:migrate:undo
sqlite3 backend/data/cashflow.sqlite ".tables" | grep -c chat_
```

Expected: 0 (none of the chat_ tables exist).

- [ ] **Step 4: Re-apply for subsequent tasks**

```
yarn workspace cashflow-backend run db:migrate
```

- [ ] **Step 5: Commit**

```bash
git add backend/src/migrations/20260525120000-chat-tables.js
git commit -m "feat(chat): migration adds chat_threads, chat_messages, chat_proposals"
```

---

### Task 3: Sequelize models — ChatThread, ChatMessage, ChatProposal

**Files:**
- Create: `backend/src/models/ChatThread.ts`
- Create: `backend/src/models/ChatMessage.ts`
- Create: `backend/src/models/ChatProposal.ts`
- Modify: `backend/src/models/index.ts`

Use the existing model pattern (look at `backend/src/models/Rule.ts` and `backend/src/models/Transaction.ts` for reference).

- [ ] **Step 1: Create `backend/src/models/ChatThread.ts`**

```ts
import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export class ChatThread extends Model<
  InferAttributes<ChatThread>,
  InferCreationAttributes<ChatThread>
> {
  declare id: CreationOptional<number>;
  declare userId: number;
  declare title: string | null;
  declare archivedAt: Date | null;
  declare lastMessageAt: Date | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initChatThread(sequelize: Sequelize): typeof ChatThread {
  ChatThread.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      userId: {
        type: DataTypes.INTEGER,
        field: 'user_id',
        allowNull: false,
      },
      title: { type: DataTypes.STRING(256), allowNull: true },
      archivedAt: {
        type: DataTypes.DATE,
        field: 'archived_at',
        allowNull: true,
      },
      lastMessageAt: {
        type: DataTypes.DATE,
        field: 'last_message_at',
        allowNull: true,
      },
    } as ModelAttributes<ChatThread>,
    {
      sequelize,
      modelName: 'ChatThread',
      tableName: 'chat_threads',
      underscored: true,
      timestamps: true,
    }
  );
  return ChatThread;
}
```

- [ ] **Step 2: Create `backend/src/models/ChatMessage.ts`**

```ts
import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export type ChatMessageRole = 'user' | 'assistant' | 'tool';

/** Shape of an entry in `tool_calls` JSON column on assistant messages. */
export interface StoredToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export class ChatMessage extends Model<
  InferAttributes<ChatMessage>,
  InferCreationAttributes<ChatMessage>
> {
  declare id: CreationOptional<number>;
  declare threadId: number;
  declare role: ChatMessageRole;
  declare contentText: string | null;
  declare toolCalls: StoredToolCall[] | null;
  declare toolCallId: string | null;
  declare toolName: string | null;
  declare model: string | null;
  declare promptTokens: number | null;
  declare completionTokens: number | null;
  declare latencyMs: number | null;
  declare providerRequestId: string | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initChatMessage(sequelize: Sequelize): typeof ChatMessage {
  ChatMessage.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      threadId: {
        type: DataTypes.INTEGER,
        field: 'thread_id',
        allowNull: false,
      },
      role: { type: DataTypes.STRING(16), allowNull: false },
      contentText: {
        type: DataTypes.TEXT,
        field: 'content_text',
        allowNull: true,
      },
      toolCalls: {
        type: DataTypes.JSON,
        field: 'tool_calls',
        allowNull: true,
      },
      toolCallId: {
        type: DataTypes.STRING(128),
        field: 'tool_call_id',
        allowNull: true,
      },
      toolName: {
        type: DataTypes.STRING(64),
        field: 'tool_name',
        allowNull: true,
      },
      model: { type: DataTypes.STRING(64), allowNull: true },
      promptTokens: {
        type: DataTypes.INTEGER,
        field: 'prompt_tokens',
        allowNull: true,
      },
      completionTokens: {
        type: DataTypes.INTEGER,
        field: 'completion_tokens',
        allowNull: true,
      },
      latencyMs: {
        type: DataTypes.INTEGER,
        field: 'latency_ms',
        allowNull: true,
      },
      providerRequestId: {
        type: DataTypes.STRING(128),
        field: 'provider_request_id',
        allowNull: true,
      },
    } as ModelAttributes<ChatMessage>,
    {
      sequelize,
      modelName: 'ChatMessage',
      tableName: 'chat_messages',
      underscored: true,
      timestamps: true,
    }
  );
  return ChatMessage;
}
```

- [ ] **Step 3: Create `backend/src/models/ChatProposal.ts`**

```ts
import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export type ChatProposalKind =
  | 'transaction_edit'
  | 'bulk_patch'
  | 'rule_create'
  | 'rule_update'
  | 'rule_delete';

export type ChatProposalStatus = 'pending' | 'applied' | 'rejected' | 'expired';

export class ChatProposal extends Model<
  InferAttributes<ChatProposal>,
  InferCreationAttributes<ChatProposal>
> {
  declare id: CreationOptional<number>;
  declare threadId: number;
  declare messageId: number;
  declare kind: ChatProposalKind;
  declare payload: Record<string, unknown>;
  declare preview: Record<string, unknown>;
  declare status: CreationOptional<ChatProposalStatus>;
  declare expiresAt: Date;
  declare appliedAt: Date | null;
  declare appliedResult: Record<string, unknown> | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initChatProposal(sequelize: Sequelize): typeof ChatProposal {
  ChatProposal.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      threadId: {
        type: DataTypes.INTEGER,
        field: 'thread_id',
        allowNull: false,
      },
      messageId: {
        type: DataTypes.INTEGER,
        field: 'message_id',
        allowNull: false,
      },
      kind: { type: DataTypes.STRING(32), allowNull: false },
      payload: { type: DataTypes.JSON, allowNull: false },
      preview: { type: DataTypes.JSON, allowNull: false },
      status: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'pending',
      },
      expiresAt: {
        type: DataTypes.DATE,
        field: 'expires_at',
        allowNull: false,
      },
      appliedAt: {
        type: DataTypes.DATE,
        field: 'applied_at',
        allowNull: true,
      },
      appliedResult: {
        type: DataTypes.JSON,
        field: 'applied_result',
        allowNull: true,
      },
    } as ModelAttributes<ChatProposal>,
    {
      sequelize,
      modelName: 'ChatProposal',
      tableName: 'chat_proposals',
      underscored: true,
      timestamps: true,
    }
  );
  return ChatProposal;
}
```

- [ ] **Step 4: Register in `backend/src/models/index.ts`**

Open the file. Find the existing model registration pattern (other models call their `initXyz(sequelize)` in a single block). Add three lines for the new models, and add them to the export block / list at the bottom.

Specifically:
- Add imports at the top:
  ```ts
  import { initChatThread, ChatThread } from './ChatThread';
  import { initChatMessage, ChatMessage } from './ChatMessage';
  import { initChatProposal, ChatProposal } from './ChatProposal';
  ```
- Call `initChatThread(sequelize); initChatMessage(sequelize); initChatProposal(sequelize);` alongside the other init calls.
- Add `ChatThread`, `ChatMessage`, `ChatProposal` to the named exports.

If you encounter associations elsewhere in the file (e.g., `Transaction.belongsTo(Account)`), don't add chat associations now — keep models standalone for PR2. We can add them later if needed.

- [ ] **Step 5: Typecheck + sanity test**

```
yarn workspace cashflow-backend run typecheck
yarn workspace cashflow-backend run test
```

Both must PASS. No new tests yet; this is sanity that the existing suite still works.

- [ ] **Step 6: Commit**

```bash
git add backend/src/models/ChatThread.ts backend/src/models/ChatMessage.ts backend/src/models/ChatProposal.ts backend/src/models/index.ts
git commit -m "feat(chat): ChatThread, ChatMessage, ChatProposal models"
```

---

### Task 4: Chat config module + feature flag wiring

**Files:**
- Create: `backend/src/config/chat.ts`
- Modify: `backend/src/app.ts` — only the import + register block (router itself comes in Task 5)
- Modify: `backend/.env.example` — document new env vars (if file exists; otherwise skip)

- [ ] **Step 1: Create `backend/src/config/chat.ts`**

```ts
/**
 * Chat-feature config. Reads env vars on each call (rather than caching) so
 * tests can manipulate process.env freely.
 */
export interface ChatConfig {
  enabled: boolean;
  /** OpenAI model for chat turns. Falls back to OPENAI_MODEL, then gpt-4o-mini. */
  model: string;
  /** Per-user per-day token budget. Hard stop when exceeded. */
  dailyTokenBudget: number;
  /** Max tool calls per user turn before the loop summarizes and stops. */
  maxToolCallsPerTurn: number;
  /** Drift threshold for proposal apply (0..1). e.g. 0.2 = ±20%. */
  proposalDriftPct: number;
  /** Hours until a pending proposal auto-expires. */
  proposalExpiryHours: number;
  /** Per-thread message rate limit: max user messages per hour. */
  perThreadMessagesPerHour: number;
  /** Hard cap on conversation history replayed to the model each turn. */
  historyWindowMessages: number;
}

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function getChatConfig(): ChatConfig {
  return {
    enabled: process.env.CHAT_ENABLED === 'true',
    model:
      process.env.CHAT_MODEL?.trim() ||
      process.env.OPENAI_MODEL?.trim() ||
      'gpt-4o-mini',
    dailyTokenBudget: numEnv('CHAT_DAILY_TOKEN_BUDGET', 200_000),
    maxToolCallsPerTurn: numEnv('CHAT_MAX_TOOL_CALLS_PER_TURN', 8),
    proposalDriftPct: (() => {
      const raw = process.env.CHAT_PROPOSAL_DRIFT_PCT;
      if (!raw) return 0.2;
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.2;
    })(),
    proposalExpiryHours: numEnv('CHAT_PROPOSAL_EXPIRY_HOURS', 24),
    perThreadMessagesPerHour: numEnv('CHAT_PER_THREAD_MSGS_PER_HOUR', 30),
    historyWindowMessages: numEnv('CHAT_HISTORY_WINDOW_MESSAGES', 20),
  };
}
```

- [ ] **Step 2: Add tests**

Create `backend/test/chat/config.test.ts`:

```ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getChatConfig } from '../../src/config/chat';

beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('CHAT_')) delete process.env[k];
  }
});

test('getChatConfig disabled by default', () => {
  assert.equal(getChatConfig().enabled, false);
});

test('getChatConfig enables on CHAT_ENABLED=true (string match)', () => {
  process.env.CHAT_ENABLED = 'true';
  assert.equal(getChatConfig().enabled, true);
  process.env.CHAT_ENABLED = 'TRUE';
  assert.equal(getChatConfig().enabled, false); // strict 'true' only
});

test('getChatConfig model precedence: CHAT_MODEL > OPENAI_MODEL > default', () => {
  delete process.env.OPENAI_MODEL;
  assert.equal(getChatConfig().model, 'gpt-4o-mini');
  process.env.OPENAI_MODEL = 'gpt-4.1';
  assert.equal(getChatConfig().model, 'gpt-4.1');
  process.env.CHAT_MODEL = 'gpt-4o';
  assert.equal(getChatConfig().model, 'gpt-4o');
});

test('getChatConfig numeric env vars parse and have sensible defaults', () => {
  const d = getChatConfig();
  assert.equal(d.dailyTokenBudget, 200_000);
  assert.equal(d.maxToolCallsPerTurn, 8);
  assert.equal(d.proposalDriftPct, 0.2);
  assert.equal(d.proposalExpiryHours, 24);
  assert.equal(d.perThreadMessagesPerHour, 30);
  assert.equal(d.historyWindowMessages, 20);

  process.env.CHAT_DAILY_TOKEN_BUDGET = '50000';
  process.env.CHAT_MAX_TOOL_CALLS_PER_TURN = '4';
  process.env.CHAT_PROPOSAL_DRIFT_PCT = '0.5';
  const c = getChatConfig();
  assert.equal(c.dailyTokenBudget, 50_000);
  assert.equal(c.maxToolCallsPerTurn, 4);
  assert.equal(c.proposalDriftPct, 0.5);
});

test('getChatConfig rejects invalid numerics by falling back to defaults', () => {
  process.env.CHAT_DAILY_TOKEN_BUDGET = 'foo';
  process.env.CHAT_PROPOSAL_DRIFT_PCT = '5';
  const c = getChatConfig();
  assert.equal(c.dailyTokenBudget, 200_000);
  assert.equal(c.proposalDriftPct, 0.2);
});
```

- [ ] **Step 3: Run the new tests**

```
yarn workspace cashflow-backend exec -- tsx --test test/chat/config.test.ts
```

Expected: all 5 PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/src/config/chat.ts backend/test/chat/config.test.ts
git commit -m "feat(chat): config module reads CHAT_* env vars with sane defaults"
```

(`app.ts` integration happens in Task 5 alongside the router.)

---

### Task 5: Chat router skeleton + thread CRUD

**Files:**
- Create: `backend/src/routes/chat.ts`
- Modify: `backend/src/app.ts` — register the router behind `CHAT_ENABLED`
- Create: `backend/test/integration/chatThreadsCrud.test.ts`

The router exposes `/api/chat/threads` and `/api/chat/threads/:id`. Per-user scoping: every read/write filters on `userId = currentAuth(req).user.id`. No household scoping (threads are private per spec).

Skeleton includes a placeholder POST `/api/chat/threads/:id/messages` that returns 501 — to be replaced in Task 11.

- [ ] **Step 1: Create `backend/src/routes/chat.ts`**

```ts
import { Router } from 'express';
import { Op } from 'sequelize';
import { ChatThread, ChatMessage, ChatProposal } from '../models';
import { currentAuth } from '../auth/middleware';

const router = Router();

function parseId(s: string): number | null {
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// GET /api/chat/threads — list non-archived threads for current user
router.get('/threads', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const threads = await ChatThread.findAll({
      where: { userId: user.id, archivedAt: { [Op.is]: null } },
      order: [
        ['lastMessageAt', 'DESC'],
        ['id', 'DESC'],
      ],
      limit: 200,
    });
    res.json(threads.map((t) => t.toJSON()));
  } catch (e) {
    next(e);
  }
});

// POST /api/chat/threads — create a new thread (title optional)
router.post('/threads', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const b = (req.body || {}) as { title?: unknown };
    const title =
      typeof b.title === 'string' && b.title.trim().length > 0
        ? b.title.trim().slice(0, 256)
        : null;
    const row = await ChatThread.create({
      userId: user.id,
      title,
      archivedAt: null,
      lastMessageAt: null,
    });
    res.status(201).json(row.toJSON());
  } catch (e) {
    next(e);
  }
});

// GET /api/chat/threads/:id — one thread with its messages
router.get('/threads/:id', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const id = parseId(req.params.id);
    if (id == null) {
      res.status(400).json({ error: 'invalid id' });
      return;
    }
    const thread = await ChatThread.findOne({
      where: { id, userId: user.id },
    });
    if (!thread) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const messages = await ChatMessage.findAll({
      where: { threadId: id },
      order: [['id', 'ASC']],
    });
    const proposals = await ChatProposal.findAll({
      where: { threadId: id },
      order: [['id', 'ASC']],
    });
    res.json({
      thread: thread.toJSON(),
      messages: messages.map((m) => m.toJSON()),
      proposals: proposals.map((p) => p.toJSON()),
    });
  } catch (e) {
    next(e);
  }
});

// PATCH /api/chat/threads/:id — rename / archive / unarchive
router.patch('/threads/:id', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const id = parseId(req.params.id);
    if (id == null) {
      res.status(400).json({ error: 'invalid id' });
      return;
    }
    const row = await ChatThread.findOne({ where: { id, userId: user.id } });
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const b = (req.body || {}) as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(b, 'title')) {
      const t = b.title;
      if (t == null) {
        row.set('title', null);
      } else if (typeof t === 'string') {
        row.set('title', t.trim().slice(0, 256));
      } else {
        res.status(400).json({ error: 'title must be string or null' });
        return;
      }
    }
    if (Object.prototype.hasOwnProperty.call(b, 'archived')) {
      const a = b.archived;
      if (typeof a !== 'boolean') {
        res.status(400).json({ error: 'archived must be boolean' });
        return;
      }
      row.set('archivedAt', a ? new Date() : null);
    }
    await row.save();
    res.json(row.toJSON());
  } catch (e) {
    next(e);
  }
});

// DELETE /api/chat/threads/:id — hard delete (FKs cascade)
router.delete('/threads/:id', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const id = parseId(req.params.id);
    if (id == null) {
      res.status(400).json({ error: 'invalid id' });
      return;
    }
    const row = await ChatThread.findOne({ where: { id, userId: user.id } });
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    await row.destroy();
    res.status(204).send();
  } catch (e) {
    next(e);
  }
});

// POST /api/chat/threads/:id/messages — placeholder until Task 11
router.post('/threads/:id/messages', (_req, res) => {
  res.status(501).json({ error: 'chat loop not yet implemented (Task 11)' });
});

export default router;
```

- [ ] **Step 2: Register the router in `backend/src/app.ts`**

Add the import alongside the other route imports:

```ts
import chatRouter from './routes/chat';
import { getChatConfig } from './config/chat';
```

After the existing `app.use('/api/...')` registrations, add (location: pick a sensible spot among the other AI-adjacent routes):

```ts
if (getChatConfig().enabled) {
  app.use('/api/chat', chatRouter);
}
```

- [ ] **Step 3: Create the integration test**

**Before writing this file:** open `backend/test/integration/rulesEffectiveDates.test.ts` to learn the exact setup/teardown helpers this repo uses (per-file SQLite DB, `db:migrate` via execFileSync, first-user-superadmin shortcut, then real `Session` row + cookie injection). Match that pattern verbatim — do NOT invent helpers.

Create `backend/test/integration/chatThreadsCrud.test.ts`. **Set `process.env.CHAT_ENABLED = 'true'` BEFORE importing the app**, otherwise the router won't register. Required tests:

1. `GET /api/chat/threads` returns empty array initially.
2. `POST /api/chat/threads` with `{ title: 'Q4 cleanup' }` returns 201 with the new thread row; subsequent `GET` returns it.
3. `POST /api/chat/threads` with no title returns 201 and `title: null`.
4. `GET /api/chat/threads/:id` returns `{ thread, messages: [], proposals: [] }` for a freshly-created thread.
5. `GET /api/chat/threads/:id` returns 404 for an id that doesn't belong to the user (create a second user via the auth flow, create a thread as user1, attempt GET as user2).
6. `PATCH /api/chat/threads/:id` with `{ title: 'renamed' }` returns 200 and updates the title; second GET reflects the rename.
7. `PATCH /api/chat/threads/:id` with `{ archived: true }` sets `archivedAt`; subsequent `GET /api/chat/threads` (list) does NOT include it.
8. `PATCH /api/chat/threads/:id` with `{ archived: false }` clears `archivedAt`.
9. `DELETE /api/chat/threads/:id` returns 204; subsequent GET on the id is 404.
10. With `CHAT_ENABLED` unset, all `/api/chat/*` routes 404. (Build a separate small describe block that sets `process.env.CHAT_ENABLED = ''` before app construction — easiest path is a second test file but if you can do it in one, do it.)

- [ ] **Step 4: Run all tests**

```
yarn workspace cashflow-backend run typecheck
yarn workspace cashflow-backend run test
yarn workspace cashflow-backend run test:integration
```

All must PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/chat.ts backend/src/app.ts backend/test/integration/chatThreadsCrud.test.ts
git commit -m "feat(chat): thread CRUD endpoints behind CHAT_ENABLED flag"
```

---

### Task 6: OpenAI streaming client

**Files:**
- Create: `backend/src/ai/chat/openaiClient.ts`
- Create: `backend/test/chat/openaiClient.test.ts`

This is the streaming counterpart to `openaiJson.ts`. Calls `https://api.openai.com/v1/chat/completions` with `stream: true` and yields parsed SSE events as an AsyncIterable.

OpenAI's streaming format: HTTP response is `text/event-stream`. Each event is `data: <json>\n\n` lines. Terminal event is `data: [DONE]`. Each JSON chunk has shape `{ choices: [{ delta: { content?: string, tool_calls?: [...] }, finish_reason: string | null }], usage?: {...} }`.

- [ ] **Step 1: Write the client**

```ts
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
```

- [ ] **Step 2: Write tests with a stub fetch**

Create `backend/test/chat/openaiClient.test.ts`:

```ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { streamChat, type StreamEvent } from '../../src/ai/chat/openaiClient';

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
```

- [ ] **Step 3: Run tests**

```
yarn workspace cashflow-backend run typecheck
yarn workspace cashflow-backend exec -- tsx --test test/chat/openaiClient.test.ts
```

Expected: all 6 PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/src/ai/chat/openaiClient.ts backend/test/chat/openaiClient.test.ts
git commit -m "feat(chat): streaming OpenAI client with SSE parsing"
```

---

### Task 7: System prompt builder

**Files:**
- Create: `backend/src/ai/chat/systemPrompt.ts`
- Create: `backend/test/chat/systemPrompt.test.ts`

Pure function: takes a context object, returns a system-message string. No I/O.

- [ ] **Step 1: Write the module**

```ts
export interface SystemPromptContext {
  todayIso: string; // YYYY-MM-DD
  defaultCurrency: string;
  contacts: Array<{ id: number; name: string; currency: string | null }>;
}

const PATCH_WHITELIST = [
  'split_override',
  'pct_me_override',
  'pct_partner_override',
  'category_override',
  'business_override',
  'notes',
  'review_flag',
];

export function buildSystemPrompt(ctx: SystemPromptContext): string {
  const contactsLine =
    ctx.contacts.length > 0
      ? ctx.contacts
          .map((c) => `${c.id}:${c.name}${c.currency ? `(${c.currency})` : ''}`)
          .join(', ')
      : '(none)';
  return [
    `You are the Cashflow assistant. Today is ${ctx.todayIso}. The user's default currency is ${ctx.defaultCurrency}. Household contacts: ${contactsLine}.`,
    '',
    'You can read transaction data and propose mutations. You DO NOT apply mutations — every `propose_*` tool returns a proposal_id and a preview; the user clicks Apply in the UI to execute. Tell the user what you are proposing and let them confirm.',
    '',
    `Patch fields you may set on transactions: ${PATCH_WHITELIST.join(', ')}. Auto-* fields are managed by the system.`,
    '',
    'Prefer bullet summaries when proposing. When a filter could be too broad, call query_transactions first to sanity-check the count.',
  ].join('\n');
}
```

- [ ] **Step 2: Tests**

Create `backend/test/chat/systemPrompt.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../../src/ai/chat/systemPrompt';

test('buildSystemPrompt includes date, currency, and contacts', () => {
  const out = buildSystemPrompt({
    todayIso: '2026-05-24',
    defaultCurrency: 'CAD',
    contacts: [
      { id: 7, name: 'Alice', currency: 'CAD' },
      { id: 9, name: 'Bob', currency: null },
    ],
  });
  assert.match(out, /Today is 2026-05-24/);
  assert.match(out, /default currency is CAD/);
  assert.match(out, /7:Alice\(CAD\)/);
  assert.match(out, /9:Bob/);
  assert.doesNotMatch(out, /9:Bob\(/);
});

test('buildSystemPrompt handles empty contacts', () => {
  const out = buildSystemPrompt({
    todayIso: '2026-05-24',
    defaultCurrency: 'USD',
    contacts: [],
  });
  assert.match(out, /Household contacts: \(none\)/);
});

test('buildSystemPrompt enforces apply-vs-propose contract', () => {
  const out = buildSystemPrompt({
    todayIso: '2026-05-24',
    defaultCurrency: 'CAD',
    contacts: [],
  });
  assert.match(out, /You DO NOT apply mutations/);
  assert.match(out, /the user clicks Apply in the UI/);
});

test('buildSystemPrompt lists the patch whitelist', () => {
  const out = buildSystemPrompt({
    todayIso: '2026-05-24',
    defaultCurrency: 'CAD',
    contacts: [],
  });
  for (const field of [
    'split_override',
    'pct_me_override',
    'pct_partner_override',
    'category_override',
    'business_override',
    'notes',
    'review_flag',
  ]) {
    assert.match(out, new RegExp(field));
  }
});
```

- [ ] **Step 3: Run tests + commit**

```
yarn workspace cashflow-backend exec -- tsx --test test/chat/systemPrompt.test.ts
```

Expected: 4/4 PASS.

```bash
git add backend/src/ai/chat/systemPrompt.ts backend/test/chat/systemPrompt.test.ts
git commit -m "feat(chat): system prompt builder"
```

---

### Task 8: Tool surface — read tools

**Files:**
- Create: `backend/src/ai/chat/tools.ts` — registry + dispatcher + 5 read tools
- Create: `backend/test/chat/toolsRead.test.ts`

Each tool exports its OpenAI schema and an `execute(args, ctx)` function. A dispatcher map routes by tool name.

- [ ] **Step 1: Write `tools.ts` with the 5 read tools**

```ts
import { Op } from 'sequelize';
import {
  Transaction,
  Rule,
  Contact,
  ChatProposal,
  ChatMessage,
} from '../../models';
import { sequelize } from '../../db';
import { getChatConfig } from '../../config/chat';
import type { ChatToolDefinition } from './openaiClient';

/**
 * Escape LIKE wildcards in user-supplied substrings. We use LIKE (not REGEXP)
 * because the sqlite3 npm package this repo uses does not register a REGEXP
 * function by default; LIKE works on both SQLite and Postgres without extra
 * setup. The tool's `merchant_pattern` field is documented as a case-insensitive
 * substring — if the LLM needs alternation it can call the tool multiple times
 * and union the results.
 */
function escapeLikePattern(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export interface ToolContext {
  userId: number;
  householdId: number | null;
  threadId: number;
  messageId: number;
}

export interface ToolResult {
  ok: true;
  data: unknown;
}
export interface ToolError {
  ok: false;
  error: string;
}
export type ToolReturn = ToolResult | ToolError;

interface ToolImpl {
  schema: ChatToolDefinition;
  execute(args: unknown, ctx: ToolContext): Promise<ToolReturn>;
}

const tools: Record<string, ToolImpl> = {};

export function registerTool(name: string, impl: ToolImpl) {
  tools[name] = impl;
}

export function getToolDefinitions(): ChatToolDefinition[] {
  return Object.values(tools).map((t) => t.schema);
}

export async function dispatchTool(
  name: string,
  argsJson: string,
  ctx: ToolContext
): Promise<ToolReturn> {
  const t = tools[name];
  if (!t) return { ok: false, error: `unknown tool: ${name}` };
  let parsed: unknown;
  try {
    parsed = argsJson.trim().length === 0 ? {} : JSON.parse(argsJson);
  } catch {
    return { ok: false, error: 'tool arguments must be valid JSON' };
  }
  try {
    return await t.execute(parsed, ctx);
  } catch (e) {
    return {
      ok: false,
      error: `tool execution failed: ${(e as Error).message}`,
    };
  }
}

// ============================================================================
// query_transactions
// ============================================================================
registerTool('query_transactions', {
  schema: {
    type: 'function',
    function: {
      name: 'query_transactions',
      description:
        'Search the user transactions by filter. Returns up to `limit` matching rows plus the total matched count. Use to ground answers and to sanity-check the scope of a future bulk mutation.',
      parameters: {
        type: 'object',
        properties: {
          merchant_pattern: {
            type: 'string',
            description:
              'Case-insensitive substring applied to merchant_clean. Call the tool multiple times if you need alternation (`grocer` then `loblaws`).',
          },
          category: { type: 'string' },
          currency: { type: 'string' },
          date_from: { type: 'string', description: 'YYYY-MM-DD inclusive' },
          date_to: { type: 'string', description: 'YYYY-MM-DD inclusive' },
          account_id: { type: 'integer' },
          split_type: {
            type: 'string',
            enum: ['me', 'partner', 'shared', 'business'],
          },
          review_flag: { type: 'boolean' },
          min_amount: { type: 'number' },
          max_amount: { type: 'number' },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
        },
      },
    },
  },
  async execute(args, ctx) {
    const a = (args as Record<string, unknown>) ?? {};
    const where: Record<string, unknown> = {};
    if (ctx.householdId != null) where.householdId = ctx.householdId;
    if (typeof a.merchant_pattern === 'string')
      where.merchantClean = { [Op.like]: `%${escapeLikePattern(a.merchant_pattern)}%` };
    if (typeof a.category === 'string') where.finalCategory = a.category;
    if (typeof a.currency === 'string') where.currency = a.currency;
    if (typeof a.account_id === 'number') where.accountId = a.account_id;
    if (typeof a.split_type === 'string') where.finalSplitType = a.split_type;
    if (typeof a.review_flag === 'boolean') where.reviewFlag = a.review_flag;
    const dateRange: Record<string, unknown> = {};
    if (typeof a.date_from === 'string') dateRange[Op.gte] = a.date_from;
    if (typeof a.date_to === 'string') dateRange[Op.lte] = a.date_to;
    if (Object.getOwnPropertySymbols(dateRange).length > 0) where.date = dateRange;
    const amountRange: Record<string, unknown> = {};
    if (typeof a.min_amount === 'number') amountRange[Op.gte] = a.min_amount;
    if (typeof a.max_amount === 'number') amountRange[Op.lte] = a.max_amount;
    if (Object.getOwnPropertySymbols(amountRange).length > 0) where.amount = amountRange;

    const limit = Math.min(
      Math.max(typeof a.limit === 'number' ? Math.floor(a.limit) : 20, 1),
      50
    );
    const matchedCount = await Transaction.count({ where });
    const rows = await Transaction.findAll({
      where,
      order: [
        ['date', 'DESC'],
        ['id', 'DESC'],
      ],
      limit,
    });
    return {
      ok: true,
      data: {
        matched_count: matchedCount,
        rows: rows.map((r) => {
          const j = r.toJSON();
          return {
            id: j.id,
            date: j.date,
            merchant_clean: j.merchantClean,
            amount: j.amount,
            currency: j.currency,
            final_category: j.finalCategory,
            final_business: j.finalBusiness,
            final_split_type: j.finalSplitType,
            final_pct_me: j.finalPctMe,
            final_pct_partner: j.finalPctPartner,
            review_flag: j.reviewFlag,
          };
        }),
      },
    };
  },
});

// ============================================================================
// get_summary
// ============================================================================
registerTool('get_summary', {
  schema: {
    type: 'function',
    function: {
      name: 'get_summary',
      description:
        'Aggregated totals. Wraps the existing /api/summary endpoints. Pick scope based on what the user is asking — dashboard for overall spend, partner for partner-split totals, business for business spend, monthly for a month-by-month breakdown.',
      parameters: {
        type: 'object',
        required: ['scope'],
        properties: {
          scope: { type: 'string', enum: ['dashboard', 'partner', 'business', 'monthly'] },
          currency: { type: 'string' },
          date_from: { type: 'string', description: 'YYYY-MM-DD inclusive' },
          date_to: { type: 'string', description: 'YYYY-MM-DD inclusive' },
        },
      },
    },
  },
  async execute(args, ctx) {
    // Reach into the same SQL the summary routes use. We do NOT call the HTTP
    // endpoints — that would require an internal HTTP client. Instead replicate
    // the most-useful aggregates here. For PR2 we ship a thin version and
    // expand based on real LLM usage.
    const a = (args as Record<string, unknown>) ?? {};
    if (typeof a.scope !== 'string') {
      return { ok: false, error: 'scope is required' };
    }
    const where: Record<string, unknown> = {};
    if (ctx.householdId != null) where.householdId = ctx.householdId;
    if (typeof a.currency === 'string') where.currency = a.currency;
    const dateRange: Record<string, unknown> = {};
    if (typeof a.date_from === 'string') dateRange[Op.gte] = a.date_from;
    if (typeof a.date_to === 'string') dateRange[Op.lte] = a.date_to;
    if (Object.getOwnPropertySymbols(dateRange).length > 0) where.date = dateRange;

    if (a.scope === 'dashboard') {
      const [count, sumRow] = await Promise.all([
        Transaction.count({ where }),
        Transaction.findOne({
          where,
          attributes: [
            [sequelize.fn('SUM', sequelize.col('amount')), 'total_amount'],
            [sequelize.fn('SUM', sequelize.col('my_share_amount')), 'total_my_share'],
            [
              sequelize.fn('SUM', sequelize.col('partner_share_amount')),
              'total_partner_share',
            ],
            [sequelize.fn('SUM', sequelize.col('business_amount')), 'total_business'],
          ],
          raw: true,
        }),
      ]);
      return { ok: true, data: { count, ...(sumRow as Record<string, unknown>) } };
    }
    if (a.scope === 'partner') {
      const grouped = await Transaction.findAll({
        where,
        attributes: [
          'finalSplitType',
          [sequelize.fn('SUM', sequelize.col('my_share_amount')), 'my_share'],
          [
            sequelize.fn('SUM', sequelize.col('partner_share_amount')),
            'partner_share',
          ],
          [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
        ],
        group: ['finalSplitType'],
        raw: true,
      });
      return { ok: true, data: { by_split_type: grouped } };
    }
    if (a.scope === 'business') {
      const total = await Transaction.findOne({
        where: { ...where, finalBusiness: true },
        attributes: [
          [sequelize.fn('SUM', sequelize.col('amount')), 'total_amount'],
          [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
        ],
        raw: true,
      });
      return { ok: true, data: total };
    }
    if (a.scope === 'monthly') {
      // SQLite-friendly month bucket via strftime; falls back to date_trunc on pg.
      const dialect = sequelize.getDialect();
      const monthExpr =
        dialect === 'postgres'
          ? sequelize.fn('to_char', sequelize.col('date'), 'YYYY-MM')
          : sequelize.fn('strftime', '%Y-%m', sequelize.col('date'));
      const grouped = await Transaction.findAll({
        where,
        attributes: [
          [monthExpr, 'month'],
          [sequelize.fn('SUM', sequelize.col('amount')), 'total'],
          [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
        ],
        group: ['month'],
        order: [[sequelize.literal('month'), 'ASC']],
        raw: true,
      });
      return { ok: true, data: { by_month: grouped } };
    }
    return { ok: false, error: `unknown scope: ${a.scope}` };
  },
});

// ============================================================================
// get_rules
// ============================================================================
registerTool('get_rules', {
  schema: {
    type: 'function',
    function: {
      name: 'get_rules',
      description:
        'List all rules visible to the user, optionally filtered to those effective on a given date.',
      parameters: {
        type: 'object',
        properties: {
          active_on: { type: 'string', description: 'YYYY-MM-DD' },
        },
      },
    },
  },
  async execute(args, ctx) {
    const a = (args as Record<string, unknown>) ?? {};
    const where: Record<string, unknown> = {};
    if (ctx.householdId != null) where.householdId = ctx.householdId;
    const all = await Rule.findAll({
      where,
      order: [
        ['priority', 'DESC'],
        ['id', 'DESC'],
      ],
    });
    const active_on = typeof a.active_on === 'string' ? a.active_on : null;
    const filtered = active_on
      ? all.filter((r) => {
          const j = r.toJSON();
          if (j.effectiveFrom != null && active_on < j.effectiveFrom) return false;
          if (j.effectiveTo != null && active_on >= j.effectiveTo) return false;
          return true;
        })
      : all;
    return { ok: true, data: filtered.map((r) => r.toJSON()) };
  },
});

// ============================================================================
// get_contacts
// ============================================================================
registerTool('get_contacts', {
  schema: {
    type: 'function',
    function: {
      name: 'get_contacts',
      description:
        'List the household contacts (partner, payees). Useful for resolving a name to a contact id when proposing transaction edits.',
      parameters: { type: 'object', properties: {} },
    },
  },
  async execute(_args, ctx) {
    const where: Record<string, unknown> = {};
    if (ctx.householdId != null) where.householdId = ctx.householdId;
    const rows = await Contact.findAll({ where, order: [['id', 'ASC']] });
    return {
      ok: true,
      data: rows.map((r) => {
        const j = r.toJSON();
        return { id: j.id, name: j.name, currency: j.currency ?? null };
      }),
    };
  },
});

// ============================================================================
// get_categories
// ============================================================================
registerTool('get_categories', {
  schema: {
    type: 'function',
    function: {
      name: 'get_categories',
      description:
        'List the distinct categories already in use across rules and transactions. Use this for category vocabulary grounding before proposing a category change.',
      parameters: { type: 'object', properties: {} },
    },
  },
  async execute(_args, ctx) {
    const tWhere: Record<string, unknown> = {
      finalCategory: { [Op.not]: null },
    };
    if (ctx.householdId != null) tWhere.householdId = ctx.householdId;
    const txnRows = await Transaction.findAll({
      where: tWhere,
      attributes: [
        [sequelize.fn('DISTINCT', sequelize.col('final_category')), 'category'],
      ],
      raw: true,
    });
    const rWhere: Record<string, unknown> = {
      category: { [Op.not]: null },
    };
    if (ctx.householdId != null) rWhere.householdId = ctx.householdId;
    const ruleRows = await Rule.findAll({
      where: rWhere,
      attributes: [
        [sequelize.fn('DISTINCT', sequelize.col('category')), 'category'],
      ],
      raw: true,
    });
    const set = new Set<string>();
    for (const r of txnRows as Array<{ category: string | null }>) {
      if (r.category) set.add(r.category);
    }
    for (const r of ruleRows as Array<{ category: string | null }>) {
      if (r.category) set.add(r.category);
    }
    return { ok: true, data: { categories: [...set].sort() } };
  },
});
```

- [ ] **Step 2: Write unit tests for the read tools**

Create `backend/test/chat/toolsRead.test.ts`. Tests use the existing test-DB helper from neighboring tests. For each tool, seed minimal fixtures and assert the shape of the response.

Required tests (one per tool, focus on the contract not exhaustive coverage — the underlying Sequelize behavior is already tested elsewhere):

1. `query_transactions` returns matching rows and a count, respects `limit`.
2. `query_transactions` honors `date_from` / `date_to` / `merchant_pattern`.
3. `get_summary` with `scope: 'dashboard'` returns `{ count, total_amount, ... }`.
4. `get_summary` rejects unknown scope.
5. `get_rules` returns all rules; with `active_on`, filters by effective bounds.
6. `get_contacts` returns the household contacts.
7. `get_categories` deduplicates between rules and transactions.
8. `dispatchTool` with an unknown name returns `{ ok: false, error: /unknown/ }`.
9. `dispatchTool` with malformed JSON args returns `{ ok: false, error: /valid JSON/ }`.

**Test infra note:** these are unit tests, not integration tests — they run via `yarn workspace cashflow-backend run test` (the `tsx --test test/*.test.ts test/chat/*.test.ts ...` script). Make sure the script picks up `test/chat/*.test.ts` — if not, update `backend/package.json`'s `test` script to include `test/chat/*.test.ts`.

- [ ] **Step 3: Update test script if needed**

If `backend/package.json` `test` script doesn't include `test/chat/*.test.ts`, add it:

```json
"test": "tsx --test test/*.test.ts test/portfolio/*.test.ts test/fx/*.test.ts test/chat/*.test.ts"
```

- [ ] **Step 4: Run tests**

```
yarn workspace cashflow-backend run typecheck
yarn workspace cashflow-backend run test
```

All PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/ai/chat/tools.ts backend/test/chat/toolsRead.test.ts backend/package.json
git commit -m "feat(chat): read tools (query_transactions, get_summary, get_rules, get_contacts, get_categories) + dispatcher"
```

---

### Task 9: Tool surface — mutation tools + proposal builders

**Files:**
- Create: `backend/src/ai/chat/proposals.ts` — preview builders + apply logic
- Modify: `backend/src/ai/chat/tools.ts` — add 5 mutation tools (they call into `proposals.ts`)
- Create: `backend/test/chat/toolsMutation.test.ts`
- Create: `backend/test/chat/proposals.test.ts`

Mutation tools build a preview, persist a `ChatProposal` with `status='pending'`, and return `{ proposal_id, preview }`. They never apply.

`proposals.ts` also exports `applyProposal(proposalId, ctx)` — used by Task 12's endpoint.

- [ ] **Step 1: Write `proposals.ts`**

```ts
import { Op } from 'sequelize';
import {
  ChatProposal,
  ChatMessage,
  Transaction,
  Rule,
} from '../../models';
import type { ChatProposalKind, ChatProposalStatus } from '../../models/ChatProposal';
import { sequelize } from '../../db';
import { getChatConfig } from '../../config/chat';

const PATCH_WHITELIST = new Set([
  'split_override',
  'pct_me_override',
  'pct_partner_override',
  'category_override',
  'business_override',
  'notes',
  'review_flag',
]);

const PATCH_FIELD_MAP: Record<string, string> = {
  split_override: 'splitOverride',
  pct_me_override: 'pctMeOverride',
  pct_partner_override: 'pctPartnerOverride',
  category_override: 'categoryOverride',
  business_override: 'businessOverride',
  notes: 'notes',
  review_flag: 'reviewFlag',
};

export interface ProposalContext {
  userId: number;
  householdId: number | null;
  threadId: number;
  messageId: number;
}

function whitelistPatch(patch: unknown): Record<string, unknown> | { error: string } {
  if (patch == null || typeof patch !== 'object') {
    return { error: 'patch must be an object' };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (!PATCH_WHITELIST.has(k)) {
      return { error: `field "${k}" is not in the patch whitelist` };
    }
    out[k] = v;
  }
  if (Object.keys(out).length === 0) {
    return { error: 'patch must include at least one whitelisted field' };
  }
  return out;
}

function applyPatchToTxn(txn: Transaction, snakePatch: Record<string, unknown>) {
  for (const [snake, value] of Object.entries(snakePatch)) {
    const camel = PATCH_FIELD_MAP[snake];
    if (camel) txn.set(camel as keyof Transaction['_attributes'], value as never);
  }
}

function expiresAt(): Date {
  const hours = getChatConfig().proposalExpiryHours;
  return new Date(Date.now() + hours * 3600 * 1000);
}

// ============================================================================
// transaction_edit
// ============================================================================
export async function buildTransactionEditPreview(
  transactionId: number,
  patch: Record<string, unknown>,
  ctx: ProposalContext
): Promise<{ proposal_id: number; preview: Record<string, unknown> } | { error: string }> {
  const where: Record<string, unknown> = { id: transactionId };
  if (ctx.householdId != null) where.householdId = ctx.householdId;
  const txn = await Transaction.findOne({ where });
  if (!txn) return { error: `transaction ${transactionId} not visible to user` };
  const before = txn.toJSON();
  // Simulate the patch on a clone to compute "after" without mutating the row.
  const afterMock = txn.toJSON() as Record<string, unknown>;
  for (const [snake, value] of Object.entries(patch)) {
    const camel = PATCH_FIELD_MAP[snake];
    if (camel) afterMock[camel] = value;
  }
  const preview = { before, after: afterMock };
  const proposal = await ChatProposal.create({
    threadId: ctx.threadId,
    messageId: ctx.messageId,
    kind: 'transaction_edit',
    payload: { transaction_id: transactionId, patch },
    preview,
    status: 'pending',
    expiresAt: expiresAt(),
    appliedAt: null,
    appliedResult: null,
  });
  return { proposal_id: proposal.id, preview };
}

// ============================================================================
// bulk_patch
// ============================================================================
const BULK_PATCH_LIMIT = 500;

export async function buildBulkPatchPreview(
  filter: Record<string, unknown>,
  patch: Record<string, unknown>,
  ctx: ProposalContext
): Promise<{ proposal_id: number; preview: Record<string, unknown> } | { error: string }> {
  const where = buildBulkFilterWhere(filter, ctx);
  const matchedCount = await Transaction.count({ where });
  if (matchedCount > BULK_PATCH_LIMIT) {
    return {
      error: `filter_too_broad: ${matchedCount} rows match; reduce the scope (max ${BULK_PATCH_LIMIT}).`,
    };
  }
  const sample = await Transaction.findAll({
    where,
    order: [
      ['date', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: 10,
  });
  const sampleWithDiff = sample.map((r) => {
    const before = r.toJSON();
    const after = { ...before } as Record<string, unknown>;
    for (const [snake, value] of Object.entries(patch)) {
      const camel = PATCH_FIELD_MAP[snake];
      if (camel) after[camel] = value;
    }
    return { before, after };
  });
  const preview = {
    matched_count: matchedCount,
    filter_summary: summarizeFilter(filter),
    sample: sampleWithDiff,
  };
  const proposal = await ChatProposal.create({
    threadId: ctx.threadId,
    messageId: ctx.messageId,
    kind: 'bulk_patch',
    payload: { filter, patch },
    preview,
    status: 'pending',
    expiresAt: expiresAt(),
    appliedAt: null,
    appliedResult: null,
  });
  return { proposal_id: proposal.id, preview };
}

function buildBulkFilterWhere(
  filter: Record<string, unknown>,
  ctx: ProposalContext
): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  if (ctx.householdId != null) where.householdId = ctx.householdId;
  if (typeof filter.merchant_pattern === 'string') {
    where.merchantClean = {
      [Op.like]: `%${filter.merchant_pattern.replace(/[\\%_]/g, (c) => `\\${c}`)}%`,
    };
  }
  if (typeof filter.category === 'string') where.finalCategory = filter.category;
  if (typeof filter.currency === 'string') where.currency = filter.currency;
  if (typeof filter.account_id === 'number') where.accountId = filter.account_id;
  if (typeof filter.split_type === 'string') where.finalSplitType = filter.split_type;
  const dateRange: Record<string, unknown> = {};
  if (typeof filter.date_from === 'string') dateRange[Op.gte] = filter.date_from;
  if (typeof filter.date_to === 'string') dateRange[Op.lte] = filter.date_to;
  if (Object.getOwnPropertySymbols(dateRange).length > 0) where.date = dateRange;
  return where;
}

function summarizeFilter(filter: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(filter)) {
    if (v != null) parts.push(`${k}=${JSON.stringify(v)}`);
  }
  return parts.join(', ');
}

// ============================================================================
// rule_create / update / delete
// ============================================================================
export async function buildRuleCreatePreview(
  body: Record<string, unknown>,
  ctx: ProposalContext
): Promise<{ proposal_id: number; preview: Record<string, unknown> } | { error: string }> {
  // Minimal validation; the actual Rule.create at apply-time will enforce more.
  if (!body.merchant_pattern || typeof body.merchant_pattern !== 'string') {
    return { error: 'merchant_pattern is required' };
  }
  // Estimate how many EXISTING transactions in the effective window would match.
  const where: Record<string, unknown> = {
    merchantClean: {
      [Op.like]: `%${(body.merchant_pattern as string).replace(/[\\%_]/g, (c) => `\\${c}`)}%`,
    },
  };
  if (ctx.householdId != null) where.householdId = ctx.householdId;
  const dateRange: Record<string, unknown> = {};
  if (typeof body.effective_from === 'string') dateRange[Op.gte] = body.effective_from;
  if (typeof body.effective_to === 'string') dateRange[Op.lt] = body.effective_to;
  if (Object.getOwnPropertySymbols(dateRange).length > 0) where.date = dateRange;
  const wouldAffect = await Transaction.count({ where });
  const preview = {
    rule_preview: body,
    would_affect_existing_count: wouldAffect,
  };
  const proposal = await ChatProposal.create({
    threadId: ctx.threadId,
    messageId: ctx.messageId,
    kind: 'rule_create',
    payload: body,
    preview,
    status: 'pending',
    expiresAt: expiresAt(),
    appliedAt: null,
    appliedResult: null,
  });
  return { proposal_id: proposal.id, preview };
}

export async function buildRuleUpdatePreview(
  ruleId: number,
  patch: Record<string, unknown>,
  ctx: ProposalContext
): Promise<{ proposal_id: number; preview: Record<string, unknown> } | { error: string }> {
  const where: Record<string, unknown> = { id: ruleId };
  if (ctx.householdId != null) where.householdId = ctx.householdId;
  const rule = await Rule.findOne({ where });
  if (!rule) return { error: `rule ${ruleId} not visible to user` };
  const before = rule.toJSON();
  const after = { ...before, ...patch } as Record<string, unknown>;
  const mergedPattern = (after.merchantPattern ?? after.merchant_pattern) as string;
  const txWhere: Record<string, unknown> = {
    merchantClean: {
      [Op.like]: `%${mergedPattern.replace(/[\\%_]/g, (c) => `\\${c}`)}%`,
    },
  };
  if (ctx.householdId != null) txWhere.householdId = ctx.householdId;
  const wouldAffect = await Transaction.count({ where: txWhere });
  const preview = { before, after, would_affect_existing_count: wouldAffect };
  const proposal = await ChatProposal.create({
    threadId: ctx.threadId,
    messageId: ctx.messageId,
    kind: 'rule_update',
    payload: { rule_id: ruleId, patch },
    preview,
    status: 'pending',
    expiresAt: expiresAt(),
    appliedAt: null,
    appliedResult: null,
  });
  return { proposal_id: proposal.id, preview };
}

export async function buildRuleDeletePreview(
  ruleId: number,
  ctx: ProposalContext
): Promise<{ proposal_id: number; preview: Record<string, unknown> } | { error: string }> {
  const where: Record<string, unknown> = { id: ruleId };
  if (ctx.householdId != null) where.householdId = ctx.householdId;
  const rule = await Rule.findOne({ where });
  if (!rule) return { error: `rule ${ruleId} not visible to user` };
  const preview = { rule_summary: rule.toJSON() };
  const proposal = await ChatProposal.create({
    threadId: ctx.threadId,
    messageId: ctx.messageId,
    kind: 'rule_delete',
    payload: { rule_id: ruleId },
    preview,
    status: 'pending',
    expiresAt: expiresAt(),
    appliedAt: null,
    appliedResult: null,
  });
  return { proposal_id: proposal.id, preview };
}

// ============================================================================
// applyProposal — used by /api/chat/proposals/:id/apply
// ============================================================================
export interface ApplyResult {
  ok: true;
  status: ChatProposalStatus;
  result: Record<string, unknown>;
}
export interface ApplyError {
  ok: false;
  code: 'not_pending' | 'expired' | 'count_drifted' | 'not_found';
  message: string;
  extra?: Record<string, unknown>;
}

export async function applyProposal(
  proposalId: number,
  ctx: ProposalContext
): Promise<ApplyResult | ApplyError> {
  return sequelize.transaction(async (t) => {
    const proposal = await ChatProposal.findOne({
      where: { id: proposalId, threadId: ctx.threadId },
      transaction: t,
    });
    if (!proposal) {
      return {
        ok: false as const,
        code: 'not_found',
        message: 'proposal not found in this thread',
      };
    }
    if (proposal.status === 'expired' || proposal.expiresAt.getTime() < Date.now()) {
      if (proposal.status !== 'expired') {
        proposal.set('status', 'expired');
        await proposal.save({ transaction: t });
      }
      return { ok: false as const, code: 'expired', message: 'proposal expired' };
    }
    if (proposal.status !== 'pending') {
      return {
        ok: false as const,
        code: 'not_pending',
        message: `proposal status is "${proposal.status}"`,
      };
    }

    let result: Record<string, unknown>;
    switch (proposal.kind) {
      case 'transaction_edit':
        result = await applyTransactionEdit(proposal, ctx, t);
        break;
      case 'bulk_patch': {
        const driftCheck = await checkBulkDrift(proposal, ctx, t);
        if (driftCheck.code === 'count_drifted') return driftCheck;
        result = await applyBulkPatch(proposal, ctx, t);
        break;
      }
      case 'rule_create':
        result = await applyRuleCreate(proposal, ctx, t);
        break;
      case 'rule_update':
        result = await applyRuleUpdate(proposal, ctx, t);
        break;
      case 'rule_delete':
        result = await applyRuleDelete(proposal, ctx, t);
        break;
      default:
        return {
          ok: false as const,
          code: 'not_pending',
          message: `unknown kind: ${proposal.kind}`,
        };
    }

    proposal.set('status', 'applied');
    proposal.set('appliedAt', new Date());
    proposal.set('appliedResult', result);
    await proposal.save({ transaction: t });

    // Append a role=tool message describing what happened (so the LLM sees it
    // on the next user turn).
    await ChatMessage.create(
      {
        threadId: ctx.threadId,
        role: 'tool',
        contentText: JSON.stringify({ applied: proposal.kind, result }),
        toolCalls: null,
        toolCallId: `proposal_${proposalId}`,
        toolName: `apply_${proposal.kind}`,
        model: null,
        promptTokens: null,
        completionTokens: null,
        latencyMs: null,
        providerRequestId: null,
      },
      { transaction: t }
    );

    return { ok: true as const, status: 'applied', result };
  });
}

async function applyTransactionEdit(
  proposal: ChatProposal,
  ctx: ProposalContext,
  t: import('sequelize').Transaction
): Promise<Record<string, unknown>> {
  const payload = proposal.payload as { transaction_id: number; patch: Record<string, unknown> };
  const where: Record<string, unknown> = { id: payload.transaction_id };
  if (ctx.householdId != null) where.householdId = ctx.householdId;
  const txn = await Transaction.findOne({ where, transaction: t });
  if (!txn) throw new Error(`transaction ${payload.transaction_id} disappeared`);
  applyPatchToTxn(txn, payload.patch);
  await txn.save({ transaction: t });
  return { updated_id: payload.transaction_id };
}

async function checkBulkDrift(
  proposal: ChatProposal,
  ctx: ProposalContext,
  t: import('sequelize').Transaction
): Promise<ApplyError | { code: 'ok' }> {
  const payload = proposal.payload as { filter: Record<string, unknown> };
  const where = buildBulkFilterWhere(payload.filter, ctx);
  const currentCount = await Transaction.count({ where, transaction: t });
  const previewCount =
    (proposal.preview as { matched_count?: number }).matched_count ?? 0;
  const drift = getChatConfig().proposalDriftPct;
  const denom = Math.max(previewCount, 1);
  const observed = Math.abs(currentCount - previewCount) / denom;
  if (observed > drift) {
    return {
      ok: false,
      code: 'count_drifted',
      message: `matched count drifted from ${previewCount} to ${currentCount}`,
      extra: { preview_count: previewCount, current_count: currentCount },
    };
  }
  return { code: 'ok' };
}

async function applyBulkPatch(
  proposal: ChatProposal,
  ctx: ProposalContext,
  t: import('sequelize').Transaction
): Promise<Record<string, unknown>> {
  const payload = proposal.payload as {
    filter: Record<string, unknown>;
    patch: Record<string, unknown>;
  };
  const where = buildBulkFilterWhere(payload.filter, ctx);
  const matched = await Transaction.findAll({ where, transaction: t });
  for (const txn of matched) {
    applyPatchToTxn(txn, payload.patch);
    await txn.save({ transaction: t });
  }
  return { updated_count: matched.length, ids: matched.map((m) => m.id) };
}

async function applyRuleCreate(
  proposal: ChatProposal,
  ctx: ProposalContext,
  t: import('sequelize').Transaction
): Promise<Record<string, unknown>> {
  const body = proposal.payload as Record<string, unknown>;
  const row = await Rule.create(
    {
      merchantPattern: String(body.merchant_pattern),
      matchKind: typeof body.match_kind === 'string' ? body.match_kind : 'substring',
      priority: typeof body.priority === 'number' ? body.priority : 0,
      category: typeof body.category === 'string' ? body.category : null,
      isBusiness: Boolean(body.is_business),
      splitType: typeof body.split_type === 'string' ? body.split_type : 'me',
      pctMe: body.pct_me != null ? String(body.pct_me) : null,
      pctPartner: body.pct_partner != null ? String(body.pct_partner) : null,
      effectiveFrom: typeof body.effective_from === 'string' ? body.effective_from : null,
      effectiveTo: typeof body.effective_to === 'string' ? body.effective_to : null,
      householdId: ctx.householdId,
      createdByUserId: ctx.userId,
    },
    { transaction: t }
  );
  return { rule_id: row.id };
}

async function applyRuleUpdate(
  proposal: ChatProposal,
  ctx: ProposalContext,
  t: import('sequelize').Transaction
): Promise<Record<string, unknown>> {
  const payload = proposal.payload as { rule_id: number; patch: Record<string, unknown> };
  const where: Record<string, unknown> = { id: payload.rule_id };
  if (ctx.householdId != null) where.householdId = ctx.householdId;
  const rule = await Rule.findOne({ where, transaction: t });
  if (!rule) throw new Error(`rule ${payload.rule_id} disappeared`);
  for (const [k, v] of Object.entries(payload.patch)) {
    // Convert snake_case keys from the LLM to the model's camelCase fields.
    const camel = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    rule.set(camel as keyof Rule['_attributes'], v as never);
  }
  await rule.save({ transaction: t });
  return { rule_id: payload.rule_id };
}

async function applyRuleDelete(
  proposal: ChatProposal,
  ctx: ProposalContext,
  t: import('sequelize').Transaction
): Promise<Record<string, unknown>> {
  const payload = proposal.payload as { rule_id: number };
  const where: Record<string, unknown> = { id: payload.rule_id };
  if (ctx.householdId != null) where.householdId = ctx.householdId;
  const rule = await Rule.findOne({ where, transaction: t });
  if (!rule) throw new Error(`rule ${payload.rule_id} disappeared`);
  await rule.destroy({ transaction: t });
  return { deleted_rule_id: payload.rule_id };
}
```

- [ ] **Step 2: Add mutation tools to `tools.ts`**

Append to `backend/src/ai/chat/tools.ts`:

```ts
import {
  buildTransactionEditPreview,
  buildBulkPatchPreview,
  buildRuleCreatePreview,
  buildRuleUpdatePreview,
  buildRuleDeletePreview,
} from './proposals';

registerTool('propose_transaction_edit', {
  schema: {
    type: 'function',
    function: {
      name: 'propose_transaction_edit',
      description:
        'Stage a per-row edit. Returns a proposal_id + before/after preview. Apply happens when the user clicks Apply.',
      parameters: {
        type: 'object',
        required: ['transaction_id', 'patch'],
        properties: {
          transaction_id: { type: 'integer' },
          patch: {
            type: 'object',
            description:
              'Whitelisted fields: split_override, pct_me_override, pct_partner_override, category_override, business_override, notes, review_flag.',
          },
        },
      },
    },
  },
  async execute(args, ctx) {
    const a = (args as Record<string, unknown>) ?? {};
    if (typeof a.transaction_id !== 'number') {
      return { ok: false, error: 'transaction_id is required (integer)' };
    }
    const r = await buildTransactionEditPreview(
      a.transaction_id,
      (a.patch as Record<string, unknown>) ?? {},
      ctx
    );
    return 'error' in r ? { ok: false, error: r.error } : { ok: true, data: r };
  },
});

registerTool('propose_bulk_patch', {
  schema: {
    type: 'function',
    function: {
      name: 'propose_bulk_patch',
      description:
        'Stage a bulk edit by filter. Returns matched_count + sample (≤10 before/after rows). If matched_count is too high, you get a filter_too_broad error — refine and retry.',
      parameters: {
        type: 'object',
        required: ['filter', 'patch'],
        properties: {
          filter: {
            type: 'object',
            description:
              'Same filter shape as query_transactions: merchant_pattern, category, currency, date_from, date_to, account_id, split_type.',
          },
          patch: { type: 'object' },
        },
      },
    },
  },
  async execute(args, ctx) {
    const a = (args as Record<string, unknown>) ?? {};
    const r = await buildBulkPatchPreview(
      (a.filter as Record<string, unknown>) ?? {},
      (a.patch as Record<string, unknown>) ?? {},
      ctx
    );
    return 'error' in r ? { ok: false, error: r.error } : { ok: true, data: r };
  },
});

registerTool('propose_rule_create', {
  schema: {
    type: 'function',
    function: {
      name: 'propose_rule_create',
      description: 'Stage creating a new rule, optionally date-scoped.',
      parameters: {
        type: 'object',
        required: ['merchant_pattern'],
        properties: {
          merchant_pattern: { type: 'string' },
          match_kind: { type: 'string', enum: ['substring', 'regex'] },
          priority: { type: 'integer' },
          category: { type: 'string' },
          is_business: { type: 'boolean' },
          split_type: { type: 'string', enum: ['me', 'partner', 'shared', 'business'] },
          pct_me: { type: 'number', minimum: 0, maximum: 1 },
          pct_partner: { type: 'number', minimum: 0, maximum: 1 },
          effective_from: { type: 'string', description: 'YYYY-MM-DD' },
          effective_to: { type: 'string', description: 'YYYY-MM-DD' },
        },
      },
    },
  },
  async execute(args, ctx) {
    const r = await buildRuleCreatePreview((args as Record<string, unknown>) ?? {}, ctx);
    return 'error' in r ? { ok: false, error: r.error } : { ok: true, data: r };
  },
});

registerTool('propose_rule_update', {
  schema: {
    type: 'function',
    function: {
      name: 'propose_rule_update',
      description: 'Stage updating an existing rule.',
      parameters: {
        type: 'object',
        required: ['rule_id', 'patch'],
        properties: {
          rule_id: { type: 'integer' },
          patch: { type: 'object' },
        },
      },
    },
  },
  async execute(args, ctx) {
    const a = (args as Record<string, unknown>) ?? {};
    if (typeof a.rule_id !== 'number') {
      return { ok: false, error: 'rule_id is required (integer)' };
    }
    const r = await buildRuleUpdatePreview(
      a.rule_id,
      (a.patch as Record<string, unknown>) ?? {},
      ctx
    );
    return 'error' in r ? { ok: false, error: r.error } : { ok: true, data: r };
  },
});

registerTool('propose_rule_delete', {
  schema: {
    type: 'function',
    function: {
      name: 'propose_rule_delete',
      description: 'Stage deleting a rule.',
      parameters: {
        type: 'object',
        required: ['rule_id'],
        properties: { rule_id: { type: 'integer' } },
      },
    },
  },
  async execute(args, ctx) {
    const a = (args as Record<string, unknown>) ?? {};
    if (typeof a.rule_id !== 'number') {
      return { ok: false, error: 'rule_id is required (integer)' };
    }
    const r = await buildRuleDeletePreview(a.rule_id, ctx);
    return 'error' in r ? { ok: false, error: r.error } : { ok: true, data: r };
  },
});
```

- [ ] **Step 3: Tests for mutation tools**

Create `backend/test/chat/toolsMutation.test.ts` with one test per tool verifying it creates a `ChatProposal` row with the right `kind`, `payload`, and `preview` shape, and returns the proposal_id. Also test:
- `propose_transaction_edit` rejects a non-existent transaction.
- `propose_bulk_patch` returns `filter_too_broad` error when matched_count > 500.
- `propose_bulk_patch` returns a sample with ≤10 entries when matched_count ≤ 10.
- Patch field whitelist: `propose_transaction_edit` with a non-whitelisted field key (e.g. `auto_category`) returns an error.

Create `backend/test/chat/proposals.test.ts` with tests for `applyProposal`:
- Apply `transaction_edit` updates the row and marks proposal applied.
- Apply when status is already `applied` returns `{ ok: false, code: 'not_pending' }`.
- Apply when expired returns `{ ok: false, code: 'expired' }` and marks the proposal expired.
- Apply `bulk_patch` with drift > threshold returns `{ ok: false, code: 'count_drifted' }`.
- Apply `bulk_patch` updates all matching rows and writes a `role=tool` message.
- Apply `rule_create` inserts the row with the right defaults + ctx fields.
- Apply `rule_update` patches the row.
- Apply `rule_delete` removes the row.

- [ ] **Step 4: Run tests + commit**

```
yarn workspace cashflow-backend run typecheck
yarn workspace cashflow-backend run test
```

```bash
git add backend/src/ai/chat/proposals.ts backend/src/ai/chat/tools.ts backend/test/chat/toolsMutation.test.ts backend/test/chat/proposals.test.ts
git commit -m "feat(chat): mutation tools + proposal builders + applyProposal"
```

---

### Task 10: Tool-calling loop

**Files:**
- Create: `backend/src/ai/chat/loop.ts`
- Create: `backend/test/chat/loop.test.ts`

`runChatTurn` orchestrates the OpenAI streaming + tool dispatch + persistence. It's an AsyncGenerator yielding stream events the message-POST handler can forward as SSE.

- [ ] **Step 1: Write `loop.ts`**

```ts
import { ChatMessage, ChatThread, type StoredToolCall } from '../../models';
import { sequelize } from '../../db';
import { getChatConfig } from '../../config/chat';
import { buildSystemPrompt, type SystemPromptContext } from './systemPrompt';
import {
  streamChat,
  type ChatMessageForApi,
  type StreamEvent as OAIEvent,
} from './openaiClient';
import { getToolDefinitions, dispatchTool, type ToolContext } from './tools';

export interface RunChatTurnArgs {
  thread: ChatThread;
  userMessage: string;
  userId: number;
  householdId: number | null;
  promptContext: SystemPromptContext;
  signal?: AbortSignal;
  /** Test seam: replace the OpenAI streamer with a stub. */
  streamChatImpl?: typeof streamChat;
}

export type LoopEvent =
  | { type: 'assistant_token'; text: string }
  | { type: 'tool_call_start'; toolName: string; argsPreview: string }
  | { type: 'tool_call_result'; toolName: string; ok: boolean; preview: unknown }
  | { type: 'proposal'; proposalId: number; kind: string; preview: unknown }
  | { type: 'assistant_done'; messageId: number }
  | { type: 'error'; message: string; code?: string };

export async function* runChatTurn(args: RunChatTurnArgs): AsyncGenerator<LoopEvent> {
  const cfg = getChatConfig();
  const stream = args.streamChatImpl ?? streamChat;

  // 1. Persist the user message
  const userMsg = await ChatMessage.create({
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

  // 2. Build conversation history (last N messages, oldest first)
  const history = await loadHistory(args.thread.id, cfg.historyWindowMessages);
  const apiMessages: ChatMessageForApi[] = [
    { role: 'system', content: buildSystemPrompt(args.promptContext) },
    ...history,
  ];

  // 3. Tool-calling loop
  let toolCallCount = 0;
  for (let step = 0; step <= cfg.maxToolCallsPerTurn; step++) {
    const useTools = step < cfg.maxToolCallsPerTurn;
    const assistantText: string[] = [];
    const toolCalls: Map<
      number,
      { id: string; name: string; argsBuf: string }
    > = new Map();
    let finishReason: string | null = null;
    let usagePrompt = 0;
    let usageCompletion = 0;

    const started = Date.now();
    let providerRequestId: string | null = null;

    for await (const ev of stream({
      model: cfg.model,
      messages: apiMessages,
      tools: useTools ? getToolDefinitions() : undefined,
      signal: args.signal,
    })) {
      if (ev.type === 'error') {
        yield { type: 'error', message: ev.message, code: String(ev.status ?? '') };
        return;
      }
      if (ev.type === 'text_delta') {
        assistantText.push(ev.text);
        yield { type: 'assistant_token', text: ev.text };
      } else if (ev.type === 'tool_call_delta') {
        const slot = toolCalls.get(ev.index) ?? { id: '', name: '', argsBuf: '' };
        if (ev.id) slot.id = ev.id;
        if (ev.name) slot.name = ev.name;
        if (ev.argumentsDelta) slot.argsBuf += ev.argumentsDelta;
        toolCalls.set(ev.index, slot);
      } else if (ev.type === 'usage') {
        usagePrompt = ev.promptTokens;
        usageCompletion = ev.completionTokens;
      } else if (ev.type === 'done') {
        finishReason = ev.finishReason;
      }
    }

    const assistantContent = assistantText.join('');
    const storedToolCalls: StoredToolCall[] | null =
      toolCalls.size > 0
        ? [...toolCalls.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, slot]) => ({
              id: slot.id,
              type: 'function',
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
      providerRequestId,
    });

    // Push assistant turn into conversation
    apiMessages.push({
      role: 'assistant',
      content: assistantContent.length > 0 ? assistantContent : null,
      tool_calls: storedToolCalls ?? undefined,
    });

    if (!storedToolCalls || storedToolCalls.length === 0) {
      // No more tool calls; we're done.
      yield { type: 'assistant_done', messageId: assistantMsg.id };
      return;
    }

    // Dispatch each tool call sequentially, persist result, push into history.
    for (const tc of storedToolCalls) {
      toolCallCount++;
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
      const result = await dispatchTool(tc.function.name, tc.function.arguments, ctx);
      yield {
        type: 'tool_call_result',
        toolName: tc.function.name,
        ok: result.ok,
        preview: result.ok ? result.data : result.error,
      };
      // If the tool was a propose_*, surface the proposal card too.
      if (result.ok && tc.function.name.startsWith('propose_')) {
        const d = result.data as { proposal_id?: number; preview?: unknown };
        if (d.proposal_id != null) {
          yield {
            type: 'proposal',
            proposalId: d.proposal_id,
            kind: tc.function.name.replace(/^propose_/, ''),
            preview: d.preview,
          };
        }
      }
      // Persist tool message
      await ChatMessage.create({
        threadId: args.thread.id,
        role: 'tool',
        contentText: JSON.stringify(result.ok ? result.data : { error: result.error }),
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
        content: JSON.stringify(result.ok ? result.data : { error: result.error }),
        tool_call_id: tc.id,
      });
    }

    if (!useTools) {
      // We just ran the final summarize-without-tools call; bail out.
      yield { type: 'assistant_done', messageId: assistantMsg.id };
      return;
    }
  }
  // Should not reach here — the loop always exits via `assistant_done` or error.
}

async function loadHistory(threadId: number, limit: number): Promise<ChatMessageForApi[]> {
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
        tool_calls: (j.toolCalls as StoredToolCall[] | null) ?? undefined,
      };
    }
    return { role: 'user', content: j.contentText ?? '' };
  });
}
```

- [ ] **Step 2: Tests with stubbed streamChat**

Create `backend/test/chat/loop.test.ts`. Use the existing test-DB helper (create a user + thread). Then drive `runChatTurn` with a stub `streamChatImpl` that returns scripted events.

Required tests:
1. Single-shot text reply (stream returns `text_delta` chunks + `done`). Verify: user message persisted, assistant message persisted with full content, `assistant_done` event yielded.
2. Single tool call: stub returns `tool_call_delta` events for `query_transactions`, then `done`; second stream call returns `text_delta` + `done`. Verify: tool dispatched, `tool_call_result` yielded, role=tool message persisted, second assistant message persisted.
3. `propose_*` tool call yields a `proposal` event.
4. Tool-call cap: stub always returns tool calls. Verify loop stops after `maxToolCallsPerTurn` and the last call uses `tools: undefined` (no tools).
5. Error from the stream: stub yields `error`. Verify `error` event is yielded and no assistant message persisted.

- [ ] **Step 3: Run + commit**

```
yarn workspace cashflow-backend run typecheck
yarn workspace cashflow-backend run test
```

```bash
git add backend/src/ai/chat/loop.ts backend/test/chat/loop.test.ts
git commit -m "feat(chat): tool-calling loop with cap, history replay, and persistence"
```

---

### Task 11: Message POST endpoint + SSE transport

**Files:**
- Create: `backend/src/ai/chat/sse.ts` — tiny SSE write helpers
- Modify: `backend/src/routes/chat.ts` — replace the 501 stub with the real handler

- [ ] **Step 1: Write `sse.ts`**

```ts
import type { Response } from 'express';

export function writeSseHeaders(res: Response) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Disable buffering on proxies that respect this hint
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
}

export function writeSseEvent(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
```

- [ ] **Step 2: Replace the message-POST stub in `chat.ts`**

```ts
// (Add these imports at the top of routes/chat.ts)
import { runChatTurn } from '../ai/chat/loop';
import { buildSystemPrompt } from '../ai/chat/systemPrompt';
import { Contact } from '../models';
import { defaultCurrency } from '../config/env';
import { writeSseHeaders, writeSseEvent } from '../ai/chat/sse';

// ... replace the stub:
router.post('/threads/:id/messages', async (req, res, next) => {
  try {
    const { user, household } = currentAuth(req);
    const id = parseId(req.params.id);
    if (id == null) {
      res.status(400).json({ error: 'invalid id' });
      return;
    }
    const thread = await ChatThread.findOne({ where: { id, userId: user.id } });
    if (!thread) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const b = (req.body || {}) as { message?: unknown };
    if (typeof b.message !== 'string' || b.message.trim().length === 0) {
      res.status(400).json({ error: 'message is required (non-empty string)' });
      return;
    }
    const userMessage = b.message.trim().slice(0, 20_000);

    // Per-thread rate limit check (Task 14 will fill in)
    // For now, no-op.

    // Build prompt context
    const contacts = await Contact.findAll({
      where: household.id != null ? { householdId: household.id } : {},
      order: [['id', 'ASC']],
    });
    const promptContext = {
      todayIso: new Date().toISOString().slice(0, 10),
      defaultCurrency,
      contacts: contacts.map((c) => {
        const j = c.toJSON();
        return { id: j.id, name: j.name, currency: j.currency ?? null };
      }),
    };

    writeSseHeaders(res);
    // Wire abort: if client disconnects, abort the upstream OpenAI request.
    const ac = new AbortController();
    req.on('close', () => ac.abort());

    try {
      for await (const ev of runChatTurn({
        thread,
        userMessage,
        userId: user.id,
        householdId: household.id ?? null,
        promptContext,
        signal: ac.signal,
      })) {
        writeSseEvent(res, ev.type, ev);
        if (ev.type === 'assistant_done' || ev.type === 'error') {
          res.end();
          return;
        }
      }
      res.end();
    } catch (e) {
      writeSseEvent(res, 'error', { message: (e as Error).message });
      res.end();
    }
  } catch (e) {
    next(e);
  }
});
```

If `process.env.DEFAULT_CURRENCY` isn't the canonical source, grep for `DEFAULT_CURRENCY` in `backend/src` and use whatever the existing routes use.

- [ ] **Step 3: Manual sanity check (no test yet — integration test is Task 13)**

```
yarn workspace cashflow-backend run typecheck
yarn workspace cashflow-backend run test
```

PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/src/ai/chat/sse.ts backend/src/routes/chat.ts
git commit -m "feat(chat): message POST endpoint streams chat-turn events via SSE"
```

---

### Task 12: Proposal apply/reject endpoints

**Files:**
- Modify: `backend/src/routes/chat.ts`

- [ ] **Step 1: Add the routes**

In `backend/src/routes/chat.ts`, before `export default router`, add:

```ts
import { applyProposal } from '../ai/chat/proposals';

router.post('/proposals/:id/apply', async (req, res, next) => {
  try {
    const { user, household } = currentAuth(req);
    const id = parseId(req.params.id);
    if (id == null) {
      res.status(400).json({ error: 'invalid id' });
      return;
    }
    // Scope: proposal must belong to one of the user's threads.
    const proposal = await ChatProposal.findOne({
      where: { id },
    });
    if (!proposal) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const thread = await ChatThread.findOne({
      where: { id: proposal.threadId, userId: user.id },
    });
    if (!thread) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const result = await applyProposal(id, {
      userId: user.id,
      householdId: household.id ?? null,
      threadId: proposal.threadId,
      messageId: proposal.messageId,
    });
    if (result.ok) {
      res.json({ status: result.status, result: result.result });
      return;
    }
    const status = result.code === 'not_found' ? 404 : 409;
    res.status(status).json({
      error: result.code,
      message: result.message,
      ...(result.extra ?? {}),
    });
  } catch (e) {
    next(e);
  }
});

router.post('/proposals/:id/reject', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const id = parseId(req.params.id);
    if (id == null) {
      res.status(400).json({ error: 'invalid id' });
      return;
    }
    const proposal = await ChatProposal.findOne({ where: { id } });
    if (!proposal) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const thread = await ChatThread.findOne({
      where: { id: proposal.threadId, userId: user.id },
    });
    if (!thread) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    if (proposal.status !== 'pending') {
      res.status(409).json({ error: 'not_pending', status: proposal.status });
      return;
    }
    proposal.set('status', 'rejected');
    await proposal.save();
    // Append role=tool message
    await ChatMessage.create({
      threadId: proposal.threadId,
      role: 'tool',
      contentText: JSON.stringify({ rejected: proposal.kind }),
      toolCalls: null,
      toolCallId: `proposal_${id}`,
      toolName: `reject_${proposal.kind}`,
      model: null,
      promptTokens: null,
      completionTokens: null,
      latencyMs: null,
      providerRequestId: null,
    });
    res.json({ status: 'rejected' });
  } catch (e) {
    next(e);
  }
});
```

- [ ] **Step 2: Typecheck + test + commit**

```
yarn workspace cashflow-backend run typecheck
yarn workspace cashflow-backend run test
```

```bash
git add backend/src/routes/chat.ts
git commit -m "feat(chat): proposal apply/reject endpoints"
```

---

### Task 13: Integration tests for the message loop + proposal lifecycle

**Files:**
- Create: `backend/test/integration/chatMessageLoop.test.ts`
- Create: `backend/test/integration/chatProposalsApplyReject.test.ts`

These exercise the HTTP surface end-to-end with a stubbed OpenAI client. Use the same setup pattern as `chatThreadsCrud.test.ts`.

**Key technique:** the route handler calls `runChatTurn` which calls `streamChat` from `./openaiClient`. To stub: monkey-patch the module export, or pass `streamChatImpl` via a hook. The easiest path is to add a module-level setter in `loop.ts`:

```ts
let streamChatOverride: typeof streamChat | null = null;
export function __setStreamChatForTest(impl: typeof streamChat | null) {
  streamChatOverride = impl;
}
```

Then inside `runChatTurn`, use `streamChatOverride ?? args.streamChatImpl ?? streamChat`. The test calls `__setStreamChatForTest(myStub)` before issuing the HTTP request and resets to `null` in `afterEach`.

If you'd rather avoid the test-only setter, the alternative is dependency-injecting the stream impl via a per-request override on the route (test sends `x-test-stream-impl: <id>` header → handler looks it up in an in-process registry). Pick whichever feels cleaner — both are fine. Document the choice in the test file's header comment.

Required tests in `chatMessageLoop.test.ts`:
1. POST message → SSE response containing `assistant_token` events with the stubbed text, then `assistant_done`. After the stream ends, GET the thread and verify the user + assistant messages are persisted.
2. POST message → SSE includes a `tool_call_start`, `tool_call_result`, and (since the stub returns a propose_bulk_patch call) a `proposal` event. GET the thread → the ChatProposal row exists.
3. POST message with stub that exceeds the tool-call cap — verify final `assistant_done` arrives.
4. POST message when `CHAT_ENABLED` is unset → 404.

Required tests in `chatProposalsApplyReject.test.ts`:
1. Create a thread + user message + stub returns a `propose_bulk_patch`. Then `POST /api/chat/proposals/:id/apply` → 200 with result; transactions in the filter are actually mutated; proposal status is `applied`; a role=tool message is appended.
2. Apply twice → second returns 409 with code `not_pending`.
3. Apply an expired proposal (set `expiresAt` to the past) → 409 `expired`.
4. Apply with count drift > 20% (insert extra rows between preview and apply) → 409 `count_drifted` with `preview_count` + `current_count` in the body.
5. Reject a pending proposal → 200; subsequent apply → 409 `not_pending`.
6. Apply a proposal that belongs to another user's thread → 404.

- [ ] **Step 1: Add the test-only stream override hook to `loop.ts`** (if you chose that path)

- [ ] **Step 2: Write both integration tests**

- [ ] **Step 3: Run integration tests**

```
yarn workspace cashflow-backend run typecheck
yarn workspace cashflow-backend run test:integration
```

All PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/src/ai/chat/loop.ts backend/test/integration/chatMessageLoop.test.ts backend/test/integration/chatProposalsApplyReject.test.ts
git commit -m "test(chat): integration tests for message loop + proposal apply/reject"
```

---

### Task 14: Per-thread rate limit + per-day token budget

**Files:**
- Create: `backend/src/routes/chatRateLimit.ts` — per-thread limiter
- Create: `backend/src/ai/chat/tokenBudget.ts` — daily token tracking
- Modify: `backend/src/routes/chat.ts` — apply limiter + budget check

Per-thread limit: in-memory counter (one process; SQLite is local-first so a single process is the norm). Track `Map<threadId, { count, windowStart }>`. Reset window every hour.

Per-day token budget: query `ChatMessage` for the user's total `promptTokens + completionTokens` since midnight UTC. If over budget, return 429.

- [ ] **Step 1: Write `chatRateLimit.ts`**

```ts
import type { Request, Response, NextFunction } from 'express';
import { getChatConfig } from '../config/chat';

interface Bucket {
  windowStart: number;
  count: number;
}

const buckets = new Map<number, Bucket>();

export function perThreadMessageLimiter(req: Request, res: Response, next: NextFunction): void {
  const threadId = parseInt(req.params.id, 10);
  if (!Number.isFinite(threadId)) {
    next();
    return;
  }
  const cfg = getChatConfig();
  const now = Date.now();
  const hourMs = 3600 * 1000;
  const bucket = buckets.get(threadId);
  if (!bucket || now - bucket.windowStart > hourMs) {
    buckets.set(threadId, { windowStart: now, count: 1 });
    next();
    return;
  }
  bucket.count++;
  if (bucket.count > cfg.perThreadMessagesPerHour) {
    res.setHeader('Retry-After', String(Math.ceil((hourMs - (now - bucket.windowStart)) / 1000)));
    res.status(429).json({
      error: 'per_thread_rate_limit',
      max: cfg.perThreadMessagesPerHour,
      window: 'hour',
    });
    return;
  }
  next();
}

/** Test-only: clear all buckets. */
export function __resetChatRateLimitForTest() {
  buckets.clear();
}
```

- [ ] **Step 2: Write `tokenBudget.ts`**

```ts
import { Op } from 'sequelize';
import { ChatMessage, ChatThread } from '../../models';
import { sequelize } from '../../db';
import { getChatConfig } from '../../config/chat';

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  total: number;
}

/** Sum tokens used by `userId` since UTC midnight today. */
export async function todaysTokenUsage(userId: number): Promise<TokenUsage> {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const row = (await ChatMessage.findOne({
    where: { createdAt: { [Op.gte]: since } },
    include: [
      {
        model: ChatThread,
        as: 'thread',
        where: { userId },
        required: true,
      },
    ],
    attributes: [
      [sequelize.fn('SUM', sequelize.col('prompt_tokens')), 'p'],
      [sequelize.fn('SUM', sequelize.col('completion_tokens')), 'c'],
    ],
    raw: true,
  })) as { p: number | null; c: number | null } | null;
  const p = row?.p ?? 0;
  const c = row?.c ?? 0;
  return { promptTokens: p, completionTokens: c, total: p + c };
}

export async function isUserOverBudget(userId: number): Promise<{
  over: boolean;
  used: number;
  budget: number;
}> {
  const usage = await todaysTokenUsage(userId);
  const budget = getChatConfig().dailyTokenBudget;
  return { over: usage.total >= budget, used: usage.total, budget };
}
```

Note: the `include` requires a `ChatThread.hasMany(ChatMessage)` / `ChatMessage.belongsTo(ChatThread)` association. Add the association in `backend/src/models/index.ts` if not yet present, e.g.:

```ts
ChatThread.hasMany(ChatMessage, { foreignKey: 'threadId', as: 'messages' });
ChatMessage.belongsTo(ChatThread, { foreignKey: 'threadId', as: 'thread' });
```

If you'd rather avoid the association now, use a raw SQL query in `todaysTokenUsage` instead — same end result.

- [ ] **Step 3: Wire into `chat.ts`**

In `routes/chat.ts`, apply the limiter:

```ts
import { perThreadMessageLimiter } from './chatRateLimit';
import { isUserOverBudget } from '../ai/chat/tokenBudget';

router.post('/threads/:id/messages', perThreadMessageLimiter, async (req, res, next) => {
  try {
    // ... existing setup ...
    const budget = await isUserOverBudget(user.id);
    if (budget.over) {
      res.status(429).json({
        error: 'daily_token_budget_exceeded',
        used: budget.used,
        budget: budget.budget,
      });
      return;
    }
    // ... rest of handler
  } catch (e) {
    next(e);
  }
});
```

- [ ] **Step 4: Tests**

Add `backend/test/chat/rateLimit.test.ts` with two tests:
1. Hitting the limiter `N+1` times in a window returns 429 on the last one.
2. `__resetChatRateLimitForTest()` clears state between tests.

Add `backend/test/chat/tokenBudget.test.ts`:
1. With 0 messages, `todaysTokenUsage` returns 0.
2. With messages totaling N tokens today, returns N.
3. Messages from yesterday don't count.
4. `isUserOverBudget` correctly flags when usage >= budget.

- [ ] **Step 5: Run + commit**

```
yarn workspace cashflow-backend run typecheck
yarn workspace cashflow-backend run test
yarn workspace cashflow-backend run test:integration
```

```bash
git add backend/src/routes/chatRateLimit.ts backend/src/ai/chat/tokenBudget.ts backend/src/routes/chat.ts backend/src/models/index.ts backend/test/chat/rateLimit.test.ts backend/test/chat/tokenBudget.test.ts
git commit -m "feat(chat): per-thread rate limit + per-day token budget"
```

---

### Task 15: Surface chat-enabled in `/api/ai/status`

**Files:**
- Modify: `backend/src/routes/ai.ts`

- [ ] **Step 1: Update the status response**

Open `backend/src/routes/ai.ts`. Find the handler for `GET /status` (or wherever the existing `{ openai: bool }` response is built). Modify it to include the chat flag:

```ts
import { getChatConfig } from '../config/chat';

// inside the status handler:
res.json({
  openai: Boolean(getOpenAiConfig()),
  chat: getChatConfig().enabled && Boolean(getOpenAiConfig()),
});
```

(Chat is only "enabled" in the eyes of the UI if both `CHAT_ENABLED=true` AND `OPENAI_API_KEY` is set.)

- [ ] **Step 2: Update shared types**

In `shared/api-types.ts`, find the type for the AI status response (if exists) or add one. Add a `chat: boolean` field.

- [ ] **Step 3: Tests**

If `backend/test/integration/` has an existing AI status test, extend it. Otherwise add a small one verifying:
- Default response: `{ openai: false, chat: false }`.
- With OPENAI_API_KEY set + CHAT_ENABLED unset: `{ openai: true, chat: false }`.
- With both set: `{ openai: true, chat: true }`.

- [ ] **Step 4: Run + commit**

```
yarn workspace cashflow-backend run typecheck
yarn workspace cashflow-backend run test
yarn workspace cashflow-backend run test:integration
```

```bash
git add backend/src/routes/ai.ts shared/api-types.ts backend/test
git commit -m "feat(ai): /api/ai/status reports chat-enabled flag"
```

---

### Task 16: E2E smoke + CI + PR

**Files:** none

- [ ] **Step 1: Full CI run**

```
yarn ci
```

Must PASS. If any step fails, stop and report BLOCKED.

- [ ] **Step 2: Optional E2E smoke against a live dev server**

Skip if fiddly. If you do it:
- `OPENAI_API_KEY=<real-key> CHAT_ENABLED=true yarn dev`
- `curl -c /tmp/cookies -X POST http://localhost:3001/api/auth/demo-login -H 'Content-Type: application/json' -d '{}'`
- `curl -b /tmp/cookies -X POST http://localhost:3001/api/chat/threads -H 'Content-Type: application/json' -d '{"title":"smoke"}'`
- Note the thread id, then:
- `curl -N -b /tmp/cookies -X POST http://localhost:3001/api/chat/threads/<id>/messages -H 'Content-Type: application/json' -d '{"message":"How many transactions do I have last month?"}'`
- Watch the SSE stream — should see assistant tokens, possibly a tool call, then assistant_done.
- Kill the server.

If you do this, report what you saw.

- [ ] **Step 3: Push + open PR**

```
git push -u origin "$(git branch --show-current)"
```

```bash
gh pr create --title "feat(chat): chat backend (AI chat PR2)" --body "$(cat <<'EOF'
PR2 of the AI chat for transactions feature.
Spec: docs/superpowers/specs/2026-05-24-ai-chat-transactions-design.md
Plan: docs/superpowers/plans/2026-05-24-ai-chat-pr2-chat-backend.md

Builds the full chat backend behind a `CHAT_ENABLED` feature flag:
- 3 new tables: chat_threads, chat_messages, chat_proposals
- Per-user thread CRUD
- OpenAI streaming client with SSE parsing
- System prompt builder
- 10 tools: 5 read (query_transactions, get_summary, get_rules,
  get_contacts, get_categories), 5 propose-only mutations
  (propose_transaction_edit, propose_bulk_patch, propose_rule_create,
  propose_rule_update, propose_rule_delete)
- Tool-calling loop with per-turn cap (CHAT_MAX_TOOL_CALLS_PER_TURN=8)
- Proposal apply endpoint with drift detection
  (CHAT_PROPOSAL_DRIFT_PCT=0.2) + cross-tab lock via status column
- Proposal reject endpoint
- SSE transport for streaming chat turns
- Per-thread message rate limit + per-day token budget

Also bundles two PR1 follow-ups: tighten DATE_ONLY_RE to reject
calendar-invalid dates, add PATCH cross-field violation integration
test.

`/api/ai/status` now returns `{ openai, chat }` — UI can detect chat
availability.

No frontend changes. PR3 ships the `/chat` page and flips the flag in
production env.

## Test plan
- [x] yarn ci passes
- [ ] After merge: set CHAT_ENABLED=true + OPENAI_API_KEY locally;
      create a thread; send "how many transactions do I have last
      month?" and see assistant tokens stream back over SSE.
- [ ] After merge: ask the chat to "split groceries 50/50 starting Dec
      2026" and apply the resulting rule_create proposal; verify the
      rule lands and date-scoping works.
EOF
)"
```

Capture the PR URL.

## Report Format

- **Status:** DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
- yarn ci result
- Whether you did the smoke step and what happened
- PR URL
- Commit count on the branch beyond main
- Self-review findings
- Concerns

---

## Self-Review

**Spec coverage:**
- Schema (3 new tables): Task 2. ✓
- Models: Task 3. ✓
- Per-user threads: Task 5 enforces userId scoping in every handler. ✓
- Thread CRUD: Task 5. ✓
- OpenAI streaming client (separate from existing openaiJson.ts): Task 6. ✓
- System prompt: Task 7. ✓
- Read tools (5): Task 8. ✓
- Mutation tools (5): Task 9. ✓ (each creates a ChatProposal, never applies)
- Apply endpoint with drift detection + status transitions + cross-tab lock: Task 12 calls applyProposal from Task 9. Drift check at 20%, configurable via CHAT_PROPOSAL_DRIFT_PCT. ✓
- Reject endpoint: Task 12. ✓
- Tool-calling loop with cap, history window: Task 10. ✓
- SSE transport: Task 11. ✓
- Feature flag CHAT_ENABLED: Task 4 + Task 5. ✓
- CHAT_MODEL env var: Task 4. ✓
- Token budget per-day: Task 14. ✓
- Per-thread rate limit: Task 14. ✓
- AI status flag: Task 15. ✓
- PR1 follow-ups: Task 1. ✓
- Integration test with stubbed OpenAI: Task 13. ✓

**Placeholder scan:** No TBD/TODO/"add appropriate error handling" without code. Each test gets full code or specific "use the same pattern as <named existing test>" with named tests already in the repo. The two places I left judgment to the implementer:
- Task 13's choice between a test-only setter on `loop.ts` versus a per-request header override. Both are spelled out with rationale — implementer picks one and documents.
- Task 14's choice between adding a Sequelize association or using raw SQL for the token-budget query. Both work.
- Task 15's "find the existing /status handler" — I checked the routes/ai.ts file exists; the implementer reads it to find the exact handler.

These are real fork points where either path is fine; not handwaving.

**Type consistency:**
- `ChatMessageRole` is `'user' | 'assistant' | 'tool'` everywhere.
- `ChatProposalKind` matches between model (Task 3), tools (Task 9), apply switch (Task 9 in `applyProposal`), and Task 11/12 routes.
- `StreamEvent` in `openaiClient.ts` (Task 6) consumed by `loop.ts` (Task 10) — exact type imported and switched on.
- `LoopEvent` in `loop.ts` (Task 10) consumed by `chat.ts` (Task 11) — `ev.type` used as the SSE event name.
- `ToolContext` (Task 8) === `ProposalContext` (Task 9) — same shape (userId, householdId, threadId, messageId); they could be unified but kept separate to let the two modules evolve independently. Acceptable.
- `PATCH_FIELD_MAP` in `proposals.ts` (Task 9) maps snake → camel for Transaction model fields; mirrors `PATCH_WHITELIST` in `systemPrompt.ts` (Task 7) which only enumerates snake keys.

**Scope check:** ~16 tasks, single PR. Realistically the implementer will spend more time than PR1 — this PR has SSE + streaming + a real tool-calling loop. If during execution any task feels like it's >2 hours of work, split it. The natural fault lines if needed: Task 9 (mutation tools) could split into transaction-mutation vs rule-mutation; Task 13 (integration tests) could split into message-loop vs proposal-lifecycle.

**Ambiguity check (resolved during self-review):**
- `Op.regexp` would have broken on SQLite (the sqlite3 npm package doesn't register a REGEXP function). Plan resolved to use `Op.like` with `%pattern%` and a small `escapeLikePattern` helper — works on both SQLite and Postgres. Tool description updated to say "case-insensitive substring" instead of "regex." This is a real capability tradeoff: the LLM loses regex alternation (`grocer|loblaws`) inside a single tool call but can call the tool multiple times. Acceptable for v1.
- `DEFAULT_CURRENCY` is exposed in `backend/src/config/env.ts` as the top-level `defaultCurrency` export (resolved once at module load from `e.DEFAULT_CURRENCY || 'CAD'`). Plan updated to import that const instead of reading `process.env.DEFAULT_CURRENCY` directly.

**Real ambiguity left to the implementer (each has clear options spelled out):**
- Task 13: test-only setter on `loop.ts` vs. per-request header override for stubbing the OpenAI stream. Both are described; pick one.
- Task 14: Sequelize association vs. raw SQL for the token-budget query. Both work.
- Task 15: the implementer locates the existing `/api/ai/status` handler (it exists in `backend/src/routes/ai.ts`) and modifies the response shape; the exact line numbers come from reading the current file.
