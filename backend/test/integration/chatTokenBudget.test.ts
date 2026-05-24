/**
 * Integration tests for the chat per-day token budget (PR2 Task 14).
 *
 * Spins up an isolated SQLite DB via migrations, seeds users + chat threads +
 * chat messages with prompt/completion token counts, and exercises
 * `todaysTokenUsage` and `isUserOverBudget` directly. Uses the same per-file
 * SQLite + seed-helper pattern as chatToolsRead.test.ts.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(
  backendRoot,
  'data',
  'test-integration-chat-token-budget.sqlite'
);

let models: typeof import('../../src/models/index.js');
let todaysTokenUsage: typeof import('../../src/ai/chat/tokenBudget.js').todaysTokenUsage;
let isUserOverBudget: typeof import('../../src/ai/chat/tokenBudget.js').isUserOverBudget;

before(async () => {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  process.env.DATABASE_PATH = dbPath;
  process.env.NODE_ENV = 'test';

  execFileSync('yarn', ['run', 'sequelize-cli', 'db:migrate'], {
    cwd: backendRoot,
    env: { ...process.env, DATABASE_PATH: dbPath, NODE_ENV: 'development' },
    stdio: 'pipe',
  });

  models = await import('../../src/models/index.js');
  const mod = await import('../../src/ai/chat/tokenBudget.js');
  todaysTokenUsage = mod.todaysTokenUsage;
  isUserOverBudget = mod.isUserOverBudget;
});

after(async () => {
  delete process.env.CHAT_DAILY_TOKEN_BUDGET;
  await models?.sequelize.close();
  if (fs.existsSync(dbPath)) {
    try {
      fs.unlinkSync(dbPath);
    } catch {
      /* ignore */
    }
  }
});

beforeEach(async () => {
  delete process.env.CHAT_DAILY_TOKEN_BUDGET;
  // Order matters for FKs: messages → threads → users.
  await models.ChatMessage.destroy({ where: {} });
  await models.ChatThread.destroy({ where: {} });
  await models.User.destroy({ where: {} });
});

async function seedUser(label: string): Promise<number> {
  const user = await models.User.create({
    email: `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    displayName: label,
    passwordHash: 'x',
    passwordSalt: 'x',
    passwordParams: 'x',
  } as never);
  return user.id;
}

async function seedThread(userId: number): Promise<number> {
  const t = await models.ChatThread.create({
    userId,
    title: null,
    archivedAt: null,
    lastMessageAt: null,
  });
  return t.id;
}

async function seedMessage(
  threadId: number,
  promptTokens: number | null,
  completionTokens: number | null
): Promise<number> {
  const m = await models.ChatMessage.create({
    threadId,
    role: 'assistant',
    contentText: null,
    toolCalls: null,
    toolCallId: null,
    toolName: null,
    model: 'test-model',
    promptTokens,
    completionTokens,
    latencyMs: null,
    providerRequestId: null,
  });
  return m.id;
}

test('todaysTokenUsage: new user with no messages returns zero usage', async () => {
  const userId = await seedUser('budget-empty');
  const usage = await todaysTokenUsage(userId);
  assert.deepEqual(usage, { promptTokens: 0, completionTokens: 0, total: 0 });
});

test('todaysTokenUsage: sums prompt + completion tokens across messages', async () => {
  const userId = await seedUser('budget-sum');
  const threadId = await seedThread(userId);
  await seedMessage(threadId, 100, 50);
  await seedMessage(threadId, 200, 75);

  const usage = await todaysTokenUsage(userId);
  assert.equal(usage.promptTokens, 300);
  assert.equal(usage.completionTokens, 125);
  assert.equal(usage.total, 425);
});

test("todaysTokenUsage: yesterday's tokens are excluded", async () => {
  const userId = await seedUser('budget-yesterday');
  const threadId = await seedThread(userId);
  const messageId = await seedMessage(threadId, 999, 0);

  // Push the row's created_at back to "yesterday" (well before today's UTC
  // midnight). We update both timestamps to keep the row consistent.
  const yesterday = new Date();
  yesterday.setUTCHours(0, 0, 0, 0);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  // 12:00 UTC yesterday — comfortably before today's midnight cutoff.
  yesterday.setUTCHours(12, 0, 0, 0);
  await models.ChatMessage.update(
    { createdAt: yesterday, updatedAt: yesterday },
    { where: { id: messageId }, silent: true }
  );

  const usage = await todaysTokenUsage(userId);
  assert.equal(usage.total, 0, "yesterday's tokens must not count");
});

test('isUserOverBudget: flags when usage >= budget', async () => {
  process.env.CHAT_DAILY_TOKEN_BUDGET = '200';
  const userId = await seedUser('budget-over');
  const threadId = await seedThread(userId);
  await seedMessage(threadId, 150, 100); // total 250 >= 200

  const result = await isUserOverBudget(userId);
  assert.equal(result.over, true);
  assert.equal(result.used, 250);
  assert.equal(result.budget, 200);
});

test("todaysTokenUsage: other user's messages do not count", async () => {
  const user1 = await seedUser('budget-u1');
  const user2 = await seedUser('budget-u2');
  const thread1 = await seedThread(user1);
  await seedThread(user2); // user2 has a thread but no messages
  await seedMessage(thread1, 300, 200); // 500 for user1

  const u2 = await todaysTokenUsage(user2);
  assert.equal(u2.total, 0, "user2 must not see user1's tokens");

  const u1 = await todaysTokenUsage(user1);
  assert.equal(u1.total, 500, 'sanity: user1 sees their own tokens');
});
