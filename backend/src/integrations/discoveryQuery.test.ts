import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDiscoveryQuery } from './scanReceipts';

test('buildDiscoveryQuery ORs purchases + subject keywords and excludes senders', () => {
  const q = buildDiscoveryQuery({
    sinceDate: new Date('2026-06-01T00:00:00Z'),
    excludeSenders: ['a@x.com', 'b@y.com'],
  });
  assert.match(q, /category:purchases/);
  assert.match(q, /subject:\(/);
  assert.match(q, /"order confirmation"/);
  assert.match(q, /-from:a@x\.com/);
  assert.match(q, /-from:b@y\.com/);
  assert.match(q, /after:2026\/06\/01/);
});

test('buildDiscoveryQuery omits the PDF clause unless asked', () => {
  const base = buildDiscoveryQuery({ sinceDate: null, excludeSenders: [] });
  assert.doesNotMatch(base, /filename:pdf/);
  const withPdf = buildDiscoveryQuery({ sinceDate: null, excludeSenders: [], includePdfAttachments: true });
  assert.match(withPdf, /has:attachment filename:pdf/);
});

test('buildDiscoveryQuery with no exclusions still emits a valid signal clause', () => {
  const q = buildDiscoveryQuery({ sinceDate: null, excludeSenders: [] });
  assert.match(q, /category:purchases/);
  assert.doesNotMatch(q, /-from:/);
});
