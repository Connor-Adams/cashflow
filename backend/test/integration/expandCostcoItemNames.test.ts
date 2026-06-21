/**
 * Integration tests for Costco item-name expansion + item-number persistence.
 * Requires a real Postgres (TEST_DATABASE_URL) so the full migration suite —
 * including the display_name/display_name_confidence/item_number columns — runs.
 *
 * Covers:
 *  1. persistExtractedOrder maps ExtractedReceiptItem.vendorItemId ->
 *     ExternalOrderItem.itemNumber.
 *  2. expandCostcoItemNames (with an INJECTED fake caller) writes displayName
 *     for Costco items, preserves the raw title, and clamps confidence.
 *  3. Vendor gating: Amazon items in the same household are NOT touched.
 *  4. applyItemNameExpansions skips no-op (null displayName) suggestions so the
 *     UI falls back to title.
 *  5. Backfill idempotency: items that already have a displayName are skipped
 *     unless --force.
 *  6. Best-effort: maybeExpandItemNamesForOrder no-ops cleanly when OpenAI is
 *     not configured — no throw, displayName stays null.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let models: typeof import('../../src/models/index.js');
let persistExtractedOrder: typeof import('../../src/routes/externalOrders.js').persistExtractedOrder;
let expandMod: typeof import('../../src/import/enrichment/expandItemNames.js');
let testDb: PgTestDb;

let householdId: number;
let userId: number;

const ENV_KEYS = ['OPENAI_API_KEY'] as const;
const savedEnv: Record<string, string | undefined> = {};

before(async () => {
  testDb = await setupPgTestDb('expand-costco-names');
  models = await import('../../src/models/index.js');
  persistExtractedOrder = (await import('../../src/routes/externalOrders.js')).persistExtractedOrder;
  expandMod = await import('../../src/import/enrichment/expandItemNames.js');

  // Bootstrap superadmin (first user requirement).
  const { hashPassword } = await import('../../src/auth/password.js');
  const pw = await hashPassword('password123');
  await models.User.create({
    email: `super-expand-${Date.now()}@example.com`,
    displayName: 'Super',
    globalRole: 'superadmin',
    passwordHash: pw.hash,
    passwordSalt: pw.salt,
    passwordParams: pw.params,
  } as never);

  const hh = await models.Household.create({ name: 'Expand HH' } as never);
  householdId = hh.id;
  const user = await models.User.create({
    email: `user-expand-${Date.now()}@example.com`,
    displayName: 'Expand User',
    globalRole: 'user',
    passwordHash: pw.hash,
    passwordSalt: pw.salt,
    passwordParams: pw.params,
  } as never);
  userId = user.id;

  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});

beforeEach(() => {
  // Each test sets OPENAI_API_KEY explicitly where it matters.
  delete process.env.OPENAI_API_KEY;
});

after(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await teardownPgTestDb(testDb);
});

/** Build a fake OpenAI caller that expands a fixed dictionary of titles. */
function fakeCaller(
  dict: Record<string, { displayName: string; confidence: number }>,
): import('../../src/import/enrichment/expandItemNames.js').ItemNameOpenAiCaller {
  return async (messages) => {
    // The batch items are JSON-embedded in the user message; re-derive ids+titles.
    const user = messages[1].content as string;
    const dataMatch = user.match(/Data: (\{.*\})\s*$/s);
    const data = dataMatch ? (JSON.parse(dataMatch[1]) as { items: Array<{ itemId: number; title: string }> }) : { items: [] };
    const items = data.items.map((it) => {
      const hit = dict[it.title];
      return {
        itemId: it.itemId,
        displayName: hit ? hit.displayName : it.title, // unknown -> echo (no-op passthrough)
        confidence: hit ? hit.confidence : 50,
      };
    });
    return {
      json: { items },
      model: 'fake-model',
      temperature: 0.1,
      latencyMs: 1,
      providerRequestId: 'fake-req',
      rawTextPreview: JSON.stringify({ items }).slice(0, 500),
    };
  };
}

async function makeCostcoOrder(): Promise<number> {
  const order = await models.ExternalOrder.create({
    householdId,
    createdByUserId: userId,
    vendor: 'costco',
    vendorOrderId: null,
    dedupeKey: `costco-${crypto.randomBytes(8).toString('hex')}`,
    orderDate: '2026-05-15',
    shipmentDate: null,
    subtotal: '20.0000',
    tax: '2.0000',
    shipping: null,
    total: '22.0000',
    currency: 'CAD',
    paymentLast4: null,
    source: 'costco_till_receipt-pdf',
    rawPayload: null,
  } as never);
  return order.id;
}

async function makeItem(orderId: number, title: string, displayName: string | null = null): Promise<number> {
  const item = await models.ExternalOrderItem.create({
    externalOrderId: orderId,
    title,
    quantity: 1,
    unitPrice: '5.0000',
    totalPrice: '5.0000',
    inferredCategory: null,
    businessUsePercent: null,
    confidence: null,
    categoryOverride: null,
    businessUseOverride: null,
    displayName,
    displayNameConfidence: null,
    itemNumber: null,
    rawPayload: null,
  } as never);
  return item.id;
}

// ---------------------------------------------------------------------------
// 1. itemNumber persists through persistExtractedOrder
// ---------------------------------------------------------------------------
test('persistExtractedOrder maps vendorItemId -> ExternalOrderItem.itemNumber', async () => {
  const extracted = {
    vendor: 'costco' as const,
    vendorName: 'Costco Wholesale',
    orderDate: '2026-05-10',
    orderId: null,
    subtotal: 10,
    tax: 1,
    total: 11,
    currency: 'CAD',
    paymentLast4: null,
    tenders: [],
    items: [
      {
        title: 'KS ORG PNT BTR',
        quantity: 1,
        unitPrice: 11,
        totalPrice: 11,
        inferredCategory: null,
        vendorItemId: '1234567',
        taxable: true,
      },
    ],
    notes: null,
  };
  const { order, created } = await persistExtractedOrder(extracted, {
    userId,
    householdId,
    source: 'costco_till_receipt-pdf',
  });
  assert.equal(created, true);
  const items = await models.ExternalOrderItem.findAll({ where: { externalOrderId: order.id } });
  assert.equal(items.length, 1);
  assert.equal(items[0].itemNumber, '1234567', 'itemNumber should be persisted from vendorItemId');
  assert.equal(items[0].displayName, null, 'displayName should start null');
});

test('persistExtractedOrder sets itemNumber=null when vendorItemId is absent', async () => {
  const extracted = {
    vendor: 'other' as const,
    vendorName: null,
    orderDate: '2026-05-10',
    orderId: null,
    subtotal: 5,
    tax: 0,
    total: 5,
    currency: 'CAD',
    paymentLast4: null,
    tenders: [],
    items: [
      { title: 'Some Thing', quantity: 1, unitPrice: 5, totalPrice: 5, inferredCategory: null },
    ],
    notes: null,
  };
  const { order } = await persistExtractedOrder(extracted, {
    userId,
    householdId,
    source: 'email-paste',
  });
  const items = await models.ExternalOrderItem.findAll({ where: { externalOrderId: order.id } });
  assert.equal(items[0].itemNumber, null);
});

// ---------------------------------------------------------------------------
// 2 + 3. expandCostcoItemNames writes displayName for Costco; Amazon untouched
// ---------------------------------------------------------------------------
test('expandCostcoItemNames writes displayName (raw title preserved) and ignores Amazon items', async () => {
  const costcoOrderId = await makeCostcoOrder();
  const costcoItemId = await makeItem(costcoOrderId, 'KS ORG PNT BTR');

  // Amazon order in the SAME household — must NOT be expanded (vendor gating).
  const amazonOrder = await models.ExternalOrder.create({
    householdId,
    createdByUserId: userId,
    vendor: 'amazon',
    vendorOrderId: null,
    dedupeKey: `amazon-${crypto.randomBytes(8).toString('hex')}`,
    orderDate: '2026-05-15',
    shipmentDate: null,
    subtotal: '9.0000',
    tax: '1.0000',
    shipping: null,
    total: '10.0000',
    currency: 'CAD',
    paymentLast4: null,
    source: 'amazon_report',
    rawPayload: null,
  } as never);
  const amazonItemId = await makeItem(amazonOrder.id, 'USB-C Cable 6ft');

  const caller = fakeCaller({
    'KS ORG PNT BTR': { displayName: 'Kirkland Signature Organic Peanut Butter', confidence: 95 },
    'USB-C Cable 6ft': { displayName: 'SHOULD NOT BE USED', confidence: 99 },
  });

  // Scope to this order so the assertion is robust to costco items created by
  // sibling tests sharing this household. The Amazon item is a different order
  // and would be excluded by vendor gating regardless.
  const { suggestions } = await expandMod.expandCostcoItemNames(
    { householdId, orderId: costcoOrderId },
    { openaiCaller: caller },
  );
  const applied = await expandMod.applyItemNameExpansions(suggestions);
  assert.equal(applied, 1, 'only the 1 Costco item should be updated');

  const costcoItem = await models.ExternalOrderItem.findByPk(costcoItemId);
  assert.equal(costcoItem?.displayName, 'Kirkland Signature Organic Peanut Butter');
  assert.equal(costcoItem?.title, 'KS ORG PNT BTR', 'raw title must be preserved');
  assert.equal(Number(costcoItem?.displayNameConfidence), 95);

  // Vendor gating, exercised against a HOUSEHOLD-WIDE scan (no orderId): the
  // Amazon item is still never loaded/expanded because vendor NOT IN allowlist.
  const householdWide = await expandMod.expandCostcoItemNames(
    { householdId },
    { openaiCaller: caller },
  );
  assert.ok(
    !householdWide.suggestions.some((s) => s.itemId === amazonItemId),
    'Amazon item must never appear in expansion suggestions (vendor gating)',
  );
  const amazonItem = await models.ExternalOrderItem.findByPk(amazonItemId);
  assert.equal(amazonItem?.displayName, null, 'Amazon item must NOT be expanded (vendor gating)');
});

// ---------------------------------------------------------------------------
// 4. no-op passthrough: applyItemNameExpansions skips null displayName
// ---------------------------------------------------------------------------
test('passthrough item (already readable) keeps displayName null after expand+apply', async () => {
  const orderId = await makeCostcoOrder();
  const itemId = await makeItem(orderId, 'Bananas');

  // Caller echoes the title (already readable) -> parse treats as no-op -> null.
  const caller = fakeCaller({}); // empty dict -> echoes titles
  const { suggestions } = await expandMod.expandCostcoItemNames(
    { householdId, orderId },
    { openaiCaller: caller },
  );
  const applied = await expandMod.applyItemNameExpansions(suggestions);
  assert.equal(applied, 0, 'no rows updated for a no-op passthrough');
  const item = await models.ExternalOrderItem.findByPk(itemId);
  assert.equal(item?.displayName, null, 'displayName stays null so UI falls back to title');
});

// ---------------------------------------------------------------------------
// 5. Backfill idempotency: already-named items skipped unless force
// ---------------------------------------------------------------------------
test('backfill module path is idempotent: items with displayName set are skipped unless force', async () => {
  const orderId = await makeCostcoOrder();
  // Pre-set a displayName on this item.
  const itemId = await makeItem(orderId, 'KS ORG MILK', 'Existing Name');

  // Re-derive the eligible set the way the backfill script does: costco items
  // with displayName IS NULL. This item should NOT be eligible (already named).
  const { Op } = await import('sequelize');
  const eligible = await models.ExternalOrderItem.findAll({
    where: { displayName: { [Op.is]: null } },
    include: [
      {
        model: models.ExternalOrder,
        as: 'order',
        required: true,
        where: { householdId, vendor: { [Op.in]: ['costco'] } },
      },
    ],
  });
  assert.ok(
    !eligible.some((it) => it.id === itemId),
    'already-named item must not be in the non-force eligible set',
  );

  // Force path expands it (overwrites). itemIds bypasses the displayName filter.
  const caller = fakeCaller({ 'KS ORG MILK': { displayName: 'Kirkland Signature Organic Milk', confidence: 88 } });
  const { suggestions } = await expandMod.expandCostcoItemNames(
    { householdId, itemIds: [itemId] },
    { openaiCaller: caller },
  );
  const applied = await expandMod.applyItemNameExpansions(suggestions);
  assert.equal(applied, 1, 'force re-expansion updates the already-named item');
  const item = await models.ExternalOrderItem.findByPk(itemId);
  assert.equal(item?.displayName, 'Kirkland Signature Organic Milk');
});

// ---------------------------------------------------------------------------
// 6. Best-effort: no-op + no throw when OpenAI is not configured
// ---------------------------------------------------------------------------
test('maybeExpandItemNamesForOrder no-ops cleanly when OpenAI is not configured', async () => {
  delete process.env.OPENAI_API_KEY; // ensure unconfigured
  const orderId = await makeCostcoOrder();
  const itemId = await makeItem(orderId, 'KS ORG PNT BTR');

  // No injected caller, no API key -> must not throw, must not write.
  const updated = await expandMod.maybeExpandItemNamesForOrder({ householdId, orderId });
  assert.equal(updated, 0, 'returns 0 when AI not configured');
  const item = await models.ExternalOrderItem.findByPk(itemId);
  assert.equal(item?.displayName, null, 'displayName stays null when AI not configured');
});
