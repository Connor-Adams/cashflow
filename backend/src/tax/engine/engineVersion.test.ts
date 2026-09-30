/**
 * The cache key must change when the ENGINE changes, not only when the facts do.
 *
 * Both return caches (`TaxReturn` via routes/tax.ts, `ScenarioReturn` via
 * computeScenarioReturn) key solely on a hash of the facts. So correcting a
 * bracket in rates-2026.ts, or a slip box in t1.ts, changes nothing a user sees:
 * the facts are identical, the hash matches, the stale row is served. Every
 * number this part of the plan corrects was invisible for exactly that reason.
 *
 * Two mechanisms, deliberately different in kind:
 *   - rate CONSTANTS are folded into the fingerprint, so editing a table
 *     invalidates caches with no human action. Self-maintaining.
 *   - engine LOGIC cannot be hashed, so `ENGINE_VERSION` is bumped by hand.
 *     That is a real failure mode, which is why the rate half is automatic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENGINE_VERSION,
  computeEngineFingerprint,
  engineFingerprint,
  returnCacheKey,
} from './engineVersion';
import { D } from '../util/decimal';
import type { RateTable } from './types';
import { RATES_2026 } from '../data/rates-2026';

const HEX64 = /^[0-9a-f]{64}$/;

test('the fingerprint is stable across calls', () => {
  assert.equal(engineFingerprint(), engineFingerprint());
  assert.match(engineFingerprint(), HEX64);
});

test('a changed rate constant changes the fingerprint with no version bump', () => {
  // The self-maintaining half. Shift one federal bracket threshold by a dollar.
  const shifted: RateTable = {
    ...RATES_2026,
    federalBrackets: RATES_2026.federalBrackets.map((b, i) =>
      i === 0 ? { ...b, upTo: b.upTo?.plus(1) ?? null } : b,
    ),
  };
  const before = computeEngineFingerprint(ENGINE_VERSION, { 2026: RATES_2026 });
  const after = computeEngineFingerprint(ENGINE_VERSION, { 2026: shifted });
  assert.notEqual(before, after);
});

test('a changed scalar rate constant changes the fingerprint', () => {
  // Not just brackets: the AMT exemption and BPA are plain Decimals.
  const shifted: RateTable = { ...RATES_2026, amtExemption: D('1') };
  assert.notEqual(
    computeEngineFingerprint(ENGINE_VERSION, { 2026: RATES_2026 }),
    computeEngineFingerprint(ENGINE_VERSION, { 2026: shifted }),
  );
});

test('a version bump changes the fingerprint with no rate change', () => {
  // The hand-bumped half, for logic corrections like the T5 box-11 fix.
  assert.notEqual(
    computeEngineFingerprint(ENGINE_VERSION, { 2026: RATES_2026 }),
    computeEngineFingerprint(ENGINE_VERSION + 1, { 2026: RATES_2026 }),
  );
});

test('adding a year changes the fingerprint', () => {
  assert.notEqual(
    computeEngineFingerprint(ENGINE_VERSION, { 2026: RATES_2026 }),
    computeEngineFingerprint(ENGINE_VERSION, { 2025: RATES_2026, 2026: RATES_2026 }),
  );
});

test('the cache key stays 64 hex chars — facts_hash is STRING(64)', () => {
  // A visible `${fingerprint}:${digest}` prefix would read better but overflows
  // the column on both models, so the pair is re-hashed instead.
  assert.match(returnCacheKey('a'.repeat(64)), HEX64);
});

test('the same facts under a different engine produce a different key', () => {
  const digest = 'a'.repeat(64);
  assert.notEqual(returnCacheKey(digest, 'fp-one'), returnCacheKey(digest, 'fp-two'));
});

test('different facts under the same engine produce different keys', () => {
  // The fingerprint must not swamp the facts — that would serve one household's
  // numbers to another.
  assert.notEqual(returnCacheKey('a'.repeat(64), 'fp'), returnCacheKey('b'.repeat(64), 'fp'));
});

test('the key is deterministic', () => {
  assert.equal(returnCacheKey('a'.repeat(64), 'fp'), returnCacheKey('a'.repeat(64), 'fp'));
});
