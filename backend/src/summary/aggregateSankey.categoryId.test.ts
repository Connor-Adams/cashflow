import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateSankey } from './aggregateSankey';

test('sankey category buckets carry finalCategoryId', () => {
  const rows = [
    {
      id: 1,
      date: '2026-01-15',
      currency: 'CAD',
      finalCategory: 'Travel',
      finalCategoryId: 21,
      finalBusiness: false,
      merchantRaw: null,
      merchantClean: null,
      amount: -80,
      txnType: null,
      accountType: 'chequing',
    },
  ];
  const res = aggregateSankey(rows as never, 'CAD');
  // Category nodes are emitted in res.nodes (kind === 'category')
  // The Travel node should carry categoryId === 21
  const node = res.nodes.find((n) => n.name === 'Travel');
  assert.ok(node, 'Travel node present');
  assert.equal((node as { categoryId?: number | null }).categoryId, 21);
});

test('sankey category bucket keeps first non-null categoryId when multiple rows same label', () => {
  const rows = [
    {
      id: 1,
      date: '2026-01-15',
      currency: 'CAD',
      finalCategory: 'Travel',
      finalCategoryId: 21,
      finalBusiness: false,
      merchantRaw: null,
      merchantClean: null,
      amount: -50,
      txnType: null,
      accountType: 'chequing',
    },
    {
      id: 2,
      date: '2026-01-16',
      currency: 'CAD',
      finalCategory: 'Travel',
      finalCategoryId: null,
      finalBusiness: false,
      merchantRaw: null,
      merchantClean: null,
      amount: -30,
      txnType: null,
      accountType: 'chequing',
    },
    {
      id: 3,
      date: '2026-01-17',
      currency: 'CAD',
      finalCategory: 'Travel',
      finalCategoryId: 99,
      finalBusiness: false,
      merchantRaw: null,
      merchantClean: null,
      amount: -20,
      txnType: null,
      accountType: 'chequing',
    },
  ];
  const res = aggregateSankey(rows as never, 'CAD');
  const node = res.nodes.find((n) => n.name === 'Travel');
  assert.ok(node, 'Travel node present');
  // First non-null seen is 21; 99 should not override it
  assert.equal((node as { categoryId?: number | null }).categoryId, 21);
});

test('sankey credit path (refund) category bucket carries finalCategoryId', () => {
  const rows = [
    // A spend row to establish the bucket with a positive netSpend
    {
      id: 1,
      date: '2026-01-15',
      currency: 'CAD',
      finalCategory: 'Dining',
      finalCategoryId: 7,
      finalBusiness: false,
      merchantRaw: null,
      merchantClean: null,
      amount: -100,
      txnType: null,
      accountType: 'chequing',
    },
    // A credit (refund) row for the same category — exercises the credit path
    {
      id: 2,
      date: '2026-01-16',
      currency: 'CAD',
      finalCategory: 'Dining',
      finalCategoryId: 7,
      finalBusiness: false,
      merchantRaw: null,
      merchantClean: null,
      amount: 20,
      txnType: 'refund',
      accountType: 'chequing',
    },
  ];
  const res = aggregateSankey(rows as never, 'CAD');
  const node = res.nodes.find((n) => n.name === 'Dining');
  assert.ok(node, 'Dining node present');
  assert.equal((node as { categoryId?: number | null }).categoryId, 7);
});
