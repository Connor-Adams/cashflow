import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runNormalizeStage } from './normalizeStage';

test('runNormalizeStage cleans and recognises Amazon', () => {
  const signals = runNormalizeStage({ merchantRaw: 'AMZN MKTP US*A1B2C3' });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].source, 'normalize-seed');
  assert.equal(signals[0].confidence, 'high');
  assert.equal(signals[0].fields.merchantClean, 'AMZN MKTP US');
  assert.equal(signals[0].fields.merchantCanonical, 'Amazon');
});

test('runNormalizeStage cleans without canonical when unknown brand', () => {
  const signals = runNormalizeStage({ merchantRaw: "SQ *JOE'S COFFEE TORONTO ON" });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].source, 'normalize-seed');
  assert.equal(signals[0].fields.merchantClean, "JOE'S COFFEE");
  assert.equal(signals[0].fields.merchantCanonical, null);
});

test('runNormalizeStage falls back to learned brand when seed misses but learnedLookup hits', () => {
  const signals = runNormalizeStage({
    merchantRaw: 'JOE COFFEE',
    learnedLookup: (m) => (m === 'JOE COFFEE' ? "Joe's Coffee" : null),
  });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].source, 'normalize-learned');
  assert.equal(signals[0].confidence, 'medium');
  assert.equal(signals[0].fields.merchantCanonical, "Joe's Coffee");
});

test('runNormalizeStage prefers seed when both match (tie-break)', () => {
  const signals = runNormalizeStage({
    merchantRaw: 'NETFLIX.COM',
    learnedLookup: () => 'Netflix Custom',
  });
  assert.equal(signals[0].source, 'normalize-seed');
  assert.equal(signals[0].fields.merchantCanonical, 'Netflix');
});

test('runNormalizeStage returns merchantClean even for empty input', () => {
  const signals = runNormalizeStage({ merchantRaw: '' });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].fields.merchantClean, '');
  assert.equal(signals[0].fields.merchantCanonical, null);
});
