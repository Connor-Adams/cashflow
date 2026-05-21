import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runLinkItemsStage, type LinkItemsCandidateOrder } from '../src/import/enrichment/linkItemsStage';

function order(overrides: Partial<LinkItemsCandidateOrder> & { id: number; total: number; orderDate: string }): LinkItemsCandidateOrder {
  return {
    vendor: 'amazon',
    shipmentDate: null,
    paymentLast4: null,
    items: [],
    ...overrides,
  };
}

test('skips when merchant is not Amazon-like', () => {
  const signals = runLinkItemsStage({
    merchantRaw: 'JOE COFFEE',
    merchantClean: 'JOE COFFEE',
    amount: -25,
    date: '2026-05-10',
    notes: null,
    sourceReference: null,
    threshold: 70,
    candidateOrders: [order({ id: 1, total: 25, orderDate: '2026-05-09' })],
  });
  assert.equal(signals.length, 0);
});

test('attaches high-confidence link when all items share one inferredCategory', () => {
  const signals = runLinkItemsStage({
    merchantRaw: 'AMZN MKTP US*ABC',
    merchantClean: 'AMZN MKTP US',
    amount: -100,
    date: '2026-05-10',
    notes: null,
    sourceReference: null,
    threshold: 70,
    candidateOrders: [
      order({
        id: 42,
        total: 100,
        orderDate: '2026-05-09',
        items: [
          { id: 1, title: 'USB Cable', totalPrice: '30', inferredCategory: 'Office', businessUsePercent: '0' },
          { id: 2, title: 'Monitor Stand', totalPrice: '70', inferredCategory: 'Office', businessUsePercent: '0' },
        ],
      }),
    ],
  });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].source, 'amazon-items');
  assert.equal(signals[0].confidence, 'high');
  assert.equal(signals[0].fields.autoCategory, 'Office');
  assert.equal(signals[0].fields.linkedExternalOrderId, 42);
  assert.equal(signals[0].fields.merchantCanonical, 'Amazon');
});

test('uses medium confidence when items have mixed categories; picks highest-totalPrice winner', () => {
  const signals = runLinkItemsStage({
    merchantRaw: 'AMAZON.CA',
    merchantClean: 'AMAZON.CA',
    amount: -130,
    date: '2026-05-10',
    notes: null,
    sourceReference: null,
    threshold: 70,
    candidateOrders: [
      order({
        id: 7,
        total: 130,
        orderDate: '2026-05-09',
        items: [
          { id: 1, title: 'Notebook', totalPrice: '30', inferredCategory: 'Office', businessUsePercent: '0' },
          { id: 2, title: 'Camera Lens', totalPrice: '100', inferredCategory: 'Photography', businessUsePercent: '0' },
        ],
      }),
    ],
  });
  assert.equal(signals[0].confidence, 'medium');
  assert.equal(signals[0].fields.autoCategory, 'Photography');
});

test('proposes business=true when any item has businessUsePercent > 0', () => {
  const signals = runLinkItemsStage({
    merchantRaw: 'AMZN',
    merchantClean: 'AMZN',
    amount: -50,
    date: '2026-05-10',
    notes: null,
    sourceReference: null,
    threshold: 70,
    candidateOrders: [
      order({
        id: 9,
        total: 50,
        orderDate: '2026-05-09',
        items: [{ id: 1, title: 'Pen', totalPrice: '50', inferredCategory: 'Office', businessUsePercent: '100' }],
      }),
    ],
  });
  assert.equal(signals[0].fields.autoBusiness, true);
});

test('skips when match confidence below threshold', () => {
  const signals = runLinkItemsStage({
    merchantRaw: 'AMAZON',
    merchantClean: 'AMAZON',
    amount: -50,
    date: '2026-05-10',
    notes: null,
    sourceReference: null,
    threshold: 70,
    candidateOrders: [
      order({ id: 1, total: 999, orderDate: '2026-01-01', items: [] }),
    ],
  });
  assert.equal(signals.length, 0);
});

test('appends up to 5 item titles to notes (truncated)', () => {
  const signals = runLinkItemsStage({
    merchantRaw: 'AMAZON',
    merchantClean: 'AMAZON',
    amount: -50,
    date: '2026-05-10',
    notes: null,
    sourceReference: null,
    threshold: 70,
    candidateOrders: [
      order({
        id: 1,
        total: 50,
        orderDate: '2026-05-10',
        items: Array.from({ length: 7 }, (_, i) => ({
          id: i + 1,
          title: `Item ${i + 1}`,
          totalPrice: '7',
          inferredCategory: 'Shopping',
          businessUsePercent: '0',
        })),
      }),
    ],
  });
  const notes = signals[0].fields.notes ?? '';
  assert.ok(notes.includes('Item 1'));
  assert.ok(notes.includes('Item 5'));
  assert.ok(!notes.includes('Item 6'));
  assert.ok(notes.length <= 200);
});
