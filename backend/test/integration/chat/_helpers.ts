/**
 * Shared test helpers for the chat integration tests.
 *
 * Each test file calls `setupChatTestDb()` in `before()` with a legacy
 * sqlite-style basename ("test-integration-X.sqlite"); the helper strips the
 * prefix/suffix to derive a short test name, then provisions a per-file
 * Postgres database via setupPgTestDb. The `dbPath` returned to callers is
 * the Postgres database name — name kept for callsite compatibility.
 *
 * Why not in test/integration/ root: the `*.test.ts` glob in package.json's
 * `test:integration` script would treat any file there as a test. The chat/
 * subdir keeps shared helpers out of that glob.
 */
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from '../_setup/pgTestDb.js';

const activeDbs = new Map<string, PgTestDb>();

export interface ChatTestModels {
  models: typeof import('../../../src/models/index.js');
}

export async function setupChatTestDb(dbBasename: string): Promise<{
  models: typeof import('../../../src/models/index.js');
  dbPath: string;
}> {
  const name = dbBasename.replace(/^test-integration-/, '').replace(/\.sqlite$/, '');
  const pg = await setupPgTestDb(name);
  activeDbs.set(pg.databaseName, pg);
  const models = await import('../../../src/models/index.js');
  return { models, dbPath: pg.databaseName };
}

export async function teardownChatTestDb(
  _models: typeof import('../../../src/models/index.js') | undefined,
  dbPath: string,
): Promise<void> {
  const pg = activeDbs.get(dbPath);
  if (pg) {
    await teardownPgTestDb(pg);
    activeDbs.delete(dbPath);
  }
}

export async function wipeChatTestTables(
  models: typeof import('../../../src/models/index.js')
): Promise<void> {
  // Order matters for FKs: messages reference threads, proposals reference both.
  await models.ChatProposal.destroy({ where: {} });
  await models.ChatMessage.destroy({ where: {} });
  await models.ChatThread.destroy({ where: {} });
  await models.Transaction.destroy({ where: {} });
  await models.Rule.destroy({ where: {} });
  await models.Contact.destroy({ where: {} });
  await models.Account.destroy({ where: {} });
  await models.HouseholdMember.destroy({ where: {} });
  await models.Household.destroy({ where: {} });
  await models.User.destroy({ where: {} });
}

export async function seedHousehold(
  models: typeof import('../../../src/models/index.js')
): Promise<{ householdId: number; accountId: number }> {
  const household = await models.Household.create({
    name: 'Chat Test House',
  } as never);
  const account = await models.Account.create({
    name: 'Checking',
    owner: 'me',
    householdId: household.id,
  } as never);
  return { householdId: household.id, accountId: account.id };
}

export async function seedUser(
  models: typeof import('../../../src/models/index.js'),
  label: string
): Promise<number> {
  const user = await models.User.create({
    email: `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
    displayName: label,
    passwordHash: 'x',
    passwordSalt: 'x',
    passwordParams: 'x',
  } as never);
  return user.id;
}

export async function seedTxn(
  models: typeof import('../../../src/models/index.js'),
  accountId: number,
  householdId: number,
  overrides: Record<string, unknown> = {}
): Promise<number> {
  const row = await models.Transaction.create({
    accountId,
    householdId,
    visibility: 'shared',
    importBatch: 'seed',
    date: '2026-05-10',
    merchantRaw: 'COFFEE SHOP',
    merchantClean: 'COFFEE SHOP',
    amount: '5.00',
    currency: 'CAD',
    sourceRowFingerprint: `fp-${Math.random()}`,
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

export async function seedRule(
  models: typeof import('../../../src/models/index.js'),
  householdId: number,
  overrides: Record<string, unknown> = {}
): Promise<number> {
  const rule = await models.Rule.create({
    merchantPattern: 'X',
    householdId,
    matchKind: 'substring',
    priority: 1,
    category: 'Misc',
    isBusiness: false,
    splitType: 'me',
    pctMe: null,
    pctPartner: null,
    effectiveFrom: null,
    effectiveTo: null,
    ...overrides,
  } as never);
  return rule.id;
}

/**
 * Create a thread + user message pair that mutation tools can attach
 * proposals to. Returns the IDs the proposal builder needs as ctx.
 */
export async function seedThreadWithMessage(
  models: typeof import('../../../src/models/index.js'),
  userId: number
): Promise<{ threadId: number; messageId: number }> {
  const thread = await models.ChatThread.create({
    userId,
    title: 'Test thread',
    archivedAt: null,
    lastMessageAt: null,
  } as never);
  const message = await models.ChatMessage.create({
    threadId: thread.id,
    role: 'user',
    contentText: 'do the thing',
    toolCalls: null,
    toolCallId: null,
    toolName: null,
    model: null,
    promptTokens: null,
    completionTokens: null,
    latencyMs: null,
    providerRequestId: null,
  } as never);
  return { threadId: thread.id, messageId: message.id };
}
